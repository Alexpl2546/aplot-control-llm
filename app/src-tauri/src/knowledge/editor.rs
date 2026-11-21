//! Guarded in-place editing for a note's Markdown body.
//!
//! The existing frontmatter is kept byte-for-byte. The editor receives LF
//! text for a textarea, while saves restore the note's original line-ending
//! style and compare the complete source file before replacing it.

use super::vault::{self, Vault};
use super::{Job, KnowledgeState};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::State;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    vault_id: String,
    path: String,
    /// Markdown body only; frontmatter is deliberately not editable here.
    content: String,
    /// SHA-256 of the exact on-disk bytes used as the optimistic concurrency token.
    etag: String,
    line_ending: String,
}

struct RawNote {
    rel: String,
    path: PathBuf,
    bytes: Vec<u8>,
    text: String,
    body_offset: usize,
    etag: String,
    line_ending: String,
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn checked_note(vault: &Vault, rel: &str) -> Result<RawNote, String> {
    let rel = rel.replace('\\', "/");
    if !vault::is_note(&rel) || vault::is_excluded(&rel, &vault.exclusions) {
        return Err("knowledge-path".into());
    }
    let root = PathBuf::from(&vault.path);
    let path = vault::resolve_inside(&root, &rel)?;
    let metadata = fs::metadata(&path).map_err(|_| "knowledge-missing")?;
    if !metadata.is_file() || metadata.len() > vault::MAX_NOTE_BYTES {
        return Err("knowledge-limit".into());
    }
    let bytes = fs::read(&path).map_err(|_| "knowledge-missing")?;
    if bytes.len() as u64 > vault::MAX_NOTE_BYTES {
        return Err("knowledge-limit".into());
    }
    let text = String::from_utf8(bytes.clone()).map_err(|_| "knowledge-encoding")?;
    let source = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let bom_len = text.len() - source.len();
    let body_offset = bom_len + frontmatter_body_offset(source);
    let line_ending = detect_line_ending(&text);
    let etag = fingerprint(&bytes);
    Ok(RawNote {
        rel,
        path,
        bytes,
        text,
        body_offset,
        etag,
        line_ending,
    })
}

/// Mirrors the frontmatter delimiter rules in markdown::split_front_matter,
/// returning the byte offset after the closing delimiter. A malformed opening
/// block is treated as body text exactly as it is by the reader.
fn frontmatter_body_offset(source: &str) -> usize {
    let mut lines = source.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return 0;
    };
    if first.trim_end() != "---" {
        return 0;
    }
    let mut offset = first.len();
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            return offset + line.len();
        }
        offset += line.len();
    }
    0
}

fn detect_line_ending(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut counts = [0usize; 3]; // LF, CRLF, CR
    let mut first = None;
    let mut index = 0;
    while index < bytes.len() {
        let kind = match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                index += 1;
                1
            }
            b'\r' => 2,
            b'\n' => 0,
            _ => {
                index += 1;
                continue;
            }
        };
        counts[kind] += 1;
        first.get_or_insert(kind);
        index += 1;
    }
    if counts == [0, 0, 0] {
        return "lf".into();
    }
    let maximum = *counts.iter().max().unwrap_or(&0);
    let kind = first
        .filter(|kind| counts[*kind] == maximum)
        .or_else(|| counts.iter().position(|count| *count == maximum))
        .unwrap_or(0);
    match kind {
        1 => "crlf".into(),
        2 => "cr".into(),
        _ => "lf".into(),
    }
}

fn ending_bytes(ending: &str) -> &'static str {
    match ending {
        "crlf" => "\r\n",
        "cr" => "\r",
        _ => "\n",
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn editor_document(vault_id: &str, note: &RawNote) -> EditorDocument {
    let source = note.text.strip_prefix('\u{feff}').unwrap_or(&note.text);
    let bom_len = note.text.len() - source.len();
    let offset = note.body_offset.saturating_sub(bom_len);
    EditorDocument {
        vault_id: vault_id.to_owned(),
        path: note.rel.clone(),
        content: normalize_newlines(&source[offset..]),
        etag: note.etag.clone(),
        line_ending: note.line_ending.clone(),
    }
}

fn read_document(vault: &Vault, rel: &str) -> Result<EditorDocument, String> {
    let note = checked_note(vault, rel)?;
    Ok(editor_document(&vault.id, &note))
}

fn atomic_replace(vault: &Vault, note: &RawNote, replacement: &[u8]) -> Result<(), String> {
    let parent = note.path.parent().ok_or("knowledge-path")?;
    let file_name = note
        .path
        .file_name()
        .map(|name| name.to_string_lossy())
        .ok_or("knowledge-path")?;
    let temporary_path = parent.join(format!(".aplot-{}-{file_name}.tmp", uuid::Uuid::new_v4()));
    let temporary = TemporaryFile(temporary_path.clone());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|_| "knowledge-write")?;
    file.write_all(replacement).map_err(|_| "knowledge-write")?;
    file.sync_all().map_err(|_| "knowledge-write")?;
    if let Ok(metadata) = fs::metadata(&note.path) {
        fs::set_permissions(&temporary_path, metadata.permissions())
            .map_err(|_| "knowledge-write")?;
    }
    drop(file);

    // Re-resolve after staging the file so a moved/replaced note cannot redirect
    // the write, and check the external-edit token immediately before replacement.
    let root = PathBuf::from(&vault.path);
    let current_path = vault::resolve_inside(&root, &note.rel)?;
    if current_path != note.path {
        return Err("knowledge-conflict".into());
    }
    let current = fs::read(&current_path).map_err(|_| "knowledge-conflict")?;
    if fingerprint(&current) != note.etag {
        return Err("knowledge-conflict".into());
    }
    fs::rename(&temporary_path, &note.path).map_err(|_| "knowledge-write")?;
    drop(temporary);
    Ok(())
}

struct TemporaryFile(PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn save_document(
    vault: &Vault,
    rel: &str,
    content: &str,
    expected_etag: &str,
) -> Result<EditorDocument, String> {
    let note = checked_note(vault, rel)?;
    if note.etag != expected_etag {
        return Err("knowledge-conflict".into());
    }
    let body = normalize_newlines(content).replace('\n', ending_bytes(&note.line_ending));
    let mut replacement = Vec::with_capacity(note.body_offset + body.len());
    replacement.extend_from_slice(&note.bytes[..note.body_offset]);
    replacement.extend_from_slice(body.as_bytes());
    if replacement.len() as u64 > vault::MAX_NOTE_BYTES {
        return Err("knowledge-limit".into());
    }
    if replacement != note.bytes {
        atomic_replace(vault, &note, &replacement)?;
    }
    let text = String::from_utf8(replacement.clone()).map_err(|_| "knowledge-encoding")?;
    let saved = RawNote {
        rel: note.rel,
        path: note.path,
        etag: fingerprint(&replacement),
        body_offset: note.body_offset,
        line_ending: note.line_ending,
        bytes: replacement,
        text,
    };
    Ok(editor_document(&vault.id, &saved))
}

#[tauri::command]
pub async fn knowledge_editor_read(
    knowledge: State<'_, KnowledgeState>,
    vault_id: String,
    path: String,
) -> Result<EditorDocument, String> {
    let vault = knowledge.vault(&vault_id)?;
    tauri::async_runtime::spawn_blocking(move || read_document(&vault, &path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn knowledge_editor_save(
    knowledge: State<'_, KnowledgeState>,
    vault_id: String,
    path: String,
    content: String,
    expected_etag: String,
) -> Result<EditorDocument, String> {
    let vault = knowledge.vault(&vault_id)?;
    let jobs = knowledge.jobs.clone();
    let sync_vault_id = vault.id.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        save_document(&vault, &path, &content, &expected_etag)
    })
    .await
    .map_err(|error| error.to_string())??;
    let _ = jobs.send(Job::Sync(sync_vault_id, Some(vec![saved.path.clone()])));
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> (PathBuf, Vault) {
        let base =
            std::env::temp_dir().join(format!("aplot-knowledge-editor-{}", uuid::Uuid::new_v4()));
        let root = base.join("Vault");
        fs::create_dir_all(&root).unwrap();
        let root = vault::canonical_root(&root.to_string_lossy()).unwrap();
        let binding = Vault {
            id: "v1".into(),
            name: "Vault".into(),
            path: vault::display(&root),
            exclusions: vec![],
            added_at: String::new(),
        };
        (base, binding)
    }

    #[test]
    fn body_save_keeps_frontmatter_bom_and_crlf_bytes() {
        let (base, vault) = temp_vault();
        let original = "\u{feff}---\r\ntags: [first, second]\r\ncustom:  \"raw value\"\r\n---\r\n# Heading\r\nOld body\r\n";
        let note_path = Path::new(&vault.path).join("Note.md");
        fs::write(&note_path, original.as_bytes()).unwrap();

        let opened = read_document(&vault, "Note.md").unwrap();
        assert_eq!(opened.content, "# Heading\nOld body\n");
        assert_eq!(opened.line_ending, "crlf");
        let saved =
            save_document(&vault, "Note.md", "# Heading\nEdited body\n", &opened.etag).unwrap();

        let expected = "\u{feff}---\r\ntags: [first, second]\r\ncustom:  \"raw value\"\r\n---\r\n# Heading\r\nEdited body\r\n";
        assert_eq!(fs::read_to_string(&note_path).unwrap(), expected);
        assert_eq!(saved.content, "# Heading\nEdited body\n");
        assert_ne!(saved.etag, opened.etag);
        assert_eq!(
            fs::read_dir(note_path.parent().unwrap()).unwrap().count(),
            1
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn stale_editor_etag_preserves_external_edit_and_draft_is_not_written() {
        let (base, vault) = temp_vault();
        let note_path = Path::new(&vault.path).join("Note.md");
        fs::write(&note_path, "---\nstatus: open\n---\nOriginal\n").unwrap();
        let opened = read_document(&vault, "Note.md").unwrap();
        let external = "---\nstatus: reviewed\n---\nChanged in Obsidian\n";
        fs::write(&note_path, external).unwrap();

        let result = save_document(&vault, "Note.md", "Draft from Aplot\n", &opened.etag);
        assert_eq!(result.unwrap_err(), "knowledge-conflict");
        assert_eq!(fs::read_to_string(&note_path).unwrap(), external);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn editor_keeps_path_guard_and_rejects_invalid_utf8() {
        let (base, vault) = temp_vault();
        let root = PathBuf::from(&vault.path);
        fs::write(root.join("Note.md"), [0xFF, 0xFE]).unwrap();
        assert_eq!(
            read_document(&vault, "../Note.md").unwrap_err(),
            "knowledge-path"
        );
        assert_eq!(
            read_document(&vault, "Note.md").unwrap_err(),
            "knowledge-encoding"
        );
        let _ = fs::remove_dir_all(base);
    }
}
