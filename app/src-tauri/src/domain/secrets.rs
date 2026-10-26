//! Secret references and Windows DPAPI wrapping for values copied into the v2 vault.
//!
//! References live beside the application database, so copying a portable install
//! also copies the reference. DPAPI still binds ciphertext to the Windows user and
//! machine; a copied vault cannot be decrypted by an unrelated Windows account.

use super::profile::SecretReference;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const DPAPI_PROVIDER: &str = "windows-dpapi-v1";
pub const LEGACY_PROVIDER: &str = "legacy-settings-v1";
pub const LEGACY_PROFILE_PROVIDER: &str = "legacy-profile-v1";

/// Recovery snapshots retain ciphertext outside the live profile vault, so a
/// later edit/delete cannot invalidate their credential references.
pub fn seal_recovery_secret(plaintext: &str) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        dpapi::protect(plaintext.as_bytes())
    }
    #[cfg(not(windows))]
    {
        let _ = plaintext;
        Err("Recovery credentials require Windows DPAPI".into())
    }
}

pub fn unseal_connection_secret(ciphertext: &[u8]) -> Result<String, String> {
    #[cfg(windows)]
    {
        String::from_utf8(dpapi::unprotect(ciphertext)?)
            .map_err(|_| "Invalid protected connection".into())
    }
    #[cfg(not(windows))]
    {
        let _ = ciphertext;
        Err("Connection credentials require Windows DPAPI".into())
    }
}

pub fn is_secret_field(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    if normalized.contains("secretref") {
        return false;
    }
    normalized.ends_with("apikey")
        || normalized.ends_with("token")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized == "authorization"
}

/// CLI credentials can be hidden inside a neutral JSON field name. Protect the
/// complete argument string so quoting and spacing roundtrip exactly at launch.
pub fn is_secret_value(key: &str, value: &Value) -> bool {
    is_secret_field(key)
        || (key.eq_ignore_ascii_case("extraArgs")
            && value.as_str().is_some_and(cli_contains_credentials))
}

pub fn cli_contains_credentials(args: &str) -> bool {
    args.split_whitespace().any(|token| {
        let token = token.trim_matches(['\'', '"']);
        let flag = token
            .split('=')
            .next()
            .unwrap_or(token)
            .trim_matches(['\'', '"']);
        flag.starts_with("--") && is_secret_field(flag)
    })
}

pub fn store_secret(
    conn: &Connection,
    profile_id: &str,
    field_path: &str,
    plaintext: &str,
) -> Result<SecretReference, String> {
    if plaintext.is_empty() {
        return Err("Empty secrets are not stored".into());
    }

    #[cfg(windows)]
    {
        let id = uuid::Uuid::new_v4().to_string();
        let ciphertext = dpapi::protect(plaintext.as_bytes())?;
        conn.execute(
            "INSERT INTO profile_secrets(id, profile_id, field_path, provider, ciphertext, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(profile_id, field_path) DO UPDATE SET
               id=excluded.id, provider=excluded.provider, ciphertext=excluded.ciphertext, created_at=excluded.created_at",
            params![
                id,
                profile_id,
                field_path,
                DPAPI_PROVIDER,
                ciphertext,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|e| format!("Could not store the protected profile secret: {e}"))?;
        Ok(SecretReference {
            provider: DPAPI_PROVIDER.into(),
            id,
        })
    }

    #[cfg(not(windows))]
    {
        let _ = (conn, profile_id);
        Ok(SecretReference {
            provider: LEGACY_PROVIDER.into(),
            id: format!("legacy-settings:{field_path}"),
        })
    }
}

/// Stores a newly supplied profile credential. Non-Windows builds fail closed;
/// they never put plaintext into the profile database.
pub fn store_profile_secret(
    conn: &Connection,
    profile_id: &str,
    field_path: &str,
    plaintext: &str,
) -> Result<SecretReference, String> {
    #[cfg(windows)]
    {
        store_secret(conn, profile_id, field_path, plaintext)
    }
    #[cfg(not(windows))]
    {
        let _ = (conn, profile_id, field_path, plaintext);
        Err("Profile secrets require Windows DPAPI and are not stored on this platform".into())
    }
}

/// A non-Windows migration can still reference, without copying, a value that
/// remains in the original legacy profiles row.
pub fn legacy_profile_reference(profile_id: &str, field_path: &str) -> SecretReference {
    let locator = serde_json::to_string(&(profile_id, field_path)).unwrap_or_default();
    SecretReference {
        provider: LEGACY_PROFILE_PROVIDER.into(),
        id: format!("legacy-profile-json:{locator}"),
    }
}

pub fn store_legacy_profile_secret(
    conn: &Connection,
    profile_id: &str,
    field_path: &str,
    plaintext: &str,
) -> Result<SecretReference, String> {
    #[cfg(windows)]
    {
        store_secret(conn, profile_id, field_path, plaintext)
    }
    #[cfg(not(windows))]
    {
        let _ = (conn, plaintext);
        Ok(legacy_profile_reference(profile_id, field_path))
    }
}

pub fn resolve_secret(conn: &Connection, reference: &SecretReference) -> Result<String, String> {
    match reference.provider.as_str() {
        DPAPI_PROVIDER => {
            let ciphertext: Vec<u8> = conn
                .query_row(
                    "SELECT ciphertext FROM profile_secrets WHERE id=?1 AND provider=?2",
                    params![reference.id, DPAPI_PROVIDER],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "The referenced protected secret is unavailable".to_string())?;
            #[cfg(windows)]
            {
                let mut plaintext = dpapi::unprotect(&ciphertext)?;
                let value = String::from_utf8(plaintext.clone())
                    .map_err(|_| "The protected secret is not valid UTF-8".to_string());
                plaintext.fill(0);
                value
            }
            #[cfg(not(windows))]
            {
                let _ = ciphertext;
                Err("Windows DPAPI secrets can only be resolved on Windows".into())
            }
        }
        LEGACY_PROVIDER => resolve_legacy_settings(conn, &reference.id),
        LEGACY_PROFILE_PROVIDER => resolve_legacy_profile(conn, &reference.id),
        _ => Err(format!(
            "Unsupported secret provider: {}",
            reference.provider
        )),
    }
}

fn resolve_legacy_settings(conn: &Connection, id: &str) -> Result<String, String> {
    let path = id
        .strip_prefix("legacy-settings:")
        .ok_or_else(|| "Invalid legacy settings reference".to_string())?;
    let json: String = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key='settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Legacy settings are unavailable".to_string())?;
    let settings: Value =
        serde_json::from_str(&json).map_err(|e| format!("Legacy settings JSON is invalid: {e}"))?;
    // A settings secret is normally a scalar at the end of the path.
    let secret = settings
        .pointer(&format!("/{}", path.replace('.', "/")))
        .and_then(Value::as_str)
        .ok_or_else(|| "The referenced legacy setting is unavailable".to_string())?;
    Ok(secret.to_string())
}

fn resolve_legacy_profile(conn: &Connection, id: &str) -> Result<String, String> {
    let locator = id
        .strip_prefix("legacy-profile-json:")
        .ok_or_else(|| "Invalid legacy profile reference".to_string())?;
    let (profile_id, field_path): (String, String) = serde_json::from_str(locator)
        .map_err(|e| format!("Invalid legacy profile locator: {e}"))?;
    let config_json: String = conn
        .query_row(
            "SELECT config_json FROM profiles WHERE id=?1",
            [&profile_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "The referenced legacy profile is unavailable".to_string())?;
    let config: Value = serde_json::from_str(&config_json)
        .map_err(|e| format!("Legacy profile config JSON is invalid: {e}"))?;
    config
        .pointer(&field_path)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The referenced legacy profile secret is unavailable".to_string())
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;

    #[repr(C)]
    struct DataBlob {
        size: u32,
        data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetLastError() -> u32;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    struct OwnedBlob(DataBlob);

    impl Drop for OwnedBlob {
        fn drop(&mut self) {
            unsafe {
                if !self.0.data.is_null() {
                    std::slice::from_raw_parts_mut(self.0.data, self.0.size as usize).fill(0);
                    LocalFree(self.0.data.cast());
                }
            }
        }
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            size: u32::try_from(plaintext.len()).map_err(|_| "Secret is too large".to_string())?,
            data: plaintext.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            size: 0,
            data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Windows DPAPI protection failed (error {})",
                unsafe { GetLastError() }
            ));
        }
        let output = OwnedBlob(output);
        Ok(unsafe { std::slice::from_raw_parts(output.0.data, output.0.size as usize).to_vec() })
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob {
            size: u32::try_from(ciphertext.len()).map_err(|_| "Secret is too large".to_string())?,
            data: ciphertext.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            size: 0,
            data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Windows DPAPI decryption failed (error {})",
                unsafe { GetLastError() }
            ));
        }
        let output = OwnedBlob(output);
        Ok(unsafe { std::slice::from_raw_parts(output.0.data, output.0.size as usize).to_vec() })
    }
}
