//! Explicitly selected chat files. No directory crawling or automatic submission.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub name: String,
    pub data: String,
}
pub(crate) fn valid_images(images: &[String]) -> bool {
    images.len() <= 8
        && images.iter().all(|v| {
            v.len() <= 7_000_000
                && [
                    "data:image/png;base64,",
                    "data:image/jpeg;base64,",
                    "data:image/webp;base64,",
                    "data:image/gif;base64,",
                ]
                .iter()
                .any(|p| v.starts_with(p))
        })
}
pub(crate) fn valid_documents(docs: &[Document]) -> bool {
    docs.len() <= 4
        && docs.iter().all(|d| {
            !d.name.is_empty()
                && d.name.len() <= 200
                && d.data.len() <= 14_000_000
                && d.data.starts_with("data:application/pdf;base64,")
        })
}
pub(crate) fn local_content(text: &str, images: &[String]) -> Value {
    if images.is_empty() {
        json!(text)
    } else {
        let mut content = vec![json!({"type":"text","text":text})];
        content.extend(
            images
                .iter()
                .map(|image| json!({"type":"image_url","image_url":{"url":image}})),
        );
        json!(content)
    }
}
pub(crate) fn response_message(
    role: &str,
    text: &str,
    images: &[String],
    docs: &[Document],
) -> Value {
    if images.is_empty() && docs.is_empty() {
        return json!({"role":role,"content":text});
    }
    let mut content =
        vec![json!({"type":if role=="assistant"{"output_text"}else{"input_text"},"text":text})];
    content.extend(
        images
            .iter()
            .map(|image| json!({"type":"input_image","image_url":image})),
    );
    content.extend(
        docs.iter()
            .map(|d| json!({"type":"input_file","filename":d.name,"file_data":d.data})),
    );
    json!({"role":role,"content":content})
}
fn read_attachment(path: &Path) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|_| "attachment-missing")?;
    let metadata = file.metadata().map_err(|_| "attachment-missing")?;
    if !metadata.is_file() || metadata.len() > 25 * 1024 * 1024 {
        return Err("attachment-limit".into());
    }
    let mut bytes = Vec::new();
    file.take(25 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "attachment-data")?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("attachment-limit".into());
    }
    let name = path.file_name().ok_or("attachment-data")?.to_string_lossy();
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if ["mp4", "m4v", "mov"].contains(&ext.as_str()) && bytes.get(4..8) == Some(b"ftyp") {
        Some("video/mp4")
    } else if ext == "webm" && bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Some("video/webm")
    } else {
        None
    };
    if let Some(mime) = mime {
        if mime.starts_with("image/") && bytes.len() > 5 * 1024 * 1024
            || mime == "application/pdf" && bytes.len() > 10 * 1024 * 1024
        {
            return Err("attachment-limit".into());
        }
        return Ok(
            json!({"name":name,"mime":mime,"data":format!("data:{mime};base64,{}",STANDARD.encode(bytes))}),
        );
    }
    if bytes.len() > 200_000 || bytes.contains(&0) {
        return Err("attachment-unsupported".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "attachment-unsupported")?;
    Ok(json!({"name":name,"mime":"text/plain","text":text}))
}
#[tauri::command]
pub fn chat_attachment_read(path: String) -> Result<Value, String> {
    read_attachment(Path::new(&path))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_remote_image_fetches_and_unbounded_payloads() {
        assert!(!valid_images(&["https://example.test/private".into()]));
        assert!(!valid_images(&vec!["data:image/png;base64,AA==".into(); 9]));
        assert!(valid_images(&["data:image/png;base64,AA==".into()]));
    }
    #[test]
    fn normalizes_local_and_responses_inputs() {
        assert_eq!(local_content("hello", &[]), json!("hello"));
        let m = response_message(
            "user",
            "describe",
            &["data:image/png;base64,AA==".into()],
            &[],
        );
        assert_eq!(m["content"][1]["type"], "input_image");
    }
    #[test]
    fn reads_text_but_rejects_binary() {
        let root = std::env::temp_dir().join(format!("aplot-chat-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let p = root.join("sample.txt");
        fs::write(&p, "hello").unwrap();
        assert_eq!(read_attachment(&p).unwrap()["text"], "hello");
        fs::write(&p, [0, 1, 2]).unwrap();
        assert!(read_attachment(&p).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
