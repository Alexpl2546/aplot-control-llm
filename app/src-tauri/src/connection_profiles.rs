//! Named, isolated subscription environments. This registry contains no credentials.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

static FILE_LOCK: Mutex<()> = Mutex::new(());
#[derive(Default)]
pub struct ProfileOperations(pub tokio::sync::Mutex<()>);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub enabled: bool,
    pub connection_id: Option<String>,
    pub email: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub profiles: Vec<Profile>,
    pub defaults: HashMap<String, String>,
}
fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::db::connection_data_dir(app)?.join("connection-profiles"))
}
fn read(app: &AppHandle) -> Result<Registry, String> {
    let path = directory(app)?.join("profiles.json");
    if path.exists() {
        return serde_json::from_slice(&std::fs::read(path).map_err(|_| "storage")?)
            .map_err(|_| "profiles-storage".into());
    }
    let mut r = Registry::default();
    for (provider, id, name) in [
        ("openai", "legacy-openai", "ChatGPT"),
        ("claude", "legacy-claude", "Claude"),
    ] {
        r.profiles.push(Profile {
            id: id.into(),
            provider: provider.into(),
            name: name.into(),
            enabled: true,
            connection_id: None,
            email: None,
        });
        r.defaults.insert(provider.into(), id.into());
    }
    write(app, &r)?;
    Ok(r)
}
fn write(app: &AppHandle, r: &Registry) -> Result<(), String> {
    atomic_write(
        &directory(app)?.join("profiles.json"),
        &serde_json::to_vec_pretty(r).map_err(|_| "storage")?,
    )
}
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("storage")?;
    std::fs::create_dir_all(dir).map_err(|_| "storage")?;
    let temp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes).map_err(|_| "storage")?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(a: *const u16, b: *const u16, flags: u32) -> i32;
        }
        let a: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0x1 | 0x8) } == 0 {
            let _ = std::fs::remove_file(temp);
            return Err("storage".into());
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(temp, path).map_err(|_| "storage")?;
    Ok(())
}
pub(crate) fn profile(
    app: &AppHandle,
    provider: &str,
    id: Option<&str>,
) -> Result<Option<Profile>, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "storage")?;
    let r = read(app)?;
    let Some(id) = id.or_else(|| r.defaults.get(provider).map(String::as_str)) else {
        return Ok(None);
    };
    Ok(r.profiles
        .into_iter()
        .find(|p| p.id == id && p.provider == provider))
}
pub(crate) fn for_connection(
    app: &AppHandle,
    provider: &str,
    connection: Option<&str>,
) -> Result<Profile, String> {
    if let Some(id) = connection {
        let _guard = FILE_LOCK.lock().map_err(|_| "storage")?;
        return read(app)?
            .profiles
            .into_iter()
            .find(|p| p.provider == provider && p.enabled && p.connection_id.as_deref() == Some(id))
            .ok_or("profile-disconnected".into());
    }
    profile(app, provider, None)?
        .filter(|p| p.enabled)
        .ok_or("profile-disconnected".into())
}
pub(crate) fn home(app: &AppHandle, p: &Profile) -> Result<PathBuf, String> {
    let root = crate::db::connection_data_dir(app)?;
    match (p.provider.as_str(), p.id.as_str()) {
        ("openai", "legacy-openai") => Ok(root.join("openai")),
        ("claude", "legacy-claude") => Ok(root.join("claude-home")),
        _ if uuid::Uuid::parse_str(&p.id).is_ok() => Ok(directory(app)?.join("data").join(&p.id)),
        _ => Err("profile".into()),
    }
}
pub(crate) fn remember(
    app: &AppHandle,
    id: &str,
    connection: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "storage")?;
    let mut r = read(app)?;
    let p = r
        .profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or("profile")?;
    p.connection_id = connection;
    p.email = email;
    write(app, &r)
}
pub(crate) fn is_enabled(app: &AppHandle, p: &Profile) -> bool {
    profile(app, &p.provider, Some(&p.id))
        .ok()
        .flatten()
        .is_some_and(|p| p.enabled)
}
pub(crate) fn key(p: &Profile, identity: &str) -> String {
    if p.id.starts_with("legacy-") {
        identity.into()
    } else {
        format!("{identity}:{}", p.id)
    }
}
#[tauri::command]
pub fn connection_profiles(app: AppHandle) -> Result<Registry, String> {
    let _guard = FILE_LOCK.lock().map_err(|_| "storage")?;
    read(&app)
}
#[tauri::command]
pub async fn connection_profile_update(
    app: AppHandle,
    state: State<'_, ProfileOperations>,
    action: String,
    id: Option<String>,
    provider: Option<String>,
    name: Option<String>,
) -> Result<Registry, String> {
    let _op = state.0.lock().await;
    if ["disconnect", "delete", "disable"].contains(&action.as_str()) {
        let id = id.as_deref().ok_or("profile")?;
        let p = {
            let _g = FILE_LOCK.lock().map_err(|_| "storage")?;
            read(&app)?
                .profiles
                .into_iter()
                .find(|p| p.id == id)
                .ok_or("profile")?
        };
        if action == "disable" {
            // Disable first so a new start cannot race shutdown.
            let _g = FILE_LOCK.lock().map_err(|_| "storage")?;
            let mut r = read(&app)?;
            r.profiles
                .iter_mut()
                .find(|x| x.id == id)
                .ok_or("profile")?
                .enabled = false;
            write(&app, &r)?;
        }
        if p.provider == "openai" {
            crate::openai_connection::close_profile(&app, &p, action != "disable").await?;
        } else {
            crate::claude_agent::close_profile(&app, &p, action != "disable").await?;
        }
    }
    let r = {
        let _g = FILE_LOCK.lock().map_err(|_| "storage")?;
        let mut r = read(&app)?;
        if action == "create" {
            let provider = provider
                .filter(|p| ["openai", "claude"].contains(&p.as_str()))
                .ok_or("provider")?;
            if r.profiles.len() >= 100 {
                return Err("limit".into());
            }
            let name = clean_name(name.as_deref().unwrap_or_default())?;
            let id = uuid::Uuid::new_v4().to_string();
            r.profiles.push(Profile {
                id: id.clone(),
                provider: provider.clone(),
                name,
                enabled: true,
                connection_id: None,
                email: None,
            });
            r.defaults.entry(provider).or_insert(id);
        } else {
            let id = id.ok_or("profile")?;
            let p = r
                .profiles
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or("profile")?;
            match action.as_str() {
                "rename" => p.name = clean_name(name.as_deref().ok_or("name")?)?,
                "enable" => p.enabled = true,
                "disable" | "disconnect" => {}
                "select" => {
                    if !p.enabled {
                        return Err("profile-disabled".into());
                    }
                    r.defaults.insert(p.provider.clone(), id.clone());
                }
                "delete" => {
                    r.profiles.retain(|p| p.id != id);
                    r.defaults.retain(|_, v| v != &id);
                }
                _ => return Err("action".into()),
            }
        }
        write(&app, &r)?;
        r
    };
    let _ = app.emit("connections://changed", ());
    Ok(r)
}
fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.chars().count() > 80 || n.chars().any(char::is_control) {
        return Err("profile-name".into());
    }
    Ok(n.into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_bounded() {
        assert_eq!(clean_name(" Work ").unwrap(), "Work");
        assert_eq!(clean_name("").unwrap(), "");
        assert!(clean_name("a\nb").is_err());
        assert!(clean_name(&"a".repeat(81)).is_err());
    }
    #[test]
    fn environments_have_distinct_keys() {
        let mut p = Profile {
            id: "legacy-openai".into(),
            provider: "openai".into(),
            name: "test".into(),
            enabled: true,
            connection_id: None,
            email: None,
        };
        assert_eq!(key(&p, "identity"), "identity");
        p.id = uuid::Uuid::new_v4().to_string();
        assert_ne!(key(&p, "identity"), "identity");
    }
}
