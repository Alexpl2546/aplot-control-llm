//! Aplot Knowledge, stage 1: bind Markdown vaults, keep a derived index current
//! and search or read notes. Vault files are only read; bindings live in the
//! application database and the index in `knowledge-index.sqlite3` beside it.

mod index;
mod markdown;
mod vault;

use crate::db::DbState;
use index::{Hit, Index, LinkedNote, SyncReport};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
pub use vault::Vault;

const VAULTS_KEY: &str = "knowledge.vaults";
const MAX_VAULTS: usize = 32;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// `indexing`, `ready`, `missing` or `error`.
    state: &'static str,
    error: Option<String>,
    report: Option<SyncReport>,
    indexed_at: Option<String>,
    watching: bool,
}

enum Job {
    Sync(String, Option<Vec<String>>),
}

struct Inner {
    index: Result<Mutex<Index>, String>,
    vaults: Mutex<Vec<Vault>>,
    progress: Mutex<HashMap<String, Progress>>,
    watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
}

pub struct KnowledgeState {
    inner: Arc<Inner>,
    jobs: mpsc::Sender<Job>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl KnowledgeState {
    /// Open the index next to the application database and resume every saved
    /// binding: changes made while Aplot was closed are found by a full rescan.
    pub fn start(index_path: Option<PathBuf>, vaults: Vec<Vault>) -> Self {
        let index = index_path
            .ok_or_else(|| "knowledge-index".to_owned())
            .and_then(|path| Index::open(&path))
            .map(Mutex::new);
        let inner = Arc::new(Inner {
            index,
            vaults: Mutex::new(vaults.clone()),
            progress: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
        });
        let (jobs, receiver) = mpsc::channel();
        let worker = inner.clone();
        let _ = std::thread::Builder::new()
            .name("knowledge-index".into())
            .spawn(move || run_jobs(worker, receiver));
        let state = Self { inner, jobs };
        for vault in vaults {
            state.activate(&vault);
        }
        state
    }

    fn activate(&self, vault: &Vault) {
        let root = PathBuf::from(&vault.path);
        if !root.is_dir() {
            lock(&self.inner.progress).insert(
                vault.id.clone(),
                Progress {
                    state: "missing",
                    ..Progress::default()
                },
            );
            return;
        }
        let jobs = self.jobs.clone();
        let id = vault.id.clone();
        let watcher = vault::watch(root, vault.exclusions.clone(), move |change| {
            let _ = jobs.send(Job::Sync(
                id.clone(),
                match change {
                    vault::Change::Paths(paths) => Some(paths),
                    vault::Change::Rescan => None,
                },
            ));
        });
        let watching = watcher.is_ok();
        if let Ok(watcher) = watcher {
            lock(&self.inner.watchers).insert(vault.id.clone(), watcher);
        }
        lock(&self.inner.progress).insert(
            vault.id.clone(),
            Progress {
                state: "indexing",
                watching,
                ..Progress::default()
            },
        );
        let _ = self.jobs.send(Job::Sync(vault.id.clone(), None));
    }

    fn deactivate(&self, id: &str) {
        lock(&self.inner.watchers).remove(id);
        lock(&self.inner.progress).remove(id);
    }

    fn index(&self) -> Result<&Mutex<Index>, String> {
        self.inner.index.as_ref().map_err(Clone::clone)
    }

    fn vault(&self, id: &str) -> Result<Vault, String> {
        lock(&self.inner.vaults)
            .iter()
            .find(|v| v.id == id)
            .cloned()
            .ok_or_else(|| "knowledge-vault-missing".into())
    }
}

/// One worker indexes all vaults in order. Jobs that queued up while it was busy
/// are merged per vault, and a full rescan absorbs any path list.
fn run_jobs(inner: Arc<Inner>, receiver: mpsc::Receiver<Job>) {
    while let Ok(first) = receiver.recv() {
        let mut merged: Vec<(String, Option<Vec<String>>)> = Vec::new();
        for Job::Sync(id, paths) in std::iter::once(first).chain(receiver.try_iter()) {
            match merged.iter_mut().find(|(existing, _)| *existing == id) {
                Some((_, current)) => {
                    *current = match (current.take(), paths) {
                        (Some(mut a), Some(b)) => {
                            a.extend(b);
                            a.sort();
                            a.dedup();
                            Some(a)
                        }
                        _ => None,
                    }
                }
                None => merged.push((id, paths)),
            }
        }
        for (id, paths) in merged {
            let Some(vault) = lock(&inner.vaults).iter().find(|v| v.id == id).cloned() else {
                continue;
            };
            let Ok(index) = inner.index.as_ref() else {
                continue;
            };
            if let Some(progress) = lock(&inner.progress).get_mut(&id) {
                progress.state = "indexing";
            }
            let root = PathBuf::from(&vault.path);
            let result = if root.is_dir() {
                index::sync(index, &id, &root, &vault.exclusions, paths.as_deref())
            } else {
                Err("knowledge-folder".into())
            };
            // The binding may have been removed while this vault was indexing.
            if !lock(&inner.vaults).iter().any(|v| v.id == id) {
                let _ = lock(index).remove_vault(&id);
                continue;
            }
            let mut progress = lock(&inner.progress);
            let entry = progress.entry(id).or_default();
            match result {
                Ok(report) => {
                    entry.state = "ready";
                    entry.error = None;
                    entry.report = Some(report);
                    entry.indexed_at = Some(chrono::Utc::now().to_rfc3339());
                }
                Err(error) => {
                    entry.state = if root.is_dir() { "error" } else { "missing" };
                    entry.error = Some(error);
                }
            }
        }
    }
}

pub fn load_vaults(conn: &Connection) -> Vec<Vault> {
    conn.query_row(
        "SELECT value_json FROM kv WHERE key = ?1",
        [VAULTS_KEY],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

fn save_vaults(conn: &Connection, vaults: &[Vault]) -> Result<(), String> {
    conn.execute(
        "INSERT INTO kv(key, value_json, updated_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        rusqlite::params![
            VAULTS_KEY,
            serde_json::to_string(vaults).map_err(|e| e.to_string())?,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// `obsidian://open?path=` with every byte outside the unreserved set encoded.
pub fn obsidian_uri(path: &Path) -> String {
    let mut out = String::from("obsidian://open?path=");
    for byte in vault::display(path).bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[tauri::command]
pub async fn knowledge_bind(
    db: State<'_, DbState>,
    knowledge: State<'_, KnowledgeState>,
    path: String,
    exclusions: Option<Vec<String>>,
) -> Result<Vault, String> {
    let root = vault::canonical_root(&path)?;
    let exclusions = exclusions
        .map(|items| vault::normalize_exclusions(&items))
        .transpose()?;
    let conn = db.0.lock().await;
    let mut vaults = load_vaults(&conn);
    let existing = vaults.iter().position(|v| {
        vault::is_inside(Path::new(&v.path), &root) && vault::is_inside(&root, Path::new(&v.path))
    });
    if let Some(position) = existing {
        if let Some(exclusions) = exclusions {
            vaults[position].exclusions = exclusions;
            save_vaults(&conn, &vaults)?;
            let updated = vaults[position].clone();
            *lock(&knowledge.inner.vaults) = vaults;
            knowledge.deactivate(&updated.id);
            knowledge.activate(&updated);
            return Ok(updated);
        }
        return Ok(vaults[position].clone());
    }
    // Nested vaults would index the same notes twice under two identities.
    if vaults.iter().any(|v| {
        vault::is_inside(Path::new(&v.path), &root) || vault::is_inside(&root, Path::new(&v.path))
    }) {
        return Err("knowledge-overlap".into());
    }
    if vaults.len() >= MAX_VAULTS {
        return Err("knowledge-limit".into());
    }
    let created = Vault {
        id: uuid::Uuid::new_v4().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| vault::display(&root)),
        path: vault::display(&root),
        exclusions: exclusions.unwrap_or_default(),
        added_at: chrono::Utc::now().to_rfc3339(),
    };
    vaults.push(created.clone());
    save_vaults(&conn, &vaults)?;
    drop(conn);
    *lock(&knowledge.inner.vaults) = vaults;
    knowledge.activate(&created);
    Ok(created)
}

/// Forget a binding and its index rows. The folder itself is never touched.
#[tauri::command]
pub async fn knowledge_unbind(
    db: State<'_, DbState>,
    knowledge: State<'_, KnowledgeState>,
    vault_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().await;
    let mut vaults = load_vaults(&conn);
    vaults.retain(|v| v.id != vault_id);
    save_vaults(&conn, &vaults)?;
    drop(conn);
    *lock(&knowledge.inner.vaults) = vaults;
    knowledge.deactivate(&vault_id);
    if let Ok(index) = knowledge.index() {
        lock(index).remove_vault(&vault_id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn knowledge_reindex(
    knowledge: State<'_, KnowledgeState>,
    vault_id: String,
) -> Result<(), String> {
    let vault = knowledge.vault(&vault_id)?;
    knowledge.deactivate(&vault.id);
    knowledge.activate(&vault);
    Ok(())
}

#[tauri::command]
pub fn knowledge_status(knowledge: State<'_, KnowledgeState>) -> Value {
    status(&knowledge)
}

fn status(knowledge: &KnowledgeState) -> Value {
    let vaults = lock(&knowledge.inner.vaults).clone();
    let progress = lock(&knowledge.inner.progress).clone();
    let rows: Vec<Value> = vaults
        .iter()
        .map(|v| {
            let (documents, chunks) = knowledge
                .index()
                .map(|index| lock(index).counts(&v.id))
                .unwrap_or_default();
            let p = progress.get(&v.id).cloned().unwrap_or(Progress {
                state: "missing",
                ..Progress::default()
            });
            json!({
                "vault": v,
                "documents": documents,
                "chunks": chunks,
                "obsidian": Path::new(&v.path).join(".obsidian").is_dir(),
                "state": p.state,
                "error": p.error,
                "report": p.report,
                "indexedAt": p.indexed_at,
                "watching": p.watching,
            })
        })
        .collect();
    json!({
        "available": knowledge.index().is_ok(),
        "error": knowledge.index().err(),
        "vaults": rows,
    })
}

#[tauri::command]
pub async fn knowledge_search(
    knowledge: State<'_, KnowledgeState>,
    query: String,
    vault_ids: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<Vec<Hit>, String> {
    let inner = knowledge.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let index = inner.index.as_ref().map_err(Clone::clone)?;
        let result =
            lock(index).search(&query, &vault_ids.unwrap_or_default(), limit.unwrap_or(30));
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    vault_id: String,
    vault_name: String,
    path: String,
    absolute_path: String,
    obsidian_uri: String,
    title: String,
    properties: serde_json::Map<String, Value>,
    tags: Vec<String>,
    aliases: Vec<String>,
    body: String,
    body_line: usize,
    outline: Vec<Value>,
    links: Vec<Value>,
    backlinks: Vec<LinkedNote>,
    size: u64,
    modified: i64,
}

fn read_note(vault: &Vault, rel: &str) -> Result<NoteView, String> {
    let root = PathBuf::from(&vault.path);
    let rel = rel.replace('\\', "/");
    if !vault::is_note(&rel) || vault::is_excluded(&rel, &vault.exclusions) {
        return Err("knowledge-path".into());
    }
    let path = vault::resolve_inside(&root, &rel)?;
    let meta = fs::metadata(&path).map_err(|_| "knowledge-missing")?;
    if !meta.is_file() || meta.len() > vault::MAX_NOTE_BYTES {
        return Err("knowledge-limit".into());
    }
    let bytes = fs::read(&path).map_err(|_| "knowledge-missing")?;
    let text = String::from_utf8_lossy(&bytes);
    let stem = rel.rsplit('/').next().unwrap_or(&rel);
    let note = markdown::parse(&text, stem.rsplit_once('.').map_or(stem, |(s, _)| s));
    Ok(NoteView {
        vault_id: vault.id.clone(),
        vault_name: vault.name.clone(),
        path: rel,
        absolute_path: vault::display(&path),
        obsidian_uri: obsidian_uri(&path),
        title: note.title,
        properties: note.properties,
        tags: note.tags,
        aliases: note.aliases,
        outline: note
            .chunks
            .iter()
            .filter(|c| c.level > 0)
            .map(|c| json!({"heading": c.heading.rsplit(" › ").next().unwrap_or(&c.heading), "level": c.level, "line": c.line_start}))
            .collect(),
        links: note
            .links
            .iter()
            .map(|l| json!({"target": l.target, "kind": l.kind, "line": l.line}))
            .collect(),
        body: note.body,
        body_line: note.body_line,
        backlinks: Vec::new(),
        size: meta.len(),
        modified: vault::modified_ms(&meta),
    })
}

#[tauri::command]
pub async fn knowledge_read(
    knowledge: State<'_, KnowledgeState>,
    vault_id: String,
    path: String,
) -> Result<NoteView, String> {
    let vault = knowledge.vault(&vault_id)?;
    let inner = knowledge.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut view = read_note(&vault, &path)?;
        if let Ok(index) = inner.index.as_ref() {
            view.backlinks = lock(index)
                .backlinks(&vault.id, &view.path)
                .unwrap_or_default();
        }
        Ok(view)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a note in Obsidian. The URI is built here from a checked vault path, so
/// the window never needs permission to open arbitrary URL schemes.
#[tauri::command]
pub async fn knowledge_open_obsidian(
    app: AppHandle,
    knowledge: State<'_, KnowledgeState>,
    vault_id: String,
    path: String,
) -> Result<(), String> {
    let vault = knowledge.vault(&vault_id)?;
    let view = read_note(&vault, &path)?;
    app.opener()
        .open_url(view.obsidian_uri, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obsidian_links_encode_the_absolute_path() {
        let uri = obsidian_uri(Path::new(r"\\?\C:\Notes\Мой vault\План #1.md"));
        assert_eq!(
            uri,
            "obsidian://open?path=C%3A%5CNotes%5C%D0%9C%D0%BE%D0%B9%20vault%5C%D0%9F%D0%BB%D0%B0%D0%BD%20%231.md"
        );
    }

    #[test]
    fn bound_vault_is_indexed_watched_and_reindexed_after_an_external_edit() {
        let dir =
            std::env::temp_dir().join(format!("aplot-knowledge-state-{}", uuid::Uuid::new_v4()));
        let notes = dir.join("Vault");
        fs::create_dir_all(notes.join(".obsidian")).unwrap();
        fs::write(notes.join("Заметка.md"), "# Заметка\nПервая версия.\n").unwrap();
        let root = vault::canonical_root(&notes.to_string_lossy()).unwrap();
        let vault = Vault {
            id: "v1".into(),
            name: "Vault".into(),
            path: vault::display(&root),
            exclusions: vec![],
            added_at: String::new(),
        };
        let state = KnowledgeState::start(
            Some(dir.join("knowledge-index.sqlite3")),
            vec![vault.clone()],
        );
        let wait = |query: &str| {
            for _ in 0..100 {
                let hits = lock(state.index().unwrap()).search(query, &[], 10).unwrap();
                if !hits.is_empty() {
                    return hits;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            panic!("no hit for {query}");
        };
        assert_eq!(wait("первая")[0].path, "Заметка.md");
        let before = fs::read_dir(&root).unwrap().count();
        fs::write(
            root.join("Заметка.md"),
            "# Заметка\nВторая редакция извне.\n",
        )
        .unwrap();
        assert_eq!(wait("редакция")[0].title, "Заметка");
        assert!(lock(state.index().unwrap())
            .search("первая", &[], 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            before,
            "no files were added to the vault"
        );
        let status = status(&state);
        assert_eq!(status["vaults"][0]["obsidian"], true);
        assert_eq!(status["vaults"][0]["documents"], 1);
        let view = read_note(&vault, "Заметка.md").unwrap();
        assert_eq!(view.title, "Заметка");
        assert!(view.obsidian_uri.starts_with("obsidian://open?path="));
        assert!(read_note(&vault, "../Vault/Заметка.md").is_err());
        assert!(read_note(&vault, ".obsidian/app.json").is_err());
        drop(state);
        let _ = fs::remove_dir_all(dir);
    }
}
