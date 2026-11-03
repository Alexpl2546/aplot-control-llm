//! API-key credentials are independent of ChatGPT OAuth and never leave native code.
use crate::connection_profiles::{self, Profile};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize)]
struct Credential {
    identity: String,
    key: String,
}

pub(crate) fn is_api(profile: &Profile) -> bool {
    profile.auth_mode.as_deref() == Some("apiKey")
}

fn path(app: &AppHandle, profile: &Profile) -> Result<std::path::PathBuf, String> {
    Ok(connection_profiles::home(app, profile)?.join("api-key.dpapi"))
}

fn load(app: &AppHandle, profile: &Profile) -> Result<Option<Credential>, String> {
    if !is_api(profile) {
        return Err("auth-mode".into());
    }
    let path = path(app, profile)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|_| "storage")?;
    let text = crate::domain::secrets::unseal_connection_secret(&bytes)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|_| "credentials".into())
}

pub(crate) fn identity(app: &AppHandle, profile: &Profile) -> Result<Option<String>, String> {
    Ok(load(app, profile)?
        .map(|c| connection_profiles::key(profile, &format!("api-key:{}", c.identity))))
}

pub(crate) fn token(app: &AppHandle, profile: &Profile, expected: &str) -> Result<String, String> {
    let credential = load(app, profile)?.ok_or("auth")?;
    if connection_profiles::key(profile, &format!("api-key:{}", credential.identity)) != expected {
        return Err("changed".into());
    }
    Ok(credential.key)
}

pub(crate) fn clear(app: &AppHandle, profile: &Profile) -> Result<(), String> {
    let path = path(app, profile)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|_| "storage")?;
    }
    connection_profiles::remember(app, &profile.id, None, None)
}

fn validate_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    if !(16..=1024).contains(&key.len())
        || !key.is_ascii()
        || key
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err("api-key-invalid".into());
    }
    Ok(key)
}

#[tauri::command]
pub async fn openai_api_key_set(
    app: AppHandle,
    profile_id: String,
    api_key: String,
) -> Result<(), String> {
    let key = validate_key(&api_key)?;
    let operations = app.state::<connection_profiles::ProfileOperations>();
    let _operation = operations.0.lock().await;
    let profile = connection_profiles::profile(&app, "openai", Some(&profile_id))?
        .filter(|p| p.enabled && is_api(p))
        .ok_or("profile")?;
    // Replacing a key changes connection identity. Old history cannot silently use the new account.
    let credential = Credential {
        identity: uuid::Uuid::new_v4().to_string(),
        key: key.to_owned(),
    };
    let text = serde_json::to_string(&credential).map_err(|_| "credentials")?;
    let bytes = crate::domain::secrets::seal_recovery_secret(&text)?;
    crate::openai_connection::close_profile(&app, &profile, false).await?;
    connection_profiles::atomic_write(&path(&app, &profile)?, &bytes)?;
    connection_profiles::remember(&app, &profile.id, identity(&app, &profile)?, None)?;
    let _ = app.emit("connections://changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_input_is_bounded_and_cannot_inject_headers() {
        assert_eq!(
            validate_key("  sk-valid-example-12345  ").unwrap(),
            "sk-valid-example-12345"
        );
        for key in [
            "short",
            "sk-123456789012345\r\nX-Test: 1",
            "sk-123456789012345 6789",
        ] {
            assert!(validate_key(key).is_err());
        }
        assert!(validate_key(&"x".repeat(1025)).is_err());
    }
}
