//! Reasoning levels each model accepts. Local models describe themselves through the
//! chat template in their GGUF file; Codex lists its levels per model; Claude's come
//! from a catalog. Rows live in `model_reasoning`, apart from the model index that is
//! rebuilt on every scan, so a template is read only for new or changed files.

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::db::DbState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningLevel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningProfile {
    /// `effort` (named levels), `toggle` (thinking on or off) or `none`.
    pub control: String,
    #[serde(default)]
    pub levels: Vec<ReasoningLevel>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub can_disable: bool,
    /// How the level reaches the model: `reasoning_effort`, `enable_thinking`, `codex-effort`, `claude-effort`.
    pub wire: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEntry {
    pub model_key: String,
    pub provider: String,
    pub source: String,
    pub profile: ReasoningProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<ReasoningProfile>,
}

/// Words a template may compare `reasoning_effort` with.
const EFFORT_WORDS: [&str; 8] = [
    "minimal", "none", "low", "medium", "high", "xhigh", "max", "ultra",
];
/// A row whose model file is gone but which carries a hand-made list is kept this long.
const MISSING_GRACE_DAYS: i64 = 30;

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS model_reasoning (
           model_key TEXT PRIMARY KEY,
           provider TEXT NOT NULL,
           path TEXT,
           fingerprint TEXT,
           source TEXT NOT NULL,
           profile_json TEXT NOT NULL,
           detected_at TEXT NOT NULL,
           user_json TEXT,
           missing_since TEXT
         );
         CREATE INDEX IF NOT EXISTS model_reasoning_path ON model_reasoning(path);",
    )
    .map_err(|e| format!("Could not create the reasoning table: {e}"))
}

fn quoted_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let quote = bytes[index];
        if quote == b'\'' || quote == b'"' {
            if let Some(end) = text[index + 1..].find(quote as char) {
                let word = &text[index + 1..index + 1 + end];
                if EFFORT_WORDS.contains(&word) {
                    words.push(word.to_owned());
                }
                index += end + 2;
                continue;
            }
        }
        index += 1;
    }
    words
}

/// What a chat template says about thinking. Levels are the words it compares
/// `reasoning_effort` with; a template that only passes the value through (gpt-oss)
/// takes OpenAI's low/medium/high.
pub fn profile_from_template(template: &str) -> ReasoningProfile {
    if template.contains("reasoning_effort") {
        let mut levels: Vec<String> = Vec::new();
        let mut default = None;
        for (at, word) in template.match_indices("reasoning_effort") {
            let start = template[..at]
                .char_indices()
                .rev()
                .nth(40)
                .map_or(0, |(i, _)| i);
            let end = template[at..]
                .char_indices()
                .nth(80)
                .map_or(template.len(), |(i, _)| at + i);
            let after = template[at + word.len()..end].trim_start();
            let before = template[start..at].trim_end();
            let mut compared = Vec::new();
            if after.starts_with("==") || after.starts_with("!=") {
                compared.extend(quoted_words(&after[2..]).into_iter().take(1));
            } else if let Some(list) = after.strip_prefix("in ") {
                let list = &list[..list.find([']', ')']).unwrap_or(list.len())];
                compared.extend(quoted_words(list));
            } else if after.starts_with('=') || after.starts_with('|') {
                // An assignment or `| default('…')` names the default, not a level.
                if default.is_none() {
                    default = quoted_words(after).into_iter().next();
                }
            }
            if before.ends_with("==") || before.ends_with("!=") {
                compared.extend(quoted_words(before).into_iter().last());
            }
            for word in compared {
                if !levels.contains(&word) {
                    levels.push(word);
                }
            }
        }
        let can_disable =
            template.contains("enable_thinking") || levels.iter().any(|l| l == "none");
        levels.retain(|level| level != "none");
        if levels.is_empty() {
            levels = ["low", "medium", "high"].map(String::from).to_vec();
        }
        levels.sort_by_key(|level| EFFORT_WORDS.iter().position(|w| w == level));
        return ReasoningProfile {
            control: "effort".into(),
            levels: levels
                .into_iter()
                .map(|id| ReasoningLevel {
                    id,
                    label: None,
                    hint: None,
                })
                .collect(),
            default,
            can_disable,
            wire: "reasoning_effort".into(),
        };
    }
    if template.contains("enable_thinking") {
        return ReasoningProfile {
            control: "toggle".into(),
            levels: vec![],
            default: None,
            can_disable: true,
            wire: "enable_thinking".into(),
        };
    }
    let thinks = template.contains("<think>");
    ReasoningProfile {
        control: if thinks { "toggle" } else { "none" }.into(),
        levels: vec![],
        default: None,
        can_disable: false,
        wire: "enable_thinking".into(),
    }
}

/// `local:` + the first file of the model, the way paths are compared elsewhere.
pub fn local_key(path: &str) -> String {
    format!(
        "local:{}",
        path.trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
    )
}

fn fingerprint(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{}:{modified}", meta.len()))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Brings local rows in line with the library: new or changed files are read, moved
/// files keep their row, and rows of models that are gone are dropped (hand-made
/// lists after a grace period, in case a drive is only unplugged).
pub fn sync_local(
    conn: &mut Connection,
    paths: &[String],
    read_template: impl Fn(&Path) -> Option<String>,
) -> Result<(), String> {
    let wanted: Vec<(String, String, Option<String>)> = paths
        .iter()
        .map(|path| {
            let clean = path.trim_start_matches(r"\\?\").to_owned();
            (
                local_key(path),
                clean.clone(),
                fingerprint(Path::new(&clean)),
            )
        })
        .collect();
    let keys: BTreeSet<&str> = wanted.iter().map(|(key, _, _)| key.as_str()).collect();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let stored: Vec<(String, Option<String>, Option<String>)> = {
        let mut query = tx
            .prepare("SELECT model_key, fingerprint, user_json FROM model_reasoning WHERE provider='local'")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let mut moved_from = BTreeSet::new();
    for (key, path, print) in &wanted {
        let Some(print) = print else { continue };
        if let Some((_, old_print, _)) = stored.iter().find(|(k, _, _)| k == key) {
            if old_print.as_deref() == Some(print.as_str()) {
                tx.execute(
                    "UPDATE model_reasoning SET missing_since=NULL WHERE model_key=?1",
                    [key],
                )
                .map_err(|e| e.to_string())?;
                continue;
            }
        } else if let Some((old_key, _, _)) = stored
            .iter()
            .find(|(k, p, _)| !keys.contains(k.as_str()) && p.as_deref() == Some(print.as_str()))
        {
            // Same file in a new folder: the row follows it instead of reading it again.
            tx.execute(
                "UPDATE model_reasoning SET model_key=?1, path=?2, missing_since=NULL WHERE model_key=?3",
                params![key, path, old_key],
            )
            .map_err(|e| e.to_string())?;
            moved_from.insert(old_key.clone());
            continue;
        }
        let profile = read_template(Path::new(path)).map_or_else(
            || ReasoningProfile {
                control: "none".into(),
                levels: vec![],
                default: None,
                can_disable: false,
                wire: "enable_thinking".into(),
            },
            |template| profile_from_template(&template),
        );
        tx.execute(
            "INSERT INTO model_reasoning(model_key,provider,path,fingerprint,source,profile_json,detected_at)
             VALUES(?1,'local',?2,?3,'template',?4,?5)
             ON CONFLICT(model_key) DO UPDATE SET path=excluded.path, fingerprint=excluded.fingerprint,
               source='template', profile_json=excluded.profile_json, detected_at=excluded.detected_at, missing_since=NULL",
            params![key, path, print, serde_json::to_string(&profile).map_err(|e| e.to_string())?, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(MISSING_GRACE_DAYS)).to_rfc3339();
    for (key, _, user) in &stored {
        if keys.contains(key.as_str()) || moved_from.contains(key) {
            continue;
        }
        if user.is_some() {
            tx.execute(
                "UPDATE model_reasoning SET missing_since=COALESCE(missing_since, ?2) WHERE model_key=?1",
                params![key, now()],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM model_reasoning WHERE model_key=?1 AND missing_since < ?2",
                params![key, cutoff],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute("DELETE FROM model_reasoning WHERE model_key=?1", [key])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// A deleted model takes its row with it, a hand-made list included.
pub fn remove_local(conn: &Connection, paths: &[String]) -> Result<(), String> {
    for path in paths {
        conn.execute(
            "DELETE FROM model_reasoning WHERE model_key=?1",
            [local_key(path)],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn entries(conn: &Connection) -> Result<Vec<ReasoningEntry>, String> {
    let mut query = conn
        .prepare("SELECT model_key, provider, source, profile_json, user_json FROM model_reasoning ORDER BY model_key")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (model_key, provider, source, profile, user) = row.map_err(|e| e.to_string())?;
        let Ok(profile) = serde_json::from_str(&profile) else {
            continue;
        };
        out.push(ReasoningEntry {
            model_key,
            provider,
            source,
            profile,
            user: user.and_then(|text| serde_json::from_str(&text).ok()),
        });
    }
    Ok(out)
}

/// Returns every profile; with `paths` (the library's model files) the local rows are
/// first brought in line with them.
#[tauri::command]
pub async fn reasoning_profiles(
    db: State<'_, DbState>,
    paths: Option<Vec<String>>,
) -> Result<Vec<ReasoningEntry>, String> {
    let mut conn = db.0.lock().await;
    if let Some(paths) = paths {
        // Only new or changed files are opened; a template read is a few megabytes at most.
        sync_local(&mut conn, &paths, |path| {
            crate::gguf::read_chat_template(path).ok().flatten()
        })?;
    }
    entries(&conn)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub model_key: String,
    pub profile: ReasoningProfile,
}

/// Replaces the rows of one account's or catalog's models (`scope` is the key prefix,
/// such as `codex:<connection>:`): new models appear, models no longer listed go.
#[tauri::command]
pub async fn store_reasoning_profiles(
    db: State<'_, DbState>,
    provider: String,
    scope: String,
    source: String,
    models: Vec<RemoteEntry>,
) -> Result<(), String> {
    if !["codex", "claude"].contains(&provider.as_str())
        || !scope.starts_with(&format!("{provider}:"))
        || models.iter().any(|m| !m.model_key.starts_with(&scope))
    {
        return Err("reasoning-scope".into());
    }
    let mut conn = db.0.lock().await;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let listed: BTreeSet<&str> = models.iter().map(|m| m.model_key.as_str()).collect();
    let existing: Vec<(String, bool)> = {
        let mut query = tx
            .prepare("SELECT model_key, user_json IS NOT NULL FROM model_reasoning WHERE provider=?1 AND substr(model_key,1,length(?2))=?2")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map(params![provider, scope], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    for (key, has_user) in existing {
        if !listed.contains(key.as_str()) && !has_user {
            tx.execute("DELETE FROM model_reasoning WHERE model_key=?1", [&key])
                .map_err(|e| e.to_string())?;
        }
    }
    for model in &models {
        tx.execute(
            "INSERT INTO model_reasoning(model_key,provider,source,profile_json,detected_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(model_key) DO UPDATE SET source=excluded.source, profile_json=excluded.profile_json, detected_at=excluded.detected_at",
            params![model.model_key, provider, source, serde_json::to_string(&model.profile).map_err(|e| e.to_string())?, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Saves or clears (None) the user's own list for a model.
#[tauri::command]
pub async fn set_reasoning_override(
    db: State<'_, DbState>,
    model_key: String,
    profile: Option<ReasoningProfile>,
) -> Result<(), String> {
    let conn = db.0.lock().await;
    let text = profile
        .map(|p| serde_json::to_string(&p))
        .transpose()
        .map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE model_reasoning SET user_json=?2 WHERE model_key=?1",
            params![model_key, text],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("reasoning-model-unknown".into());
    }
    Ok(())
}

const CATALOG_KEY: &str = "reasoning-catalog";
const CATALOG_URL: &str = "https://raw.githubusercontent.com/Alexpl2546/aplot-control-llm/main/app/src-tauri/resources/reasoning-levels.json";

fn catalog_version(value: &Value) -> Option<u64> {
    value
        .get("version")?
        .as_u64()
        .filter(|_| value.get("models").is_some_and(Value::is_array))
}

/// The newer of the bundled catalog and the last one fetched from the repository.
#[tauri::command]
pub async fn reasoning_catalog(db: State<'_, DbState>) -> Result<Value, String> {
    let bundled: Value = serde_json::from_str(include_str!("../resources/reasoning-levels.json"))
        .map_err(|e| e.to_string())?;
    let conn = db.0.lock().await;
    let saved: Option<Value> = conn
        .query_row(
            "SELECT value_json FROM kv WHERE key=?1",
            [CATALOG_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|text| serde_json::from_str(&text).ok());
    Ok(match saved {
        Some(saved) if catalog_version(&saved) > catalog_version(&bundled) => saved,
        _ => bundled,
    })
}

/// Fetches the catalog from the repository; a failure keeps the last saved one.
#[tauri::command]
pub async fn refresh_reasoning_catalog(db: State<'_, DbState>) -> Result<bool, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(CATALOG_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let text = response.text().await.map_err(|e| e.to_string())?;
    if text.len() > 512 * 1024 {
        return Ok(false);
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if catalog_version(&value).is_none() {
        return Ok(false);
    }
    let conn = db.0.lock().await;
    conn.execute(
        "INSERT INTO kv(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        params![CATALOG_KEY, value.to_string(), now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// A level the server may pass on: a short lowercase word, as every provider spells them.
pub fn plausible_level(level: &str) -> bool {
    (1..=12).contains(&level.len()) && level.bytes().all(|b| b.is_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_tell_levels_toggles_and_silence_apart() {
        let gpt_oss = r#"{%- if not reasoning_effort is defined %}{%- set reasoning_effort = "medium" %}{%- endif %}Reasoning: {{ reasoning_effort }}"#;
        let profile = profile_from_template(gpt_oss);
        assert_eq!(profile.control, "effort");
        assert_eq!(profile.default.as_deref(), Some("medium"));
        assert_eq!(
            profile
                .levels
                .iter()
                .map(|l| l.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "medium", "high"]
        );
        let listed = profile_from_template(
            r#"{% if reasoning_effort == 'high' %}x{% elif reasoning_effort == "low" %}y{% elif reasoning_effort == 'none' %}{% endif %}"#,
        );
        assert_eq!(
            listed
                .levels
                .iter()
                .map(|l| l.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "high"]
        );
        assert!(listed.can_disable);
        let qwen = profile_from_template("{%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>{%- endif %}");
        assert_eq!((qwen.control.as_str(), qwen.can_disable), ("toggle", true));
        assert_eq!(profile_from_template("{{ messages }}").control, "none");
    }

    #[test]
    fn local_rows_follow_the_library() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!("aplot-reasoning-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("a.gguf");
        std::fs::write(&model, b"one").unwrap();
        let path = model.to_string_lossy().into_owned();
        let reads = std::cell::Cell::new(0);
        let read = |_: &Path| {
            reads.set(reads.get() + 1);
            Some("{{ enable_thinking }}".to_string())
        };
        sync_local(&mut conn, std::slice::from_ref(&path), read).unwrap();
        sync_local(&mut conn, std::slice::from_ref(&path), read).unwrap();
        assert_eq!(reads.get(), 1, "an unchanged file is not read again");
        assert_eq!(entries(&conn).unwrap()[0].profile.control, "toggle");
        // Moved to another folder: the row follows the same file.
        let moved = dir.join("b.gguf");
        std::fs::rename(&model, &moved).unwrap();
        let moved_path = moved.to_string_lossy().into_owned();
        sync_local(&mut conn, std::slice::from_ref(&moved_path), read).unwrap();
        assert_eq!(reads.get(), 1);
        assert_eq!(entries(&conn).unwrap()[0].model_key, local_key(&moved_path));
        // A hand-made list survives the file going missing; deleting the model removes it.
        conn.execute("UPDATE model_reasoning SET user_json='{}'", [])
            .unwrap();
        sync_local(&mut conn, &[], read).unwrap();
        assert_eq!(entries(&conn).unwrap().len(), 1);
        remove_local(&conn, std::slice::from_ref(&moved_path)).unwrap();
        assert!(entries(&conn).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_short_lowercase_words_pass_as_levels() {
        assert!(plausible_level("ultra") && plausible_level("xhigh"));
        assert!(!plausible_level("") && !plausible_level("High") && !plausible_level("rm -rf"));
    }
}
