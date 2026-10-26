//! Read-only model artifact catalogue and deletion preview.
//!
//! The scanner reads directory entries and metadata for catalogued model files.
//! On Windows it opens read-only handles for file identity. It never reads or hashes
//! model weights, so previews remain practical for multi-GB files.

use crate::domain::artifacts::{
    ArtifactCatalog, ArtifactConsumer, ArtifactFile, ArtifactKind, ArtifactRemovalPreview,
    ArtifactState, MissingArtifactReference, ModelArtifact, RemovalPreviewFile,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone)]
struct Candidate {
    path: PathBuf,
    relative_path: PathBuf,
    size_bytes: u64,
    identity: String,
    kind: ArtifactKind,
    role: String,
    group_key: String,
    shard: Option<ShardSet>,
}

struct Classification {
    kind: ArtifactKind,
    role: String,
    group_key: String,
    shard: Option<ShardSet>,
}

#[derive(Debug, Clone)]
struct ShardSet {
    prefix: String,
    extension: String,
    index: u32,
    index_width: usize,
    total: u32,
    total_width: usize,
}

/// Catalogues recognized model files under the supplied roots. Paths in consumer
/// records can point to either files or directories. No files are moved or deleted.
pub fn scan_model_artifacts(
    roots: &[PathBuf],
    consumers: &[ArtifactConsumer],
) -> Result<ArtifactCatalog, String> {
    let mut issues = Vec::new();
    let mut missing_references = Vec::new();
    let mut candidates = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut entries = Vec::new();
    let root_strings = roots
        .iter()
        .map(|root| display_path(root))
        .collect::<Vec<_>>();

    for root in roots {
        if crate::domain::paths::is_aplot_staging_path(root) {
            continue;
        }
        if !root.exists() {
            issues.push(format!("Catalogue root is missing: {}", display_path(root)));
            continue;
        }
        if root.is_file() {
            entries.push((root.clone(), root.parent().unwrap_or(root).to_path_buf()));
            continue;
        }
        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !crate::domain::paths::is_aplot_staging_path(entry.path()))
        {
            match entry {
                Ok(entry) if entry.file_type().is_file() => {
                    entries.push((entry.path().to_path_buf(), root.clone()))
                }
                Ok(_) => {}
                Err(error) => issues.push(format!(
                    "Could not inspect {}: {error}",
                    error
                        .path()
                        .map(display_path)
                        .unwrap_or_else(|| display_path(root))
                )),
            }
        }
    }

    let consumers: Vec<_> = consumers
        .iter()
        .filter(|consumer| !crate::domain::paths::is_aplot_staging_path(Path::new(&consumer.path)))
        .cloned()
        .collect();
    for (path, root) in entries {
        add_candidate(
            &path,
            &root,
            &consumers,
            &mut candidates,
            &mut issues,
            &mut seen_paths,
        );
    }

    for consumer in &consumers {
        if crate::domain::paths::is_aplot_staging_path(Path::new(&consumer.path)) {
            continue;
        }
        if !Path::new(&consumer.path).exists() {
            missing_references.push(MissingArtifactReference {
                path: consumer.path.clone(),
                consumer_id: consumer.id.clone(),
                consumer_kind: consumer.kind.clone(),
            });
        }
    }

    let mut aliases_by_identity: HashMap<String, BTreeSet<String>> = HashMap::new();
    for candidate in &candidates {
        aliases_by_identity
            .entry(candidate.identity.clone())
            .or_default()
            .insert(display_path(&candidate.path));
    }

    let mut groups: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
    for candidate in candidates {
        groups
            .entry(candidate.group_key.clone())
            .or_default()
            .push(candidate);
    }

    let mut artifacts = Vec::new();
    for (group_key, mut files) in groups {
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let first = &files[0];
        let id = stable_id("artifact", &group_key);
        let mut artifact_files = Vec::new();
        let mut logical_bytes = 0u64;
        let mut physical_identities = BTreeSet::new();
        let mut consumer_ids = BTreeSet::new();
        let mut shard_set: Option<ShardSet> = None;
        let mut shard_indexes = BTreeSet::new();

        for file in &files {
            logical_bytes = logical_bytes.saturating_add(file.size_bytes);
            physical_identities.insert(file.identity.clone());
            if let Some(shard) = &file.shard {
                shard_indexes.insert(shard.index);
                shard_set.get_or_insert_with(|| shard.clone());
            }
            let file_consumers = matching_consumers(&file.path, &consumers);
            consumer_ids.extend(file_consumers.iter().map(|consumer| consumer.id.clone()));
            let mut aliases = aliases_by_identity
                .get(&file.identity)
                .into_iter()
                .flat_map(|paths| paths.iter().cloned())
                .filter(|path| !same_path(path, &display_path(&file.path)))
                .collect::<Vec<_>>();
            aliases.sort();
            artifact_files.push(ArtifactFile {
                path: display_path(&file.path),
                relative_path: display_path(&file.relative_path),
                role: file.role.clone(),
                state: ArtifactState::Complete,
                size_bytes: file.size_bytes,
                file_identity: Some(file.identity.clone()),
                hardlink_aliases: aliases,
                consumer_ids: file_consumers
                    .iter()
                    .map(|consumer| consumer.id.clone())
                    .collect(),
            });
        }

        if let Some(shard) = shard_set {
            for index in 1..=shard.total {
                if shard_indexes.contains(&index) {
                    continue;
                }
                let expected_name = format!(
                    "{}{:0index_width$}-of-{:0total_width$}{}",
                    shard.prefix,
                    index,
                    shard.total,
                    shard.extension,
                    index_width = shard.index_width,
                    total_width = shard.total_width,
                );
                let expected = first
                    .path
                    .parent()
                    .unwrap_or(Path::new(""))
                    .join(&expected_name);
                let relative_expected = first
                    .relative_path
                    .parent()
                    .unwrap_or(Path::new(""))
                    .join(expected_name);
                artifact_files.push(ArtifactFile {
                    path: display_path(&expected),
                    relative_path: display_path(&relative_expected),
                    role: "missingShard".into(),
                    state: ArtifactState::Missing,
                    size_bytes: 0,
                    file_identity: None,
                    hardlink_aliases: Vec::new(),
                    consumer_ids: Vec::new(),
                });
            }
        }

        // Referencing one shard protects the entire declared shard set.
        for file in &mut artifact_files {
            file.consumer_ids = consumer_ids.iter().cloned().collect();
        }
        let artifact_kind = first.kind.clone();
        artifacts.push(ModelArtifact {
            id,
            display_name: first
                .path
                .file_stem()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| display_path(&first.path)),
            kind: artifact_kind,
            state: if artifact_files
                .iter()
                .any(|file| file.state != ArtifactState::Complete)
            {
                ArtifactState::Incomplete
            } else {
                ArtifactState::Complete
            },
            files: artifact_files,
            dependency_ids: Vec::new(),
            consumer_ids: consumer_ids.into_iter().collect(),
            logical_bytes,
            unique_physical_bytes: files
                .iter()
                .filter(|file| physical_identities.remove(&file.identity))
                .map(|file| file.size_bytes)
                .sum(),
            identity_confidence: if files.iter().any(|file| file.identity.starts_with("path:")) {
                "pathOnly".into()
            } else {
                "filesystemObject".into()
            },
        });
    }

    // Companion artifacts are separate catalog entries and depend on the primary
    // model only when a profile or run consumes both.
    let primary_by_consumer: HashMap<String, Vec<String>> = artifacts
        .iter()
        .filter(|artifact| {
            artifact.kind == ArtifactKind::PrimaryModel
                || (artifact.kind == ArtifactKind::OtherModel
                    && artifact.files.iter().any(|file| file.role == "primary"))
        })
        .flat_map(|artifact| {
            artifact
                .consumer_ids
                .iter()
                .map(move |consumer| (consumer.clone(), artifact.id.clone()))
        })
        .fold(HashMap::new(), |mut map, (consumer, artifact_id)| {
            map.entry(consumer)
                .or_insert_with(Vec::new)
                .push(artifact_id);
            map
        });
    for artifact in &mut artifacts {
        if matches!(
            &artifact.kind,
            ArtifactKind::Mmproj | ArtifactKind::Ngram | ArtifactKind::Mtp
        ) {
            artifact.dependency_ids = artifact
                .consumer_ids
                .iter()
                .flat_map(|consumer| {
                    primary_by_consumer
                        .get(consumer)
                        .into_iter()
                        .flatten()
                        .cloned()
                })
                .filter(|dependency| dependency != &artifact.id)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
        }
    }

    for reference in &missing_references {
        let id = stable_id("missing", &reference.path);
        if let Some(artifact) = artifacts.iter_mut().find(|artifact| artifact.id == id) {
            if !artifact.consumer_ids.contains(&reference.consumer_id) {
                artifact.consumer_ids.push(reference.consumer_id.clone());
                artifact.files[0]
                    .consumer_ids
                    .push(reference.consumer_id.clone());
            }
        } else {
            artifacts.push(ModelArtifact {
                id,
                display_name: Path::new(&reference.path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| reference.path.clone()),
                kind: ArtifactKind::PrimaryModel,
                state: ArtifactState::Missing,
                files: vec![ArtifactFile {
                    path: reference.path.clone(),
                    relative_path: reference.path.clone(),
                    role: "missingReference".into(),
                    state: ArtifactState::Missing,
                    size_bytes: 0,
                    file_identity: None,
                    hardlink_aliases: Vec::new(),
                    consumer_ids: vec![reference.consumer_id.clone()],
                }],
                dependency_ids: Vec::new(),
                consumer_ids: vec![reference.consumer_id.clone()],
                logical_bytes: 0,
                unique_physical_bytes: 0,
                identity_confidence: "pathOnly".into(),
            });
        }
    }
    artifacts.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    missing_references.sort_by(|a, b| a.path.cmp(&b.path).then(a.consumer_id.cmp(&b.consumer_id)));

    let logical_bytes = artifacts
        .iter()
        .map(|artifact| artifact.logical_bytes)
        .sum();
    let unique_physical_bytes = candidates_physical_total(&artifacts);
    Ok(ArtifactCatalog {
        scanned_at: chrono::Utc::now().to_rfc3339(),
        roots: root_strings,
        logical_bytes,
        unique_physical_bytes,
        artifacts,
        missing_references,
        issues,
    })
}

/// Builds a conservative removal preview. It never removes files; the UI can show
/// which paths would remain protected by profiles, active runs, or shared links.
pub fn preview_artifact_removal(
    catalog: &ArtifactCatalog,
    artifact_id: &str,
    consumers: &[ArtifactConsumer],
) -> Result<ArtifactRemovalPreview, String> {
    let target = catalog
        .artifacts
        .iter()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(|| "Artifact not found in the current catalogue".to_string())?;
    let active_ids: HashSet<&str> = consumers
        .iter()
        .filter(|consumer| consumer.active)
        .map(|consumer| consumer.id.as_str())
        .collect();
    let mut files = Vec::new();
    for file in &target.files {
        if file.state == ArtifactState::Missing {
            files.push(RemovalPreviewFile {
                path: file.path.clone(),
                size_bytes: 0,
                candidate_if_confirmed: false,
                protected_by: vec!["file is missing".into()],
            });
            continue;
        }
        let mut protected_by: BTreeSet<String> = file
            .consumer_ids
            .iter()
            .map(|id| format!("consumer:{id}"))
            .collect();
        for id in &file.consumer_ids {
            if active_ids.contains(id.as_str()) {
                protected_by.insert(format!("active:{id}"));
            }
        }
        if let Some(identity) = &file.file_identity {
            let shared_elsewhere = catalog.artifacts.iter().any(|artifact| {
                artifact.id != target.id
                    && artifact
                        .files
                        .iter()
                        .any(|other| other.file_identity.as_ref() == Some(identity))
            });
            if shared_elsewhere {
                protected_by.insert("shared by another artifact or hard-link alias".into());
            }
        }
        let protected_by = protected_by.into_iter().collect::<Vec<_>>();
        files.push(RemovalPreviewFile {
            path: file.path.clone(),
            size_bytes: file.size_bytes,
            candidate_if_confirmed: protected_by.is_empty(),
            protected_by,
        });
    }
    let candidate_file_count = files
        .iter()
        .filter(|file| file.candidate_if_confirmed)
        .count();
    let protected_file_count = files.len().saturating_sub(candidate_file_count);
    Ok(ArtifactRemovalPreview {
        artifact_id: target.id.clone(),
        files,
        protected_file_count,
        candidate_file_count,
        preview_only: true,
        message: "Preview only. This API does not delete model files.".into(),
    })
}

fn add_candidate(
    path: &Path,
    root: &Path,
    consumers: &[ArtifactConsumer],
    output: &mut Vec<Candidate>,
    issues: &mut Vec<String>,
    seen_paths: &mut HashSet<String>,
) {
    let path_key = normalized_path(path);
    if !seen_paths.insert(path_key) {
        return;
    }
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            issues.push(format!("Could not inspect {}: {error}", display_path(path)));
            return;
        }
    };
    if !metadata.is_file() {
        return;
    }
    let Some(classification) = classify(path, consumers) else {
        return;
    };
    let relative_path = path.strip_prefix(root).unwrap_or(path).to_path_buf();
    output.push(Candidate {
        path: path.to_path_buf(),
        relative_path,
        size_bytes: metadata.len(),
        identity: file_identity(path, &metadata),
        kind: classification.kind,
        role: classification.role,
        group_key: classification.group_key,
        shard: classification.shard,
    });
}

fn classify(path: &Path, consumers: &[ArtifactConsumer]) -> Option<Classification> {
    let file_name = path.file_name()?.to_string_lossy().to_string();
    let lower = file_name.to_lowercase();
    let raw_stem = path.file_stem()?.to_string_lossy().to_string();
    let stem = raw_stem.to_lowercase();
    let extension = path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    let recognized_extension = is_model_extension(&extension);
    let exact_reference = consumers
        .iter()
        .any(|consumer| same_path(&consumer.path, &display_path(path)));
    let ngram_path = path.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .to_lowercase()
            .contains("ngram")
    }) || consumers.iter().any(|consumer| {
        consumer.kind.eq_ignore_ascii_case("ngram")
            && path_is_within(path, Path::new(&consumer.path))
    });
    let kind = if ngram_path || lower.contains("ngram") {
        ArtifactKind::Ngram
    } else if lower.contains("mmproj") {
        ArtifactKind::Mmproj
    } else if ["mtp", "dflash", "draft", "speculative"]
        .iter()
        .any(|token| lower.contains(token))
    {
        ArtifactKind::Mtp
    } else if recognized_extension {
        if extension.eq_ignore_ascii_case(".gguf") {
            ArtifactKind::PrimaryModel
        } else {
            ArtifactKind::OtherModel
        }
    } else if exact_reference {
        // Retain explicit references from old profiles without discovering or
        // interpreting retired engine stores and file formats.
        ArtifactKind::OtherModel
    } else {
        return None;
    };

    let shard = parse_shard(&raw_stem, &extension);
    let role = if exact_reference && !recognized_extension {
        "legacyReference"
    } else {
        match &kind {
            ArtifactKind::Ngram => "ngram",
            ArtifactKind::Mmproj => "mmproj",
            ArtifactKind::Mtp => "mtp",
            ArtifactKind::PrimaryModel if shard.is_some() => "shard",
            ArtifactKind::PrimaryModel | ArtifactKind::OtherModel => "primary",
        }
    }
    .to_string();
    let normalized_base = if let Some(shard) = &shard {
        shard.prefix.to_lowercase()
    } else {
        companion_base(&stem, &kind)
    };
    let parent = normalized_path(path.parent().unwrap_or(path));
    let group_parent = if kind == ArtifactKind::Ngram {
        ngram_anchor(path)
            .map(|anchor| normalized_path(&anchor))
            .unwrap_or(parent.clone())
    } else {
        parent.clone()
    };
    let kind_key = match &kind {
        ArtifactKind::PrimaryModel => "primary",
        ArtifactKind::Mmproj => "mmproj",
        ArtifactKind::Ngram => "ngram",
        ArtifactKind::Mtp => "mtp",
        ArtifactKind::OtherModel if exact_reference && !recognized_extension => "legacy-reference",
        ArtifactKind::OtherModel => "other",
    };
    let format = if kind == ArtifactKind::Ngram {
        String::new()
    } else {
        extension.to_lowercase()
    };
    let group_key = if exact_reference && !recognized_extension {
        format!("{group_parent}|{kind_key}|{}", normalized_path(path))
    } else {
        format!("{group_parent}|{kind_key}|{normalized_base}|{format}")
    };
    Some(Classification {
        kind,
        role,
        group_key,
        shard,
    })
}
fn parse_shard(stem: &str, extension: &str) -> Option<ShardSet> {
    let parts: Vec<&str> = stem.rsplitn(4, '-').collect();
    if parts.len() != 4 || !parts[1].eq_ignore_ascii_case("of") {
        return None;
    }
    // rsplit order for `name-00001-of-00003` is [00003, of, 00001, name].
    let index = parts[2].parse::<u32>().ok()?;
    let total = parts[0].parse::<u32>().ok()?;
    let prefix = format!("{}-", parts[3]);
    if total == 0 || total > 4096 || index == 0 || index > total {
        return None;
    }
    Some(ShardSet {
        prefix,
        extension: extension.to_string(),
        index,
        index_width: parts[2].len(),
        total,
        total_width: parts[0].len(),
    })
}

fn companion_base(stem: &str, kind: &ArtifactKind) -> String {
    let lower = stem.to_lowercase();
    let tokens: &[&str] = match kind {
        ArtifactKind::Mmproj => &["-mmproj", "_mmproj", ".mmproj"],
        ArtifactKind::Mtp => &[
            "-mtp", "_mtp", ".mtp", "-dflash", "_dflash", "-draft", "_draft",
        ],
        _ => &[],
    };
    for token in tokens {
        if let Some(index) = lower.find(token) {
            return lower[..index].trim_end_matches(['-', '_', '.']).to_string();
        }
    }
    lower
}

fn ngram_anchor(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| {
            ancestor
                .file_name()
                .is_some_and(|name| name.to_string_lossy().to_lowercase().contains("ngram"))
        })
        .map(Path::to_path_buf)
}

fn is_model_extension(extension: &str) -> bool {
    [
        ".gguf",
        ".safetensors",
        ".onnx",
        ".pt",
        ".pth",
        ".bin",
        ".ggml",
        ".model",
    ]
    .iter()
    .any(|known| extension.eq_ignore_ascii_case(known))
}

fn matching_consumers<'a>(
    path: &Path,
    consumers: &'a [ArtifactConsumer],
) -> Vec<&'a ArtifactConsumer> {
    consumers
        .iter()
        .filter(|consumer| path_is_within(path, Path::new(&consumer.path)))
        .collect()
}

fn path_is_within(path: &Path, reference: &Path) -> bool {
    let path = normalized_path(path);
    let reference = normalized_path(reference);
    path == reference
        || path.starts_with(&format!("{reference}\\"))
        || path.starts_with(&format!("{reference}/"))
}

fn normalized_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn same_path(left: &str, right: &str) -> bool {
    left.replace('/', "\\")
        .eq_ignore_ascii_case(&right.replace('/', "\\"))
}

fn stable_id(prefix: &str, value: &str) -> String {
    // FNV-1a is a deterministic label, not a security fingerprint.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}-{hash:016x}")
}

fn file_identity(path: &Path, metadata: &Metadata) -> String {
    #[cfg(windows)]
    {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        #[repr(C)]
        struct FileTime {
            low_date_time: u32,
            high_date_time: u32,
        }
        #[repr(C)]
        struct ByHandleFileInformation {
            file_attributes: u32,
            creation_time: FileTime,
            last_access_time: FileTime,
            last_write_time: FileTime,
            volume_serial_number: u32,
            file_size_high: u32,
            file_size_low: u32,
            number_of_links: u32,
            file_index_high: u32,
            file_index_low: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(
                handle: *mut c_void,
                information: *mut ByHandleFileInformation,
            ) -> i32;
        }

        let _ = metadata;
        if let Ok(file) = fs::File::open(path) {
            let mut information = ByHandleFileInformation {
                file_attributes: 0,
                creation_time: FileTime {
                    low_date_time: 0,
                    high_date_time: 0,
                },
                last_access_time: FileTime {
                    low_date_time: 0,
                    high_date_time: 0,
                },
                last_write_time: FileTime {
                    low_date_time: 0,
                    high_date_time: 0,
                },
                volume_serial_number: 0,
                file_size_high: 0,
                file_size_low: 0,
                number_of_links: 0,
                file_index_high: 0,
                file_index_low: 0,
            };
            let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
            if ok != 0 {
                let index = (u64::from(information.file_index_high) << 32)
                    | u64::from(information.file_index_low);
                return format!("win:{:08x}:{index:016x}", information.volume_serial_number);
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return format!("unix:{:x}:{:x}", metadata.dev(), metadata.ino());
    }
    format!("path:{}", normalized_path(path))
}

fn candidates_physical_total(artifacts: &[ModelArtifact]) -> u64 {
    let mut sizes = HashMap::<String, u64>::new();
    for file in artifacts.iter().flat_map(|artifact| &artifact.files) {
        if let Some(identity) = &file.file_identity {
            sizes.entry(identity.clone()).or_insert(file.size_bytes);
        }
    }
    sizes.values().copied().sum()
}

#[tauri::command]
pub fn scan_model_artifacts_command(
    roots: Vec<String>,
    consumers: Vec<ArtifactConsumer>,
) -> Result<ArtifactCatalog, String> {
    let roots = roots.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    scan_model_artifacts(&roots, &consumers)
}

#[tauri::command]
pub fn preview_model_artifact_removal(
    roots: Vec<String>,
    consumers: Vec<ArtifactConsumer>,
    artifact_id: String,
) -> Result<ArtifactRemovalPreview, String> {
    let catalog = scan_model_artifacts(
        &roots.into_iter().map(PathBuf::from).collect::<Vec<_>>(),
        &consumers,
    )?;
    preview_artifact_removal(&catalog, &artifact_id, &consumers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!("aplot-artifacts-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn download_staging_is_skipped_as_a_root_and_nested_directory() {
        let root = fixture();
        let staging = root.join(".aplot-staging").join("download-1");
        fs::create_dir_all(&staging).unwrap();
        fs::write(root.join("ready.gguf"), b"ready").unwrap();
        fs::write(staging.join("partial.gguf"), b"partial").unwrap();
        let staging_consumer = ArtifactConsumer {
            id: "download:1".into(),
            kind: "download".into(),
            path: staging.join("partial.gguf").to_string_lossy().into_owned(),
            active: false,
        };

        let catalog = scan_model_artifacts(&[root.clone()], &[staging_consumer.clone()]).unwrap();
        assert!(catalog
            .artifacts
            .iter()
            .flat_map(|artifact| &artifact.files)
            .all(|file| !crate::domain::paths::is_aplot_staging_path(Path::new(&file.path))));
        assert!(catalog.missing_references.is_empty());
        let staging_catalog = scan_model_artifacts(&[root.join(".aplot-staging")], &[]).unwrap();
        assert!(staging_catalog.artifacts.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retired_formats_are_ignored_unless_a_saved_profile_references_them() {
        let root = fixture();
        let retired_model = root.join("legacy.infernix");
        fs::write(&retired_model, b"legacy model data").unwrap();
        let legacy_store = root.join("old-engine/ollama");
        let manifest = legacy_store.join("manifests/registry.example/library/model/latest");
        let blob = legacy_store
            .join("blobs")
            .join(format!("sha256-{}", "a".repeat(64)));
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::create_dir_all(blob.parent().unwrap()).unwrap();
        fs::write(&manifest, br#"{"schemaVersion":2,"layers":[]}"#).unwrap();
        fs::write(&blob, b"legacy blob").unwrap();

        let unreferenced = scan_model_artifacts(&[root.clone()], &[]).unwrap();
        assert!(unreferenced.artifacts.is_empty());

        let legacy_consumer = ArtifactConsumer {
            id: "retired-profile".into(),
            kind: "profile".into(),
            path: display_path(&retired_model),
            active: false,
        };
        let referenced = scan_model_artifacts(&[root.clone()], &[legacy_consumer.clone()]).unwrap();
        assert_eq!(referenced.artifacts.len(), 1);
        let artifact = &referenced.artifacts[0];
        assert_eq!(artifact.kind, ArtifactKind::OtherModel);
        assert_eq!(artifact.files[0].role, "legacyReference");
        assert_eq!(artifact.consumer_ids, vec!["retired-profile"]);
        assert_eq!(
            preview_artifact_removal(&referenced, &artifact.id, &[legacy_consumer])
                .unwrap()
                .candidate_file_count,
            0
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn groups_gguf_shards_and_keeps_auxiliary_artifacts_separate() {
        let root = fixture();
        fs::write(root.join("model-00001-of-00003.gguf"), b"one").unwrap();
        fs::write(root.join("model-00003-of-00003.gguf"), b"three").unwrap();
        fs::write(root.join("model-mmproj-f16.gguf"), b"vision").unwrap();
        fs::write(root.join("model-mtp.gguf"), b"draft").unwrap();
        let ngram = root.join("model-ngram");
        fs::create_dir_all(&ngram).unwrap();
        fs::write(ngram.join("weights.bin"), b"ngram").unwrap();

        let catalog = scan_model_artifacts(&[root.clone()], &[]).unwrap();
        assert_eq!(catalog.artifacts.len(), 4);
        let shards = catalog
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == ArtifactKind::PrimaryModel)
            .unwrap();
        assert_eq!(
            shards
                .files
                .iter()
                .filter(|file| file.state == ArtifactState::Complete)
                .count(),
            2
        );
        assert!(shards
            .files
            .iter()
            .any(|file| file.role == "missingShard" && file.path.contains("00002-of-00003")));
        assert_eq!(shards.state, ArtifactState::Incomplete);
        assert!(catalog
            .artifacts
            .iter()
            .any(|artifact| artifact.kind == ArtifactKind::Mmproj));
        assert!(catalog
            .artifacts
            .iter()
            .any(|artifact| artifact.kind == ArtifactKind::Mtp));
        assert!(catalog
            .artifacts
            .iter()
            .any(|artifact| artifact.kind == ArtifactKind::Ngram));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hardlinks_count_once_physically_and_preview_protects_shared_or_active_files() {
        let root = fixture();
        let first = root.join("model.gguf");
        let second = root.join("alias.gguf");
        fs::write(&first, b"same-physical-data").unwrap();
        fs::hard_link(&first, &second).unwrap();
        let consumer = ArtifactConsumer {
            id: "profile-a".into(),
            kind: "profile".into(),
            path: first.to_string_lossy().into_owned(),
            active: true,
        };
        let catalog =
            scan_model_artifacts(&[root.clone()], std::slice::from_ref(&consumer)).unwrap();
        assert_eq!(
            catalog.logical_bytes,
            2 * b"same-physical-data".len() as u64
        );
        assert_eq!(
            catalog.unique_physical_bytes,
            b"same-physical-data".len() as u64
        );
        assert!(catalog.artifacts.iter().all(|artifact| artifact
            .files
            .iter()
            .any(|file| !file.hardlink_aliases.is_empty())));
        let target = catalog
            .artifacts
            .iter()
            .find(|artifact| artifact.display_name == "model")
            .unwrap();
        let preview = preview_artifact_removal(&catalog, &target.id, &[consumer]).unwrap();
        assert!(preview.preview_only);
        assert_eq!(preview.candidate_file_count, 0);
        assert!(preview.files[0]
            .protected_by
            .iter()
            .any(|reason| reason == "shared by another artifact or hard-link alias"));
        assert!(
            first.exists() && second.exists(),
            "preview leaves model files untouched"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_profile_paths_are_reported_without_becoming_delete_candidates() {
        let root = fixture();
        let missing = root.join("not-downloaded.gguf");
        let consumer = ArtifactConsumer {
            id: "profile-missing".into(),
            kind: "profile".into(),
            path: missing.to_string_lossy().into_owned(),
            active: false,
        };
        let catalog =
            scan_model_artifacts(&[root.clone()], std::slice::from_ref(&consumer)).unwrap();
        assert_eq!(catalog.missing_references.len(), 1);
        let artifact = catalog
            .artifacts
            .iter()
            .find(|artifact| artifact.state == ArtifactState::Missing)
            .unwrap();
        let preview = preview_artifact_removal(&catalog, &artifact.id, &[consumer]).unwrap();
        assert_eq!(preview.candidate_file_count, 0);
        fs::remove_dir_all(root).unwrap();
    }
}
