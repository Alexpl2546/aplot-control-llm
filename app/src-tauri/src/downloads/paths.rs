use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn validate_relative(text: &str) -> Result<(), String> {
    if text.is_empty()
        || text.len() > 1024
        || text.contains('\\')
        || text.contains(':')
        || text.starts_with('/')
    {
        return Err("Unsafe repository file path".into());
    }
    for part in text.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err(format!("Unsafe repository file path: {text}"));
        }
    }
    Ok(())
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// Check every existing ancestor. In particular, Windows junctions are reparse
/// points too and must not be treated as ordinary directories in owned staging.
pub fn no_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if is_link(&meta) => {
                return Err(format!(
                    "Links/reparse points are not allowed in download destination: {}",
                    ancestor.display()
                ))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

pub fn destination(text: &str) -> Result<PathBuf, String> {
    validate_destination_with_store(
        text,
        crate::db::model_library_root().as_deref(),
        crate::components::store_root().as_deref(),
    )
}

#[cfg(test)]
fn validate_destination(text: &str, installation: Option<&Path>) -> Result<PathBuf, String> {
    validate_destination_with_store(text, installation, None)
}

fn canonical_future_path(path: &Path) -> Result<PathBuf, String> {
    let mut anchor = path;
    let mut tail = Vec::new();
    while !anchor.exists() {
        tail.push(
            anchor
                .file_name()
                .ok_or("Invalid download folder")?
                .to_os_string(),
        );
        anchor = anchor.parent().ok_or("Invalid download folder")?;
    }
    let mut result = anchor.canonicalize().map_err(|e| e.to_string())?;
    for component in tail.into_iter().rev() {
        result.push(component);
    }
    Ok(result)
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn validate_destination_with_store(
    text: &str,
    installation: Option<&Path>,
    component_store: Option<&Path>,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err("Choose an absolute download folder".into());
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Parent traversal is not allowed".into());
    }
    let path: PathBuf = path.components().collect();
    no_links(&path)?;
    // Resolve the existing ancestor before creating anything. This handles dot
    // components, Win32 short names and extended path prefixes consistently.
    let path = canonical_future_path(&path)?;
    let absolute = path_key(&path);
    let mut protected_roots = Vec::new();
    if let Some(root) = installation {
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        for reserved in ["downloads", "cache", "modules", "engines", "data"] {
            protected_roots.push(root.join(reserved));
        }
    }
    if let Some(root) = component_store {
        protected_roots.push(canonical_future_path(root)?);
    }
    for root in protected_roots {
        let reserved = path_key(&root);
        if absolute == reserved || absolute.starts_with(&format!("{reserved}\\")) {
            return Err("Choose a models folder outside application component, data and installer cache directories".into());
        }
    }
    fs::create_dir_all(&path).map_err(|e| format!("Cannot create download folder: {e}"))?;
    no_links(&path)?;
    let probe = path.join(format!(".aplot-write-test-{}", uuid::Uuid::new_v4()));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|e| format!("Download folder is not writable: {e}"))?;
    drop(file);
    fs::remove_file(probe).map_err(|e| e.to_string())?;
    path.canonicalize().map_err(|e| e.to_string())
}

pub fn staging(plan: &super::DownloadPlan) -> PathBuf {
    Path::new(&plan.destination)
        .join(".aplot-staging")
        .join(&plan.plan_id)
}

pub fn available(path: &Path) -> Result<u64, String> {
    let full = path.canonicalize().map_err(|e| e.to_string())?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|d| {
            full.starts_with(d.mount_point()) || {
                // canonicalize adds the Win32 extended path prefix.
                full.to_string_lossy()
                    .trim_start_matches(r"\\?\")
                    .to_ascii_lowercase()
                    .starts_with(&d.mount_point().to_string_lossy().to_ascii_lowercase())
            }
        })
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
        .ok_or_else(|| "Cannot determine free space on the destination volume".into())
}

pub fn part_path(plan: &super::DownloadPlan, relative: &str) -> Result<PathBuf, String> {
    validate_relative(relative)?;
    let path = staging(plan).join(format!("{relative}.part"));
    no_links(&path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_component_store_is_protected_before_any_folder_is_created() {
        let base =
            std::env::temp_dir().join(format!("aplot-store-boundary-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&base).unwrap();
        let store = base.join("проект/components");
        let destination = store.join("cache/new-model");
        assert!(validate_destination_with_store(
            &destination.to_string_lossy(),
            None,
            Some(&store)
        )
        .is_err());
        assert!(!store.exists());
        let models = base.join("модели");
        let actual =
            validate_destination_with_store(&models.to_string_lossy(), None, Some(&store)).unwrap();
        fs::remove_dir(actual).unwrap();
        fs::remove_dir(base).unwrap();
    }
    #[test]
    fn blocks_windows_and_traversal_paths() {
        for name in [
            "../x.gguf",
            "/x",
            "C:/x",
            "a\\x",
            "a/../b",
            "CON.gguf",
            "a/x:stream",
            "NUL/x",
            "a./b",
            "x//y",
            "LPT1.txt",
            "a/ x ",
        ] {
            assert!(validate_relative(name).is_err(), "{name}");
        }
        assert!(validate_relative("модели/model-Q4_K_M-00001-of-00002.gguf").is_ok());
    }

    #[test]
    fn reserved_destinations_are_rejected_before_creating_any_folder() {
        let root = std::env::temp_dir().join(format!("aplot-destination-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        for name in ["downloads", "cache", "modules", "engines", "data"] {
            let path = root.join(".").join(name).join(".").join("must-not-exist");
            assert!(
                validate_destination(&path.to_string_lossy(), Some(&root)).is_err(),
                "{name}"
            );
            assert!(
                !root.join(name).exists(),
                "No write before rejecting {name}"
            );
        }
        assert!(validate_destination("relative/models", Some(&root)).is_err());
        let good = root.join("модели с пробелами");
        let actual = validate_destination(&good.to_string_lossy(), Some(&root)).unwrap();
        assert!(actual.is_dir());
        assert!(available(&actual).unwrap() > 0);
        fs::remove_dir(actual).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
