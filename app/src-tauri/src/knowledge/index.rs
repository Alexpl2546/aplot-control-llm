//! Derived search index in its own `knowledge-index.sqlite3`. It can be deleted
//! and rebuilt from the vault at any time, so it holds no decisions or permissions.

use super::{markdown, vault};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::Path, sync::Mutex};

const SCHEMA: &str = "1";
const BATCH: usize = 64;

pub struct Index {
    conn: Connection,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub indexed: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub failed: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub vault_id: String,
    pub path: String,
    pub title: String,
    pub heading: String,
    pub line: i64,
    pub snippet: String,
    /// `exact` whole words, `prefix` word starts, `partial` any part of a word.
    pub matched: &'static str,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedNote {
    pub vault_id: String,
    pub path: String,
    pub title: String,
}

struct Prepared {
    rel: String,
    size: i64,
    modified: i64,
    hash: String,
    note: markdown::Note,
}

/// Lowercase and fold `ё` to `е` one character at a time, so offsets in the
/// folded text match the original. Both indexes and every query use it.
pub fn fold_chars(text: &str) -> Vec<char> {
    text.chars()
        .map(|c| match c {
            'ё' | 'Ё' => 'е',
            _ => {
                let mut lower = c.to_lowercase();
                match (lower.next(), lower.next()) {
                    (Some(l), None) => l,
                    _ => c,
                }
            }
        })
        .collect()
}

fn fold(text: &str) -> String {
    fold_chars(text).into_iter().collect()
}

/// Query words: letters, digits and `_`, at most 12 of them.
pub fn query_terms(query: &str) -> Vec<String> {
    let folded = fold(query.chars().take(200).collect::<String>().as_str());
    let mut terms: Vec<String> = Vec::new();
    for word in folded.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let word = word.trim_matches('_');
        if !word.is_empty() && !terms.iter().any(|t| t == word) && terms.len() < 12 {
            terms.push(word.to_owned());
        }
    }
    terms
}

fn quoted(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

impl Index {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::init(Connection::open(path).map_err(|e| format!("knowledge-index: {e}"))?)
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(|e| e.to_string())?;
        let schema: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key='schema'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if schema.as_deref() != Some(SCHEMA) {
            // A derived index of another shape is rebuilt rather than migrated.
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS chunks_ad;
                 DROP TABLE IF EXISTS chunks_words; DROP TABLE IF EXISTS chunks_trigram;
                 DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS documents;",
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS documents(
               id INTEGER PRIMARY KEY,
               vault_id TEXT NOT NULL,
               path TEXT NOT NULL,
               title TEXT NOT NULL,
               aplot_id TEXT,
               properties_json TEXT NOT NULL,
               tags_json TEXT NOT NULL,
               aliases_json TEXT NOT NULL,
               hash TEXT NOT NULL,
               size INTEGER NOT NULL,
               modified INTEGER NOT NULL,
               indexed_at TEXT NOT NULL,
               UNIQUE(vault_id, path)
             );
             CREATE TABLE IF NOT EXISTS chunks(
               id INTEGER PRIMARY KEY,
               document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
               ord INTEGER NOT NULL,
               heading TEXT NOT NULL,
               level INTEGER NOT NULL,
               line_start INTEGER NOT NULL,
               line_end INTEGER NOT NULL,
               text TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
             CREATE TABLE IF NOT EXISTS links(
               document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
               target TEXT NOT NULL,
               kind TEXT NOT NULL,
               line INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS links_document ON links(document_id);
             CREATE INDEX IF NOT EXISTS links_target ON links(target COLLATE NOCASE);
             CREATE VIRTUAL TABLE IF NOT EXISTS chunks_words
               USING fts5(title, heading, body, tokenize='unicode61 remove_diacritics 2');
             CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram
               USING fts5(title, heading, body, tokenize='trigram');
             CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
               DELETE FROM chunks_words WHERE rowid = old.id;
               DELETE FROM chunks_trigram WHERE rowid = old.id;
             END;
             INSERT INTO meta(key, value) VALUES('schema', '1')
               ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { conn })
    }

    fn known(&self, vault_id: &str) -> Result<HashMap<String, (i64, i64)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, size, modified FROM documents WHERE vault_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([vault_id], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    fn hash_of(&self, vault_id: &str, rel: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT hash FROM documents WHERE vault_id = ?1 AND path = ?2",
                [vault_id, rel],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Same content under a new size or time only refreshes the stamps.
    fn touch(&self, vault_id: &str, item: &Prepared) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE documents SET size = ?3, modified = ?4 WHERE vault_id = ?1 AND path = ?2",
                params![vault_id, item.rel, item.size, item.modified],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn write(
        &mut self,
        vault_id: &str,
        items: &[Prepared],
        removed: &[String],
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for rel in removed {
            tx.execute(
                "DELETE FROM documents WHERE vault_id = ?1 AND path = ?2",
                [vault_id, rel.as_str()],
            )
            .map_err(|e| e.to_string())?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        for item in items {
            let note = &item.note;
            tx.execute(
                "DELETE FROM documents WHERE vault_id = ?1 AND path = ?2",
                [vault_id, item.rel.as_str()],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO documents(vault_id, path, title, aplot_id, properties_json, tags_json, aliases_json, hash, size, modified, indexed_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    vault_id,
                    item.rel,
                    note.title,
                    note.aplot_id,
                    serde_json::Value::Object(note.properties.clone()).to_string(),
                    serde_json::to_string(&note.tags).unwrap_or_default(),
                    serde_json::to_string(&note.aliases).unwrap_or_default(),
                    item.hash,
                    item.size,
                    item.modified,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
            let document = tx.last_insert_rowid();
            // Title, aliases, tags and the file name are searchable on every section.
            let stem = item.rel.rsplit('/').next().unwrap_or(&item.rel);
            let meta = fold(&format!(
                "{} {} {} {}",
                note.title,
                note.aliases.join(" "),
                note.tags.join(" "),
                stem.rsplit_once('.').map_or(stem, |(s, _)| s)
            ));
            for (ord, chunk) in note.chunks.iter().enumerate() {
                tx.execute(
                    "INSERT INTO chunks(document_id, ord, heading, level, line_start, line_end, text) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![document, ord as i64, chunk.heading, chunk.level, chunk.line_start as i64, chunk.line_end as i64, chunk.text],
                )
                .map_err(|e| e.to_string())?;
                let row = tx.last_insert_rowid();
                let (heading, body) = (fold(&chunk.heading), fold(&chunk.text));
                for table in ["chunks_words", "chunks_trigram"] {
                    tx.execute(
                        &format!("INSERT INTO {table}(rowid, title, heading, body) VALUES(?1, ?2, ?3, ?4)"),
                        params![row, meta, heading, body],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            for link in &note.links {
                tx.execute(
                    "INSERT INTO links(document_id, target, kind, line) VALUES(?1, ?2, ?3, ?4)",
                    params![document, link.target, link.kind, link.line as i64],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn remove_vault(&mut self, vault_id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM documents WHERE vault_id = ?1", [vault_id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn counts(&self, vault_id: &str) -> (i64, i64) {
        self.conn
            .query_row(
                "SELECT (SELECT count(*) FROM documents WHERE vault_id = ?1),
                        (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.vault_id = ?1)",
                [vault_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or_default()
    }

    /// Exact words first, then word starts, then any part of a word via trigrams.
    /// Each note appears once, with its best section.
    pub fn search(
        &self,
        query: &str,
        vault_ids: &[String],
        limit: usize,
    ) -> Result<Vec<Hit>, String> {
        let terms = query_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 100);
        let exact = terms
            .iter()
            .map(|t| quoted(t))
            .collect::<Vec<_>>()
            .join(" ");
        let prefix = terms
            .iter()
            .map(|t| format!("{}*", quoted(t)))
            .collect::<Vec<_>>()
            .join(" ");
        let long: Vec<&String> = terms.iter().filter(|t| t.chars().count() >= 3).collect();
        let partial = long
            .iter()
            .map(|t| quoted(t))
            .collect::<Vec<_>>()
            .join(" AND ");
        let vaults = format!(",{},", vault_ids.join(","));
        let mut best: HashMap<i64, (usize, f64, i64)> = HashMap::new();
        let tiers: [(&str, &str); 3] = [
            ("chunks_words", exact.as_str()),
            ("chunks_words", prefix.as_str()),
            ("chunks_trigram", partial.as_str()),
        ];
        for (tier, (table, expression)) in tiers.iter().enumerate() {
            // Partial matching only adds notes when every short word also matched.
            if expression.is_empty() || (tier == 2 && long.len() != terms.len()) {
                continue;
            }
            let sql = format!(
                "SELECT c.document_id, c.id, bm25({table}, 8.0, 4.0, 1.0) AS rank
                 FROM {table} JOIN chunks c ON c.id = {table}.rowid JOIN documents d ON d.id = c.document_id
                 WHERE {table} MATCH ?1 AND (?2 = ',,' OR instr(?2, ',' || d.vault_id || ',') > 0)
                 ORDER BY rank LIMIT 400"
            );
            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![expression, vaults], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, f64>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (document, chunk, rank) = row.map_err(|e| e.to_string())?;
                best.entry(document)
                    .and_modify(|current| {
                        if (tier, rank) < (current.0, current.1) {
                            *current = (tier, rank, chunk);
                        }
                    })
                    .or_insert((tier, rank, chunk));
            }
            if best.len() >= limit * 2 {
                break;
            }
        }
        let mut ordered: Vec<(usize, f64, i64)> = best.into_values().collect();
        ordered.sort_by(|a, b| {
            (a.0, a.1)
                .partial_cmp(&(b.0, b.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut hits = Vec::new();
        for (tier, _, chunk) in ordered.into_iter().take(limit) {
            let (vault_id, path, title, heading, line, text, tags): (String, String, String, String, i64, String, String) = self
                .conn
                .query_row(
                    "SELECT d.vault_id, d.path, d.title, c.heading, c.line_start, c.text, d.tags_json
                     FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?1",
                    [chunk],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                )
                .map_err(|e| e.to_string())?;
            hits.push(Hit {
                vault_id,
                path,
                title,
                heading,
                line,
                snippet: snippet(&text, &terms),
                matched: ["exact", "prefix", "partial"][tier],
                tags: serde_json::from_str(&tags).unwrap_or_default(),
            });
        }
        Ok(hits)
    }

    /// Notes in the same vault whose wiki or Markdown links point at `rel`.
    pub fn backlinks(&self, vault_id: &str, rel: &str) -> Result<Vec<LinkedNote>, String> {
        let without_ext = rel.rsplit_once('.').map_or(rel, |(s, _)| s);
        let stem = without_ext.rsplit('/').next().unwrap_or(without_ext);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT DISTINCT d.vault_id, d.path, d.title FROM links l JOIN documents d ON d.id = l.document_id
                 WHERE d.vault_id = ?1 AND d.path <> ?2 AND l.kind <> 'url'
                   AND (l.target = ?2 COLLATE NOCASE OR l.target = ?3 COLLATE NOCASE OR l.target = ?4 COLLATE NOCASE)
                 ORDER BY d.title LIMIT 100",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![vault_id, rel, without_ext, stem], |r| {
                Ok(LinkedNote {
                    vault_id: r.get(0)?,
                    path: r.get(1)?,
                    title: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }
}

/// About 220 characters around the first matched word, without the heading line.
fn snippet(text: &str, terms: &[String]) -> String {
    let body = match text.split_once('\n') {
        Some((first, rest)) if first.trim_start().starts_with('#') => rest,
        _ => text,
    };
    let chars: Vec<char> = body.chars().collect();
    let folded = fold_chars(body);
    let at = terms
        .iter()
        .filter_map(|term| {
            let needle: Vec<char> = term.chars().collect();
            folded
                .windows(needle.len())
                .position(|w| w == needle.as_slice())
        })
        .min()
        .unwrap_or(0);
    let start = at.saturating_sub(70);
    let end = (start + 220).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        out.insert(0, '…');
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}

fn prepare(note: &vault::NoteFile) -> Result<Prepared, String> {
    let bytes = fs::read(&note.path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > vault::MAX_NOTE_BYTES {
        return Err("too large".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let stem = note.rel.rsplit('/').next().unwrap_or(&note.rel);
    let stem = stem.rsplit_once('.').map_or(stem, |(s, _)| s);
    Ok(Prepared {
        rel: note.rel.clone(),
        size: note.size as i64,
        modified: note.modified,
        hash: format!("{:x}", Sha256::digest(&bytes)),
        note: markdown::parse(&text, stem),
    })
}

fn lock(index: &Mutex<Index>) -> std::sync::MutexGuard<'_, Index> {
    index
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Bring one vault's index in line with the disk. Files are read and parsed
/// outside the lock, so searches keep working during a large first scan.
/// Unchanged size and time skip the read; same content under new stamps skips
/// the rewrite because updates follow the text hash.
pub fn sync(
    index: &Mutex<Index>,
    vault_id: &str,
    root: &Path,
    exclusions: &[String],
    change: Option<&[String]>,
) -> Result<SyncReport, String> {
    let mut report = SyncReport::default();
    let known = lock(index).known(vault_id)?;
    let (candidates, removed): (Vec<vault::NoteFile>, Vec<String>) = match change {
        None => {
            let scan = vault::scan(root, exclusions);
            report.skipped = scan.skipped;
            report.truncated = scan.truncated;
            let present: std::collections::HashSet<&str> =
                scan.notes.iter().map(|n| n.rel.as_str()).collect();
            let removed = known
                .keys()
                .filter(|rel| !present.contains(rel.as_str()))
                .cloned()
                .collect();
            (scan.notes, removed)
        }
        Some(paths) => {
            let mut found = Vec::new();
            let mut removed = Vec::new();
            for rel in paths {
                match vault::note_at(root, rel, exclusions) {
                    Some(note) if note.size <= vault::MAX_NOTE_BYTES => found.push(note),
                    Some(_) => {
                        report.skipped += 1;
                        if known.contains_key(rel) {
                            removed.push(rel.clone());
                        }
                    }
                    None if known.contains_key(rel) => removed.push(rel.clone()),
                    None => {}
                }
            }
            (found, removed)
        }
    };
    let mut batch = Vec::new();
    let mut pending_removed = removed;
    report.removed = pending_removed.len();
    for note in candidates {
        if known.get(&note.rel) == Some(&(note.size as i64, note.modified)) {
            report.unchanged += 1;
            continue;
        }
        match prepare(&note) {
            Ok(item) => {
                let guard = lock(index);
                if guard.hash_of(vault_id, &item.rel).as_deref() == Some(item.hash.as_str()) {
                    guard.touch(vault_id, &item)?;
                    report.unchanged += 1;
                    continue;
                }
                drop(guard);
                batch.push(item);
            }
            Err(_) => report.failed += 1,
        }
        if batch.len() >= BATCH {
            report.indexed += batch.len();
            lock(index).write(
                vault_id,
                &std::mem::take(&mut batch),
                &std::mem::take(&mut pending_removed),
            )?;
        }
    }
    report.indexed += batch.len();
    if !batch.is_empty() || !pending_removed.is_empty() {
        lock(index).write(vault_id, &batch, &pending_removed)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vault_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aplot-knowledge-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("Projects/Aplot/Decisions")).unwrap();
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::write(
            dir.join("Projects/Aplot/Decisions/Поиск.md"),
            "---\naplot_id: note-search\ntags: [architecture]\naliases: [Search decision]\n---\n# Решение по поиску\nДля русского текста используем два индекса.\n## Причины\nТриграммы находят решения по части слова. Ёлка и ежи.\n",
        )
        .unwrap();
        fs::write(
            dir.join("Projects/Aplot/Overview.md"),
            "# Overview\nAplot Control is a desktop app. The knowledge base links to [[Поиск]].\n\n```rust\nfn knowledge_bind() {}\n```\n",
        )
        .unwrap();
        fs::write(dir.join(".obsidian/hidden.md"), "# Hidden решение").unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn titles(hits: &[Hit]) -> Vec<&str> {
        hits.iter().map(|h| h.title.as_str()).collect()
    }

    #[test]
    fn russian_english_partial_and_exact_queries_find_notes() {
        let dir = vault_dir();
        let index = Mutex::new(Index::memory());
        let report = sync(&index, "v", &dir, &[], None).unwrap();
        assert_eq!(report.indexed, 2);
        let index = lock(&index);
        let search = |q: &str| index.search(q, &[], 20).unwrap();
        assert_eq!(titles(&search("индекса")), vec!["Решение по поиску"]);
        assert_eq!(search("индекса")[0].matched, "exact");
        // Part of a word: «решен» finds «решения», «Решение».
        let partial = search("решен");
        assert_eq!(titles(&partial), vec!["Решение по поиску"]);
        assert_eq!(search("ешени")[0].matched, "partial");
        assert_eq!(titles(&search("desktop")), vec!["Overview"]);
        assert_eq!(titles(&search("knowledge_bind")), vec!["Overview"]);
        assert_eq!(
            titles(&search("Search decision")),
            vec!["Решение по поиску"]
        );
        assert_eq!(
            titles(&search("елка")),
            vec!["Решение по поиску"],
            "ё and е match"
        );
        assert_eq!(titles(&search("ЁЛКА")), vec!["Решение по поиску"]);
        assert!(search("Hidden").is_empty(), ".obsidian is not indexed");
        assert!(search("").is_empty());
        assert!(
            search("\"*)(").is_empty(),
            "query syntax is never passed through"
        );
        let hit = &search("Триграммы")[0];
        assert_eq!(hit.heading, "Решение по поиску › Причины");
        assert_eq!(hit.path, "Projects/Aplot/Decisions/Поиск.md");
        assert_eq!(hit.line, 8);
        assert!(hit.snippet.starts_with("Триграммы"), "{}", hit.snippet);
        assert_eq!(hit.tags, vec!["architecture"]);
        assert!(index
            .search("desktop", &["other".into()], 20)
            .unwrap()
            .is_empty());
        assert_eq!(
            index
                .backlinks("v", "Projects/Aplot/Decisions/Поиск.md")
                .unwrap()[0]
                .title,
            "Overview"
        );
        drop(index);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exact_matches_rank_before_partial_ones() {
        let dir =
            std::env::temp_dir().join(format!("aplot-knowledge-rank-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("a.md"),
            "# Partial\nПереиндексация после правки.\n",
        )
        .unwrap();
        fs::write(dir.join("b.md"), "# Exact\nИндекс перестраивается.\n").unwrap();
        let index = Mutex::new(Index::memory());
        sync(&index, "v", &dir, &[], None).unwrap();
        let hits = lock(&index).search("индекс", &[], 20).unwrap();
        assert_eq!(titles(&hits), vec!["Exact", "Partial"]);
        assert_eq!((hits[0].matched, hits[1].matched), ("exact", "partial"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn edits_removals_and_exclusions_update_the_index_without_touching_files() {
        let dir = vault_dir();
        let index = Mutex::new(Index::memory());
        sync(&index, "v", &dir, &[], None).unwrap();
        let note = dir.join("Projects/Aplot/Overview.md");
        let before = fs::read(&note).unwrap();
        let again = sync(&index, "v", &dir, &[], None).unwrap();
        assert_eq!((again.indexed, again.unchanged), (0, 2));
        assert_eq!(
            fs::read(&note).unwrap(),
            before,
            "indexing never writes notes"
        );

        fs::write(&note, "# Overview\nОбновлённый обзор приложения.\n").unwrap();
        let changed = sync(
            &index,
            "v",
            &dir,
            &[],
            Some(&["Projects/Aplot/Overview.md".to_owned()]),
        )
        .unwrap();
        assert_eq!(changed.indexed, 1);
        assert!(lock(&index).search("desktop", &[], 20).unwrap().is_empty());
        assert_eq!(
            titles(&lock(&index).search("обзор", &[], 20).unwrap()),
            vec!["Overview"]
        );
        assert_eq!(lock(&index).counts("v").0, 2);

        fs::remove_file(&note).unwrap();
        let removed = sync(
            &index,
            "v",
            &dir,
            &[],
            Some(&["Projects/Aplot/Overview.md".to_owned()]),
        )
        .unwrap();
        assert_eq!(removed.removed, 1);
        assert!(lock(&index).search("обзор", &[], 20).unwrap().is_empty());

        let excluded = sync(&index, "v", &dir, &["Projects".to_owned()], None).unwrap();
        assert_eq!(excluded.removed, 1);
        assert_eq!(lock(&index).counts("v"), (0, 0));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn index_file_is_rebuilt_on_schema_change() {
        let dir = std::env::temp_dir().join(format!("aplot-knowledge-db-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("knowledge-index.sqlite3");
        {
            let index = Index::open(&path).unwrap();
            index
                .conn
                .execute("UPDATE meta SET value = '0' WHERE key = 'schema'", [])
                .unwrap();
        }
        assert!(Index::open(&path).is_ok());
        let _ = fs::remove_dir_all(dir);
    }
}
