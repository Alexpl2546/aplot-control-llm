//! Conversation history is application data, separate from launch profiles and credentials.
use crate::db::DbState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_conversations (
           id TEXT PRIMARY KEY, conversation_json TEXT NOT NULL, updated_at REAL NOT NULL
         );
         CREATE TABLE IF NOT EXISTS chat_history_selection (
           id INTEGER PRIMARY KEY CHECK(id=1), selected_id TEXT NOT NULL
         );",
    )
    .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ChatTarget {
    #[serde(rename = "local")]
    Local {
        run_id: String,
        generation: u64,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        engine: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<String>,
    },
    #[serde(rename = "chatgpt")]
    Chatgpt {
        connection_id: String,
        model: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
    },
    #[serde(rename = "claude")]
    Claude {
        connection_id: String,
        model: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatDocument {
    name: String,
    data: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessageMedia {
    name: String,
    kind: String,
    image_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocks: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<ChatUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attachment_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    images: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    documents: Option<Vec<ChatDocument>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attachment_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_ru: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_translation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation_tps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    media: Option<Vec<ChatMessageMedia>>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cached_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_tokens: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatAttachment {
    id: String,
    name: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frames: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatThread {
    messages: Vec<ChatMessage>,
    draft: String,
    error: String,
    stopped: bool,
    pending: bool,
    translating: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attachments: Option<Vec<ChatAttachment>>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedConversation {
    id: String,
    title: String,
    created_at: f64,
    updated_at: f64,
    target: ChatTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pinned_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archived_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch_parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch_from_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
    #[serde(default)]
    web_search: bool,
    thread: ChatThread,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatHistoryChanges {
    selected_id: String,
    conversations: Vec<SavedConversation>,
    deleted: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryData {
    version: u8,
    selected_id: String,
    conversations: Vec<SavedConversation>,
}

fn load(conn: &Connection) -> Result<ChatHistoryData, String> {
    let selected_id = conn
        .query_row(
            "SELECT selected_id FROM chat_history_selection WHERE id=1",
            [],
            |row| row.get(0),
        )
        .or_else(|error| {
            if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                Ok(String::new())
            } else {
                Err(error)
            }
        })
        .map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT conversation_json FROM chat_conversations ORDER BY updated_at DESC, id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let conversations = rows
        .map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|_| "chat-history-invalid".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ChatHistoryData {
        version: 1,
        selected_id,
        conversations,
    })
}

fn save(conn: &mut Connection, changes: ChatHistoryChanges) -> Result<(), String> {
    let mut serialized = Vec::new();
    for mut conversation in changes.conversations {
        if conversation.id.is_empty()
            || conversation.id.len() > 128
            || conversation.title.chars().count() > 120
            || !conversation.created_at.is_finite()
            || !conversation.updated_at.is_finite()
            || conversation
                .pinned_at
                .is_some_and(|value| !value.is_finite())
            || conversation
                .archived_at
                .is_some_and(|value| !value.is_finite())
            || conversation
                .project_id
                .as_ref()
                .is_some_and(|value| value.len() > 128)
            || conversation
                .branch_parent_id
                .as_ref()
                .is_some_and(|value| value.len() > 128)
            || conversation
                .branch_from_message_id
                .as_ref()
                .is_some_and(|value| value.len() > 128)
            || conversation
                .instructions
                .as_ref()
                .is_some_and(|value| value.len() > 32_000)
            || conversation.thread.messages.iter().any(|message| {
                !["user", "assistant"].contains(&message.role.as_str())
                    || message.blocks.as_ref().is_some_and(|blocks| {
                        blocks.len() > 256
                            || blocks
                                .iter()
                                .any(|block| !block.is_object() || block.to_string().len() > 400000)
                    })
                    || message.usage.as_ref().is_some_and(|usage| {
                        [
                            usage.input_tokens,
                            usage.output_tokens,
                            usage.total_tokens,
                            usage.cached_input_tokens,
                            usage.reasoning_tokens,
                        ]
                        .into_iter()
                        .flatten()
                        .any(|value| value > 9_007_199_254_740_991)
                    })
                    || message
                        .id
                        .as_ref()
                        .is_some_and(|id| id.is_empty() || id.len() > 128)
                    || message
                        .generation_tps
                        .is_some_and(|speed| !speed.is_finite() || speed < 0.0)
                    || message.media.as_ref().is_some_and(|items| {
                        items
                            .iter()
                            .any(|item| !["image", "video"].contains(&item.kind.as_str()))
                    })
            })
            || conversation
                .thread
                .attachments
                .as_ref()
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        !["image", "file", "video", "skill"].contains(&item.kind.as_str())
                    })
                })
        {
            return Err("chat-history-invalid".into());
        }
        // A saved partial reply must never return with a live spinner after restarting the app.
        conversation.thread.stopped |= conversation.thread.pending;
        conversation.thread.pending = false;
        conversation.thread.translating = false;
        for message in &mut conversation.thread.messages {
            if let Some(blocks) = &mut message.blocks {
                for block in blocks {
                    if block["type"] == "tool" && block["status"] == "in_progress" {
                        block["status"] = serde_json::json!("incomplete");
                    }
                }
            }
            if message.reasoning_translation.as_deref() == Some("pending") {
                message.reasoning_translation = Some("stopped".into());
            }
        }
        let json = serde_json::to_string(&conversation).map_err(|error| error.to_string())?;
        if json.len() > 128 * 1024 * 1024 {
            return Err("chat-history-limit".into());
        }
        serialized.push((conversation.id, json, conversation.updated_at));
    }
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    for id in changes.deleted {
        transaction
            .execute("DELETE FROM chat_conversations WHERE id=?1", [id])
            .map_err(|error| error.to_string())?;
    }
    for (id, json, updated_at) in serialized {
        transaction.execute("INSERT INTO chat_conversations(id,conversation_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET conversation_json=excluded.conversation_json,updated_at=excluded.updated_at", params![id, json, updated_at]).map_err(|error| error.to_string())?;
    }
    transaction.execute("INSERT INTO chat_history_selection(id,selected_id) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET selected_id=excluded.selected_id", [changes.selected_id]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn chat_history_load(db: State<'_, DbState>) -> Result<ChatHistoryData, String> {
    load(&*db.0.lock().await)
}
#[tauri::command]
pub async fn chat_history_save(
    db: State<'_, DbState>,
    changes: ChatHistoryChanges,
) -> Result<(), String> {
    save(&mut *db.0.lock().await, changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_media_preview_paths_and_response_speed() {
        let mut saved = conversation("media");
        saved.thread.messages[0].media = Some(vec![ChatMessageMedia {
            name: "clip.mp4".into(),
            kind: "video".into(),
            image_index: 0,
            path: Some("C:/media/clip.mp4".into()),
        }]);
        saved.thread.messages[1].generation_tps = Some(34.7);
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        save(
            &mut conn,
            ChatHistoryChanges {
                selected_id: "media".into(),
                conversations: vec![saved],
                deleted: vec![],
            },
        )
        .unwrap();
        let loaded = load(&conn).unwrap();
        let messages = &loaded.conversations[0].thread.messages;
        assert_eq!(messages[1].generation_tps, Some(34.7));
        assert_eq!(
            messages[0].media.as_ref().unwrap()[0].path.as_deref(),
            Some("C:/media/clip.mp4")
        );
    }
    #[test]
    fn persists_message_ids_and_conversation_workflow_metadata() {
        let mut saved = conversation("branch");
        saved.pinned_at = Some(3.0);
        saved.archived_at = Some(4.0);
        saved.project_id = Some("project-1".into());
        saved.branch_parent_id = Some("source".into());
        saved.branch_from_message_id = Some("message-1".into());
        saved.instructions = Some("Keep answers concise".into());
        saved.web_search = true;
        saved.thread.messages[0].id = Some("message-1".into());
        saved.thread.messages[0].attachment_text = Some("Extracted text".into());
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        save(
            &mut conn,
            ChatHistoryChanges {
                selected_id: "branch".into(),
                conversations: vec![saved],
                deleted: vec![],
            },
        )
        .unwrap();
        let loaded = load(&conn).unwrap();
        let branch = &loaded.conversations[0];
        assert_eq!(branch.pinned_at, Some(3.0));
        assert_eq!(branch.archived_at, Some(4.0));
        assert_eq!(branch.project_id.as_deref(), Some("project-1"));
        assert_eq!(branch.branch_parent_id.as_deref(), Some("source"));
        assert_eq!(branch.instructions.as_deref(), Some("Keep answers concise"));
        assert!(branch.web_search);
        assert_eq!(branch.thread.messages[0].id.as_deref(), Some("message-1"));
        assert_eq!(
            branch.thread.messages[0].attachment_text.as_deref(),
            Some("Extracted text")
        );
    }
    fn conversation(id: &str) -> SavedConversation {
        serde_json::from_value(serde_json::json!({"id":id,"title":"Conversation","createdAt":1,"updatedAt":2,"target":{"provider":"local","runId":"server","generation":2,"label":"Local model","startedAt":"2026-10-22T12:00:00Z"},"thread":{"messages":[{"role":"user","content":"Hello","images":["data:image/png;base64,AA=="]},{"role":"assistant","content":"Partial","reasoningTranslation":"pending"}],"draft":"Next","error":"","stopped":false,"pending":true,"translating":true}})).unwrap()
    }
    #[test]
    fn round_trip_preserves_conversations_drafts_media_and_interrupted_answers() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        save(
            &mut conn,
            ChatHistoryChanges {
                selected_id: "two".into(),
                conversations: vec![conversation("one"), conversation("two")],
                deleted: vec![],
            },
        )
        .unwrap();
        let loaded = load(&conn).unwrap();
        assert_eq!(loaded.selected_id, "two");
        assert_eq!(loaded.conversations.len(), 2);
        let thread = &loaded.conversations[0].thread;
        assert_eq!(thread.draft, "Next");
        assert!(thread.stopped);
        assert!(!thread.pending);
        assert!(!thread.translating);
        assert_eq!(
            thread.messages[0].images.as_ref().unwrap()[0],
            "data:image/png;base64,AA=="
        );
        assert_eq!(
            thread.messages[1].reasoning_translation.as_deref(),
            Some("stopped")
        );
    }
    #[test]
    fn update_and_delete_leave_unrelated_history_intact() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        save(
            &mut conn,
            ChatHistoryChanges {
                selected_id: "one".into(),
                conversations: vec![conversation("one"), conversation("two")],
                deleted: vec![],
            },
        )
        .unwrap();
        let mut edited = conversation("two");
        edited.title = "Renamed".into();
        save(
            &mut conn,
            ChatHistoryChanges {
                selected_id: "two".into(),
                conversations: vec![edited],
                deleted: vec!["one".into()],
            },
        )
        .unwrap();
        let loaded = load(&conn).unwrap();
        assert_eq!(loaded.conversations.len(), 1);
        assert_eq!(loaded.conversations[0].title, "Renamed");
    }
    #[test]
    fn invalid_updates_do_not_apply_queued_deletions() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        save(
            &mut conn,
            ChatHistoryChanges {
                selected_id: "one".into(),
                conversations: vec![conversation("one")],
                deleted: vec![],
            },
        )
        .unwrap();
        let mut invalid = conversation("two");
        invalid.thread.messages[0].role = "system".into();
        assert!(save(
            &mut conn,
            ChatHistoryChanges {
                selected_id: "two".into(),
                conversations: vec![invalid],
                deleted: vec!["one".into()]
            }
        )
        .is_err());
        assert_eq!(load(&conn).unwrap().conversations.len(), 1);
    }
    #[test]
    fn target_cannot_accept_credentials_or_arbitrary_launch_settings() {
        let mut json = serde_json::to_value(conversation("one")).unwrap();
        json["target"]["apiKey"] = serde_json::json!("must-not-be-saved");
        assert!(serde_json::from_value::<SavedConversation>(json).is_err());
    }
    #[test]
    fn legacy_history_without_workflow_metadata_or_message_ids_still_loads() {
        let legacy = serde_json::json!({"id":"legacy","title":"Old","createdAt":1,"updatedAt":2,"target":{"provider":"local","runId":"server","generation":2,"label":"Local model"},"thread":{"messages":[{"role":"user","content":"Hello"}],"draft":"","error":"","stopped":false,"pending":false,"translating":false}});
        let parsed: SavedConversation = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.thread.messages[0].id, None);
        assert_eq!(parsed.instructions, None);
        assert!(!parsed.web_search);
    }
}
