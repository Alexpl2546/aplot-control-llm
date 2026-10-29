//! Vault binding: canonical roots, exclusions, path checks and a debounced watcher.
//! Nothing here writes inside a vault; the folder is only listed, read and watched.

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
};

/// Notes larger than this are listed as skipped rather than indexed.
pub const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;
/// A vault with more notes than this is indexed up to the limit and reported.
pub const MAX_NOTES: usize = 50_000;
const DEBOUNCE: Duration = Duration::from_millis(700);
/// Folders that belong to tools, not to the knowledge itself.
const DEFAULT_EXCLUDED: &[&str] = &["node_modules", "target", "__pycache__"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub exclusions: Vec<String>,
    pub added_at: String,
}

/// Canonical folder for a binding. Drive roots are refused: a whole disk is not a vault.
pub fn canonical_root(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("knowledge-folder".into());
    }
    let root = fs::canonicalize(trimmed).map_err(|_| "knowledge-folder")?;
    if !root.is_dir() {
        return Err("knowledge-folder".into());
    }
    if root.parent().is_none() || display(&root).trim_end_matches(['\\', '/']).ends_with(':') {
        return Err("knowledge-folder-root".into());
    }
    Ok(root)
}

/// Windows paths without the `\\?\` prefix that `canonicalize` adds.
pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

fn fold(text: &str) -> String {
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_owned()
    }
}

/// Component-wise containment that ignores letter case on Windows, so `C:\Notes`
/// and `c:\notes\a.md` agree while `C:\Notes2` stays outside `C:\Notes`.
pub fn is_inside(root: &Path, candidate: &Path) -> bool {
    let root: Vec<String> = parts(root).iter().map(|p| fold(p)).collect();
    let candidate: Vec<String> = parts(candidate).iter().map(|p| fold(p)).collect();
    candidate.len() >= root.len() && candidate[..root.len()] == root[..]
}

/// Components with the verbatim prefix removed, so `\\?\C:\a` and `C:\a` agree.
fn parts(path: &Path) -> Vec<String> {
    PathBuf::from(display(path))
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect()
}

/// Vault-relative path in forward-slash form, as Obsidian shows it.
pub fn relative(root: &Path, path: &Path) -> Option<String> {
    if !is_inside(root, path) {
        return None;
    }
    let rest = parts(path).split_off(parts(root).len());
    (!rest.is_empty()).then(|| rest.join("/"))
}

/// Resolve a vault-relative path to an existing file inside the vault. `..`,
/// absolute and drive-relative inputs are refused before touching the disk, and
/// the canonical target is checked again so junctions and symlinks cannot leave it.
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if rel.as_os_str().is_empty()
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err("knowledge-path".into());
    }
    let candidate = fs::canonicalize(root.join(rel)).map_err(|_| "knowledge-missing")?;
    if !is_inside(root, &candidate) {
        return Err("knowledge-path".into());
    }
    Ok(candidate)
}

/// Hidden folders (`.obsidian`, `.trash`, `.git`), tool folders and the user's
/// own exclusions are skipped. Exclusions are vault-relative folder prefixes.
pub fn is_excluded(rel: &str, exclusions: &[String]) -> bool {
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if parts
        .iter()
        .any(|p| p.starts_with('.') || DEFAULT_EXCLUDED.iter().any(|d| d.eq_ignore_ascii_case(p)))
    {
        return true;
    }
    let rel = fold(rel);
    exclusions.iter().any(|item| {
        let item = fold(
            item.trim()
                .trim_matches(['/', '\\'])
                .replace('\\', "/")
                .as_str(),
        );
        !item.is_empty() && (rel == item || rel.starts_with(&format!("{item}/")))
    })
}

/// Editor swap and temporary files that must never reach the index.
pub fn is_note(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let lower = name.to_ascii_lowercase();
    (lower.ends_with(".md") || lower.ends_with(".markdown"))
        && !name.starts_with('~')
        && !name.starts_with(".#")
}

pub fn normalize_exclusions(items: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for item in items.iter().take(100) {
        let item = item.trim().replace('\\', "/").trim_matches('/').to_owned();
        if item.is_empty() {
            continue;
        }
        if Path::new(&item)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("knowledge-exclusion".into());
        }
        if !out.contains(&item) {
            out.push(item);
        }
    }
    Ok(out)
}

#[derive(Debug)]
pub struct NoteFile {
    pub rel: String,
    pub path: PathBuf,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Default)]
pub struct Scan {
    pub notes: Vec<NoteFile>,
    pub skipped: usize,
    pub truncated: bool,
}

pub fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// One note by relative path, or `None` when it is gone, excluded or not a note.
pub fn note_at(root: &Path, rel: &str, exclusions: &[String]) -> Option<NoteFile> {
    if !is_note(rel) || is_excluded(rel, exclusions) {
        return None;
    }
    let path = resolve_inside(root, rel).ok()?;
    let meta = fs::symlink_metadata(&path).ok()?;
    meta.is_file().then(|| NoteFile {
        rel: rel.to_owned(),
        path,
        size: meta.len(),
        modified: modified_ms(&meta),
    })
}

/// Walk the vault without following links: junctions and symlinks are reported by
/// `symlink_metadata` as links on Windows and are skipped, so the walk cannot
/// escape the root or loop.
pub fn scan(root: &Path, exclusions: &[String]) -> Scan {
    let mut out = Scan::default();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || relative(root, entry.path())
                    .is_some_and(|rel| !is_excluded(&rel, exclusions) && !entry.path_is_symlink())
        });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(rel) = relative(root, entry.path()) else {
            continue;
        };
        if !is_note(&rel) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.len() > MAX_NOTE_BYTES {
            out.skipped += 1;
            continue;
        }
        if out.notes.len() >= MAX_NOTES {
            out.truncated = true;
            break;
        }
        out.notes.push(NoteFile {
            rel,
            path: entry.into_path(),
            size: meta.len(),
            modified: modified_ms(&meta),
        });
    }
    out
}

/// What the watcher asks the indexer to do after a quiet period.
#[derive(Debug, PartialEq)]
pub enum Change {
    Paths(Vec<String>),
    Rescan,
}

/// Watch a vault and call `on_change` once events have been quiet for a moment.
/// Bursts from editors and sync tools collapse into one batch; an overflowed or
/// unclear event asks for a full rescan instead. Dropping the returned watcher
/// stops the thread.
pub fn watch(
    root: PathBuf,
    exclusions: Vec<String>,
    on_change: impl Fn(Change) + Send + 'static,
) -> Result<notify::RecommendedWatcher, String> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("knowledge-watch".into())
        .spawn(move || {
            let mut pending = HashSet::<String>::new();
            let mut rescan = false;
            let mut last = None::<Instant>;
            loop {
                let wait = last.map_or(Duration::from_secs(3600), |t: Instant| {
                    DEBOUNCE.saturating_sub(t.elapsed())
                });
                match rx.recv_timeout(wait) {
                    Ok(Ok(event)) => {
                        if matches!(event.kind, EventKind::Access(_)) {
                            continue;
                        }
                        if event.need_rescan() || event.paths.is_empty() {
                            rescan = true;
                        }
                        for path in &event.paths {
                            // Removed paths cannot be canonicalized; compare as given.
                            if let Some(rel) = relative(&root, path) {
                                if !is_excluded(&rel, &exclusions) {
                                    pending.insert(rel);
                                }
                            }
                        }
                        last = Some(Instant::now());
                    }
                    Ok(Err(_)) => {
                        rescan = true;
                        last = Some(Instant::now());
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if last.take().is_none() {
                            continue;
                        }
                        // A renamed or removed folder arrives as one path without
                        // a note extension; only a rescan sees what moved.
                        if rescan || pending.iter().any(|rel| !is_note(rel)) {
                            on_change(Change::Rescan);
                        } else if !pending.is_empty() {
                            let mut paths: Vec<String> = pending.iter().cloned().collect();
                            paths.sort();
                            on_change(Change::Paths(paths));
                        }
                        pending.clear();
                        rescan = false;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aplot-vault-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn exclusions_cover_hidden_tool_and_user_folders() {
        let user = vec!["Archive".to_owned(), "Private/Diary".to_owned()];
        assert!(is_excluded(".obsidian/workspace.json", &user));
        assert!(is_excluded("Projects/.trash/a.md", &user));
        assert!(is_excluded("app/node_modules/x/readme.md", &user));
        assert!(is_excluded("Archive/old.md", &user));
        assert!(is_excluded("Private/Diary/2026.md", &user));
        assert!(!is_excluded("Private/Plans.md", &user));
        assert!(!is_excluded("Archived/new.md", &user));
        assert!(!is_excluded("Projects/Aplot/Overview.md", &user));
        if cfg!(windows) {
            assert!(is_excluded("archive/old.md", &user));
        }
        assert!(normalize_exclusions(&["../up".into()]).is_err());
        assert_eq!(
            normalize_exclusions(&[" \\Archive\\Old\\ ".into(), "".into()]).unwrap(),
            vec!["Archive/Old".to_owned()]
        );
    }

    #[test]
    fn paths_stay_inside_the_vault() {
        let base = temp("paths");
        let root = base.join("Vault");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::write(root.join("Notes/a.md"), "# A").unwrap();
        fs::write(base.join("secret.md"), "outside").unwrap();
        fs::create_dir_all(base.join("Vault2")).unwrap();
        fs::write(base.join("Vault2/b.md"), "sibling").unwrap();
        let root = fs::canonicalize(root).unwrap();
        assert!(resolve_inside(&root, "Notes/a.md").is_ok());
        assert_eq!(
            resolve_inside(&root, "../secret.md").unwrap_err(),
            "knowledge-path"
        );
        assert_eq!(
            resolve_inside(&root, "Notes/../../secret.md").unwrap_err(),
            "knowledge-path"
        );
        assert!(resolve_inside(&root, &display(&base.join("secret.md"))).is_err());
        assert!(resolve_inside(&root, "../Vault2/b.md").is_err());
        assert!(!is_inside(&root, &base.join("Vault2/b.md")));
        if cfg!(windows) {
            let upper = PathBuf::from(display(&root).to_uppercase());
            assert!(is_inside(&upper, &root.join("Notes/a.md")));
            assert!(resolve_inside(&root, "NOTES/A.MD").is_ok());
        }
        assert_eq!(
            relative(&root, &root.join("Notes").join("a.md")).unwrap(),
            "Notes/a.md"
        );
        assert!(canonical_root(&display(&root.join("Notes/a.md"))).is_err());
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn junctions_out_of_the_vault_are_neither_walked_nor_read() {
        let base = temp("junction");
        let root = base.join("Vault");
        let outside = base.join("Outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("inside.md"), "# Inside").unwrap();
        fs::write(outside.join("secret.md"), "# Secret").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("Link"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success(), "mklink /J failed");
        let root = fs::canonicalize(root).unwrap();
        let found: Vec<String> = scan(&root, &[]).notes.into_iter().map(|n| n.rel).collect();
        assert_eq!(found, vec!["inside.md".to_owned()]);
        assert_eq!(
            resolve_inside(&root, "Link/secret.md").unwrap_err(),
            "knowledge-path"
        );
        fs::remove_dir(root.join("Link")).unwrap();
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn scan_lists_only_notes_and_skips_temporary_files() {
        let root = temp("scan");
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(root.join(".obsidian/app.md"), "x").unwrap();
        fs::write(root.join("Projects/Plan.md"), "x").unwrap();
        fs::write(root.join("Projects/~Plan.md"), "x").unwrap();
        fs::write(root.join("Projects/image.png"), "x").unwrap();
        fs::write(root.join("Home.markdown"), "x").unwrap();
        let mut found: Vec<String> = scan(&root, &[]).notes.into_iter().map(|n| n.rel).collect();
        found.sort();
        assert_eq!(
            found,
            vec!["Home.markdown".to_owned(), "Projects/Plan.md".to_owned()]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn watcher_batches_external_edits() {
        let root = temp("watch");
        fs::write(root.join("note.md"), "one").unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = watch(root.clone(), vec![], move |change| {
            let _ = tx.send(change);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        for text in ["two", "three", "four"] {
            fs::write(root.join("note.md"), text).unwrap();
        }
        let change = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            matches!(&change, Change::Paths(paths) if paths == &vec!["note.md".to_owned()])
                || change == Change::Rescan,
            "{change:?}"
        );
        assert!(
            rx.recv_timeout(Duration::from_millis(1500)).is_err(),
            "burst was not merged"
        );
        drop(watcher);
        let _ = fs::remove_dir_all(root);
    }
}
