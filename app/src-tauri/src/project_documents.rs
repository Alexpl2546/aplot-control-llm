//! Local declarative document creation. No code evaluation or project writes.
use crate::{
    db::DbState,
    document_spec::{TextDocument, WorkbookDocument},
    project_files::ProjectFile,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "format", rename_all = "lowercase", deny_unknown_fields)]
pub enum DocumentContent {
    Docx { document: TextDocument },
    Pdf { document: TextDocument },
    Xlsx { workbook: WorkbookDocument },
}

impl DocumentContent {
    fn extension(&self) -> &'static str {
        match self {
            Self::Docx { .. } => "docx",
            Self::Pdf { .. } => "pdf",
            Self::Xlsx { .. } => "xlsx",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentRequest {
    pub name: String,
    pub content: DocumentContent,
}

pub(crate) fn tool_schema() -> serde_json::Value {
    use serde_json::json;
    let text = json!({"type":"string","maxLength":64000});
    let block = json!({"oneOf":[
        {"type":"object","properties":{"type":{"const":"paragraph"},"text":text},"required":["type","text"],"additionalProperties":false},
        {"type":"object","properties":{"type":{"const":"heading"},"text":text,"level":{"type":"integer","minimum":1,"maximum":3}},"required":["type","text","level"],"additionalProperties":false},
        {"type":"object","properties":{"type":{"const":"bulletList"},"items":{"type":"array","maxItems":200,"items":text}},"required":["type","items"],"additionalProperties":false},
        {"type":"object","properties":{"type":{"const":"table"},"headers":{"type":"array","minItems":1,"maxItems":8,"items":text},"rows":{"type":"array","maxItems":200,"items":{"type":"array","maxItems":8,"items":text}}},"required":["type","headers","rows"],"additionalProperties":false},
        {"type":"object","properties":{"type":{"const":"pageBreak"}},"required":["type"],"additionalProperties":false}
    ]});
    let document = json!({"type":"object","properties":{"title":{"type":"string","maxLength":200},"blocks":{"type":"array","maxItems":100,"items":block}},"required":["title","blocks"],"additionalProperties":false});
    let cell = json!({"oneOf":[text,{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"object","properties":{"formula":{"type":"string","maxLength":512}},"required":["formula"],"additionalProperties":false}]});
    let sheet = json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":31},"columns":{"type":"array","minItems":1,"maxItems":128,"items":text},"rows":{"type":"array","maxItems":2000,"items":{"type":"array","maxItems":128,"items":cell}}},"required":["name","columns","rows"],"additionalProperties":false});
    json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":200},"content":{"oneOf":[
        {"type":"object","properties":{"format":{"const":"docx"},"document":document},"required":["format","document"],"additionalProperties":false},
        {"type":"object","properties":{"format":{"const":"pdf"},"document":document},"required":["format","document"],"additionalProperties":false},
        {"type":"object","properties":{"format":{"const":"xlsx"},"workbook":{"type":"object","properties":{"title":{"type":"string","maxLength":200},"sheets":{"type":"array","minItems":1,"maxItems":16,"items":sheet}},"required":["title","sheets"],"additionalProperties":false}},"required":["format","workbook"],"additionalProperties":false}
    ]}},"required":["name","content"],"additionalProperties":false})
}

fn validate_name(name: &str, extension: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 200
        || name.trim() != name
        || name.ends_with('.')
        || name
            .chars()
            .any(|ch| ch.is_control() || "/\\:*?\"<>|".contains(ch))
        || Path::new(name).extension().and_then(|ext| ext.to_str()) != Some(extension)
    {
        return Err("document-name-invalid".into());
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("document-name-invalid")?;
    let reserved = stem
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .chars()
        .map(|ch| match ch {
            '¹' => '1',
            '²' => '2',
            '³' => '3',
            other => other,
        })
        .collect::<String>()
        .to_ascii_uppercase();
    if stem.trim_matches('.').trim().is_empty()
        || matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            reserved
                .strip_prefix(prefix)
                .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
        })
    {
        return Err("document-name-invalid".into());
    }
    Ok(())
}

fn build(request: &DocumentRequest) -> Result<Vec<u8>, String> {
    validate_name(&request.name, request.content.extension())?;
    if serde_json::to_vec(request)
        .map_err(|_| "document-invalid")?
        .len()
        > 1_000_000
    {
        return Err("document-limit".into());
    }
    let result = match &request.content {
        DocumentContent::Docx { document } => crate::document_docx::build(document),
        DocumentContent::Pdf { document } => crate::document_pdf::build(document),
        DocumentContent::Xlsx { workbook } => crate::document_xlsx::build(workbook),
    }?;
    if result.is_empty() || result.len() > 10 * 1024 * 1024 {
        return Err("document-limit".into());
    }
    Ok(result)
}

struct StagedDocument {
    file: PathBuf,
    directory: PathBuf,
}
impl Drop for StagedDocument {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.file);
        let _ = fs::remove_dir(&self.directory);
    }
}

fn stage(data: &Path, name: &str, bytes: &[u8]) -> Result<StagedDocument, String> {
    fs::create_dir_all(data).map_err(|_| "document-storage")?;
    let data = fs::canonicalize(data).map_err(|_| "document-storage")?;
    let root = data.join("document-staging");
    if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("document-storage".into());
    }
    fs::create_dir_all(&root).map_err(|_| "document-storage")?;
    let root = fs::canonicalize(root).map_err(|_| "document-storage")?;
    if root.parent() != Some(data.as_path()) {
        return Err("document-storage".into());
    }
    let directory = root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&directory).map_err(|_| "document-storage")?;
    let staged = StagedDocument {
        file: directory.join(name),
        directory,
    };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged.file)
        .map_err(|_| "document-storage")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "document-storage")?;
    Ok(staged)
}

#[tauri::command]
pub async fn project_documents_create(
    app: AppHandle,
    db: State<'_, DbState>,
    project_id: String,
    request: DocumentRequest,
) -> Result<ProjectFile, String> {
    {
        let conn = db.0.lock().await;
        crate::project_files::require_project(&conn, &project_id)?;
    }
    validate_name(&request.name, request.content.extension())?;
    let data = crate::db::connection_data_dir(&app)?;
    let staged = tauri::async_runtime::spawn_blocking(move || {
        let bytes = build(&request)?;
        stage(&data, &request.name, &bytes)
    })
    .await
    .map_err(|_| "document-build-failed".to_string())??;
    crate::project_files::project_files_import(
        app.clone(),
        app.state::<DbState>(),
        project_id,
        staged.file.to_string_lossy().into_owned(),
    )
    .await
}

pub(crate) async fn create_for_task(
    app: &AppHandle,
    task_id: &str,
    request: DocumentRequest,
) -> Result<ProjectFile, String> {
    let project_id = {
        let db = app.state::<DbState>();
        let conn = db.0.lock().await;
        crate::project_files::project_id_for_task(&conn, task_id)?
    };
    project_documents_create(app.clone(), app.state::<DbState>(), project_id, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filename_is_a_leaf_with_a_matching_format_and_no_windows_device_name() {
        assert!(validate_name("Отчёт.docx", "docx").is_ok());
        for name in [
            "../report.docx",
            "C:\\report.docx",
            "NUL.docx",
            "NUL .docx",
            "CON.other.docx",
            "COM1.docx",
            "COM¹.docx",
            "LPT².docx",
            " report.docx",
            ".docx",
            "report.pdf",
            "a\n.docx",
        ] {
            assert!(validate_name(name, "docx").is_err(), "accepted {name}");
        }
    }
    #[test]
    fn model_request_cannot_add_paths_or_choose_another_project() {
        let value = serde_json::json!({"name":"report.docx","content":{"format":"docx","document":{"title":"Report","blocks":[]}},"projectId":"other"});
        assert!(serde_json::from_value::<DocumentRequest>(value).is_err());
    }
}
