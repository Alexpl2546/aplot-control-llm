use super::{huggingface, paths, DownloadFile, DownloadTask};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};

pub fn existing(task: &DownloadTask, file: &DownloadFile) -> Result<PathBuf, String> {
    let ready = paths::staging(&task.plan).join(&file.path);
    paths::no_links(&ready)?;
    if ready.is_file() {
        Ok(ready)
    } else {
        paths::part_path(&task.plan, &file.path)
    }
}

fn read_u32(r: &mut impl Read) -> Result<u32, String> {
    let mut b = [0; 4];
    r.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(u32::from_le_bytes(b))
}
fn read_u64(r: &mut impl Read) -> Result<u64, String> {
    let mut b = [0; 8];
    r.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(u64::from_le_bytes(b))
}
fn skip(r: &mut (impl Read + Seek), n: u64, len: u64) -> Result<(), String> {
    let pos = r.stream_position().map_err(|e| e.to_string())?;
    let end = pos
        .checked_add(n)
        .filter(|n| *n <= len)
        .ok_or("Truncated GGUF data")?;
    r.seek(SeekFrom::Start(end)).map_err(|e| e.to_string())?;
    Ok(())
}
fn string(r: &mut (impl Read + Seek), len: u64, capture: bool) -> Result<String, String> {
    let n = read_u64(r)?;
    if n > 16 * 1024 * 1024 {
        return Err("Unreasonable GGUF string length".into());
    }
    if capture {
        if n > 65536 {
            return Err("GGUF metadata key is too long".into());
        }
        let mut b = vec![0; n as usize];
        r.read_exact(&mut b).map_err(|e| e.to_string())?;
        String::from_utf8(b).map_err(|e| e.to_string())
    } else {
        skip(r, n, len)?;
        Ok(String::new())
    }
}
fn skip_value(r: &mut (impl Read + Seek), ty: u32, len: u64, depth: usize) -> Result<(), String> {
    let width = match ty {
        0 | 1 | 7 => 1,
        2 | 3 => 2,
        4 | 5 | 6 => 4,
        10 | 11 | 12 => 8,
        8 => {
            string(r, len, false)?;
            return Ok(());
        }
        9 => {
            if depth > 1 {
                return Err("Nested GGUF metadata arrays are invalid".into());
            }
            let item = read_u32(r)?;
            let n = read_u64(r)?;
            if n > len || item == 9 {
                return Err("Invalid GGUF metadata array".into());
            }
            if item != 8 {
                let width = match item {
                    0 | 1 | 7 => 1,
                    2 | 3 => 2,
                    4 | 5 | 6 => 4,
                    10 | 11 | 12 => 8,
                    _ => return Err("Unknown GGUF metadata type".into()),
                };
                return skip(r, n.checked_mul(width).ok_or("GGUF array overflow")?, len);
            }
            for _ in 0..n {
                skip_value(r, item, len, depth + 1)?;
            }
            return Ok(());
        }
        _ => return Err(format!("Unknown GGUF metadata type {ty}")),
    };
    skip(r, width, len)
}

/// Strict streaming envelope validation before publication. This validates tensor
/// descriptors and offsets; engine architecture support is deliberately separate.
fn validate_gguf(path: &Path, file: &DownloadFile) -> Result<(), String> {
    let len = fs::metadata(path).map_err(|e| e.to_string())?.len();
    let mut r = BufReader::new(fs::File::open(path).map_err(|e| e.to_string())?);
    let mut magic = [0; 4];
    r.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if magic != *b"GGUF" {
        return Err("Downloaded file is not GGUF".into());
    }
    let version = read_u32(&mut r)?;
    if !(2..=3).contains(&version) {
        return Err(format!("Unsupported GGUF version {version}"));
    }
    let tensors = read_u64(&mut r)?;
    let count = read_u64(&mut r)?;
    if tensors == 0 || tensors > 1_000_000 || count > 100_000 {
        return Err("Invalid GGUF tensor/metadata count".into());
    }
    let mut alignment = 32u64;
    let mut split_no = None;
    let mut split_count = None;
    for _ in 0..count {
        let key = string(&mut r, len, true)?;
        let ty = read_u32(&mut r)?;
        if key == "general.alignment" && ty == 4 {
            alignment = read_u32(&mut r)? as u64;
        } else if matches!(key.as_str(), "split.no" | "split.count") && (ty == 2 || ty == 4) {
            let value = if ty == 2 {
                let mut b = [0; 2];
                r.read_exact(&mut b).map_err(|e| e.to_string())?;
                u16::from_le_bytes(b) as u64
            } else {
                read_u32(&mut r)? as u64
            };
            if key == "split.no" {
                split_no = Some(value)
            } else {
                split_count = Some(value)
            }
        } else {
            skip_value(&mut r, ty, len, 0)?;
        }
    }
    if alignment == 0 || alignment > 1024 * 1024 || !alignment.is_power_of_two() {
        return Err("Invalid GGUF alignment".into());
    }
    if let Some((_, index, total)) = huggingface::split_name(&file.path) {
        if index == 0
            || total == 0
            || index > total
            || split_no != Some(index as u64 - 1)
            || split_count != Some(total as u64)
        {
            return Err("Split-GGUF metadata does not match the selected shard set".into());
        }
    } else if split_count.is_some_and(|n| n > 1) {
        return Err("Split-GGUF file is missing its named shard set".into());
    }
    let mut offsets = Vec::new();
    for _ in 0..tensors {
        string(&mut r, len, false)?;
        let dims = read_u32(&mut r)?;
        if !(1..=4).contains(&dims) {
            return Err("Invalid GGUF tensor dimensions".into());
        }
        let mut elements = 1u64;
        for _ in 0..dims {
            let n = read_u64(&mut r)?;
            if n == 0 {
                return Err("Empty GGUF tensor".into());
            }
            elements = elements.checked_mul(n).ok_or("GGUF tensor size overflow")?;
        }
        let _ty = read_u32(&mut r)?;
        let offset = read_u64(&mut r)?;
        if offset % alignment != 0 {
            return Err("Misaligned GGUF tensor offset".into());
        }
        offsets.push(offset);
    }
    let pos = r.stream_position().map_err(|e| e.to_string())?;
    let start = pos.checked_add(alignment - 1).ok_or("GGUF size overflow")? / alignment * alignment;
    if offsets
        .iter()
        .any(|offset| start.checked_add(*offset).is_none_or(|n| n >= len))
    {
        return Err("Truncated GGUF tensor data".into());
    }
    Ok(())
}

pub fn verify(path: &Path, file: &DownloadFile, control: &AtomicU8) -> Result<String, String> {
    paths::no_links(path)?;
    if fs::metadata(path).map_err(|e| e.to_string())?.len() != file.size_bytes {
        return Err(format!("Size mismatch: {}", file.path));
    }
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if control.load(Ordering::Acquire) != 0 {
            return Err("Verification paused".into());
        }
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let digest = format!("{:x}", hasher.finalize());
    if file.sha256.as_ref().is_some_and(|sha| sha != &digest) {
        return Err(format!(
            "SHA-256 mismatch: {}. Remove partial files before retrying.",
            file.path
        ));
    }
    if file.local_sha256.as_ref().is_some_and(|sha| sha != &digest) {
        return Err(format!("Locally verified file changed: {}", file.path));
    }
    validate_gguf(path, file)?;
    Ok(digest)
}

pub async fn verify_file(
    task: &DownloadTask,
    file: &DownloadFile,
    control: Arc<AtomicU8>,
) -> Result<String, String> {
    let path = existing(task, file)?;
    let file = file.clone();
    tokio::task::spawn_blocking(move || verify(&path, &file, &control))
        .await
        .map_err(|e| e.to_string())?
}

fn marker_matches(path: &Path, task: &DownloadTask) -> Result<(), String> {
    paths::no_links(path)?;
    let marker: DownloadTask = serde_json::from_slice(
        &fs::read(path.join(".aplot-install.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if marker.id != task.id
        || marker.plan.revision != task.plan.revision
        || marker.plan.repo_id != task.plan.repo_id
        || marker
            .plan
            .files
            .iter()
            .map(|f| (&f.path, f.size_bytes, &f.sha256))
            .collect::<Vec<_>>()
            != task
                .plan
                .files
                .iter()
                .map(|f| (&f.path, f.size_bytes, &f.sha256))
                .collect::<Vec<_>>()
    {
        return Err("Installation folder belongs to another model set".into());
    }
    Ok(())
}

pub fn publish_set(task: &DownloadTask) -> Result<String, String> {
    let staging = paths::staging(&task.plan);
    let target = Path::new(&task.plan.final_path);
    paths::no_links(&staging)?;
    paths::no_links(target)?;
    if target.exists() {
        return Err("Installation folder already exists; existing models were preserved".into());
    }
    let mut owned = std::collections::BTreeSet::new();
    owned.insert(staging.join(".aplot-install.json"));
    for file in &task.plan.files {
        let part = paths::part_path(&task.plan, &file.path)?;
        owned.extend([
            staging.join(&file.path),
            part.clone(),
            part.with_extension("checkpoint.json"),
            part.with_extension("checkpoint.tmp"),
            part.with_extension("verified-sha256"),
        ]);
    }
    for entry in walkdir::WalkDir::new(&staging).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        paths::no_links(entry.path())?;
        if entry.file_type().is_file() && !owned.contains(entry.path()) {
            return Err(format!(
                "Unexpected file in owned staging; publication refused: {}",
                entry.path().display()
            ));
        }
    }
    for file in &task.plan.files {
        let ready = staging.join(&file.path);
        paths::no_links(&ready)?;
        if !ready.exists() {
            fs::rename(paths::part_path(&task.plan, &file.path)?, &ready)
                .map_err(|e| e.to_string())?;
        }
    }
    let marker = staging.join(".aplot-install.json");
    paths::no_links(&marker)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
        .or_else(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&marker)
            } else {
                Err(e)
            }
        })
        .map_err(|e| e.to_string())?;
    output
        .write_all(&serde_json::to_vec(task).map_err(|e| e.to_string())?)
        .and_then(|_| output.sync_all())
        .map_err(|e| e.to_string())?;
    drop(output);
    fs::rename(&staging, target).map_err(|e| format!("Cannot publish complete model set: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Reconcile the only irreversible boundary: rename completed but DB commit did
/// not. A folder with a mismatched/missing marker is never adopted or removed.
#[cfg(test)]
pub fn recover(task: &mut DownloadTask) -> Result<bool, String> {
    recover_with_control(task, &AtomicU8::new(0))
}

pub fn published_set_exists(task: &DownloadTask) -> Result<bool, String> {
    let path = Path::new(&task.plan.final_path);
    if !path.exists() {
        return Ok(false);
    }
    marker_matches(path, task)?;
    Ok(true)
}

pub fn recover_with_control(task: &mut DownloadTask, control: &AtomicU8) -> Result<bool, String> {
    if !published_set_exists(task)? {
        return Ok(false);
    }
    let path = Path::new(&task.plan.final_path);
    for file in &task.plan.files {
        verify(&path.join(&file.path), file, control)?;
    }
    task.state = "completed".into();
    task.installed_path = Some(task.plan.final_path.clone());
    task.downloaded_bytes = task.total_bytes;
    task.verification = Some(
        if task.plan.files.iter().all(|f| f.sha256.is_some()) {
            "source_sha256"
        } else {
            "size_gguf_local_sha256_only"
        }
        .into(),
    );
    Ok(true)
}

pub fn remove_partial(task: &DownloadTask) -> Result<(), String> {
    let staging = paths::staging(&task.plan);
    paths::no_links(&staging)?;
    if !staging.exists() {
        return Ok(());
    }
    // Check every descendant before any deletion, including Windows reparse points.
    for entry in walkdir::WalkDir::new(&staging).follow_links(false) {
        paths::no_links(entry.map_err(|e| e.to_string())?.path())?;
    }
    if staging
        .parent()
        .and_then(Path::file_name)
        .and_then(|n| n.to_str())
        != Some(".aplot-staging")
        || staging.file_name().and_then(|n| n.to_str()) != Some(&task.id)
        || uuid::Uuid::parse_str(&task.id).is_err()
    {
        return Err("Invalid owned staging directory".into());
    }
    fs::remove_dir_all(staging).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_bytes() -> Vec<u8> {
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(3u32.to_le_bytes());
        bytes.extend(1u64.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        bytes.extend(1u64.to_le_bytes());
        bytes.push(b'x');
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(1u64.to_le_bytes());
        bytes.extend(0u32.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        while bytes.len() % 32 != 0 {
            bytes.push(0);
        }
        bytes.extend(1f32.to_le_bytes());
        bytes
    }
    fn model(bytes: &[u8]) -> DownloadFile {
        DownloadFile {
            path: "model.gguf".into(),
            size_bytes: bytes.len() as u64,
            sha256: Some(format!("{:x}", Sha256::digest(bytes))),
            local_sha256: None,
            role: "model".into(),
            quantization: None,
        }
    }
    fn cleanup(task: &DownloadTask) {
        let root = Path::new(&task.plan.destination);
        assert!(root.starts_with(std::env::temp_dir()));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("aplot-download-"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publishes_atomically_and_recovers_after_rename_before_database_commit() {
        let bytes = valid_bytes();
        let file = model(&bytes);
        let mut task = super::super::fixture();
        task.plan.files = vec![file.clone()];
        task.total_bytes = file.size_bytes;
        task.plan.total_bytes = file.size_bytes;
        let part = paths::part_path(&task.plan, &file.path).unwrap();
        fs::create_dir_all(part.parent().unwrap()).unwrap();
        fs::write(&part, &bytes).unwrap();
        let digest = verify(&part, &file, &AtomicU8::new(0)).unwrap();
        task.plan.files[0].local_sha256 = Some(digest);
        task.state = "installing".into();
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        super::super::repository::init_schema(&conn).unwrap();
        super::super::repository::save(&mut conn, &task).unwrap();
        assert!(!Path::new(&task.plan.final_path).exists());
        publish_set(&task).unwrap();
        assert!(Path::new(&task.plan.final_path)
            .join("model.gguf")
            .is_file());
        assert!(!paths::staging(&task.plan).exists());
        let mut loaded = super::super::repository::list(&conn).unwrap().remove(0);
        assert!(recover(&mut loaded).unwrap());
        assert_eq!(loaded.state, "completed");
        super::super::repository::save(&mut conn, &loaded).unwrap();
        let installed: String = conn
            .query_row("SELECT installed_path FROM model_installations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(installed, task.plan.final_path);
        assert!(publish_set(&task).is_err()); // Never overwrite an existing set.
        let paused = AtomicU8::new(1);
        assert!(recover_with_control(&mut loaded, &paused)
            .unwrap_err()
            .contains("paused"));
        cleanup(&task);
    }

    #[test]
    fn detects_changed_contents_and_preserves_existing_models_on_partial_cleanup() {
        let bytes = valid_bytes();
        let mut task = super::super::fixture();
        let mut file = model(&bytes);
        let part = paths::part_path(&task.plan, &file.path).unwrap();
        fs::create_dir_all(part.parent().unwrap()).unwrap();
        fs::write(&part, &bytes).unwrap();
        file.sha256 = Some("0".repeat(64));
        assert!(verify(&part, &file, &AtomicU8::new(0))
            .unwrap_err()
            .contains("SHA-256 mismatch"));
        let outside = Path::new(&task.plan.destination).join("existing.gguf");
        fs::write(&outside, &bytes).unwrap();
        remove_partial(&task).unwrap();
        assert_eq!(fs::read(&outside).unwrap(), bytes);
        task.plan.files = vec![model(&bytes)];
        fs::create_dir_all(&task.plan.final_path).unwrap();
        assert!(recover(&mut task).is_err());
        assert!(Path::new(&task.plan.final_path).exists());
        cleanup(&task);
    }

    #[test]
    fn refuses_to_publish_unselected_staging_files() {
        let bytes = valid_bytes();
        let mut task = super::super::fixture();
        let file = model(&bytes);
        task.plan.files = vec![file.clone()];
        let part = paths::part_path(&task.plan, &file.path).unwrap();
        fs::create_dir_all(part.parent().unwrap()).unwrap();
        fs::write(&part, &bytes).unwrap();
        fs::write(paths::staging(&task.plan).join("unselected.gguf"), &bytes).unwrap();
        assert!(publish_set(&task).unwrap_err().contains("Unexpected file"));
        assert!(!Path::new(&task.plan.final_path).exists());
        cleanup(&task);
    }

    #[test]
    fn strict_structure_rejects_bad_tensor_offsets_and_shard_metadata() {
        let task = super::super::fixture();
        let mut bytes = valid_bytes();
        let mut file = model(&bytes);
        let path = Path::new(&task.plan.destination).join("model.gguf");
        bytes[49..57].copy_from_slice(&u64::MAX.to_le_bytes());
        file.sha256 = None;
        fs::write(&path, &bytes).unwrap();
        assert!(verify(&path, &file, &AtomicU8::new(0)).is_err());
        fs::write(&path, valid_bytes()).unwrap();
        file.path = "model-00001-of-00002.gguf".into();
        assert!(verify(&path, &file, &AtomicU8::new(0))
            .unwrap_err()
            .contains("Split-GGUF"));
        cleanup(&task);
    }
    #[test]
    fn refuses_truncated_gguf_and_bad_digest() {
        let path = std::env::temp_dir().join(format!("aplot-{}.part", uuid::Uuid::new_v4()));
        fs::write(&path, b"GGUF").unwrap();
        let file = DownloadFile {
            path: "model.gguf".into(),
            size_bytes: 4,
            sha256: None,
            local_sha256: None,
            role: "model".into(),
            quantization: None,
        };
        assert!(verify(&path, &file, &AtomicU8::new(0)).is_err());
        fs::remove_file(path).unwrap();
    }
}
