//! Session autosave + restore. Persists chat history, BPM, and the file
//! path last opened so the app can resume where the user left off.
//!
//! Writes to `{app_data_dir}/session.json` via atomic temp-file rename.
//! Autosave is throttled to at most once every `AUTOSAVE_MIN_INTERVAL`.

use crate::state::AppState;
use cycletron_core::types::ChatMessage;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::State;

const AUTOSAVE_MIN_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub file_path: Option<PathBuf>,
    pub code: String,
    pub bpm: f64,
    pub messages: Vec<ChatMessage>,
    pub saved_at: chrono::DateTime<chrono::Utc>,
}

fn snapshot_path(dir: &Path) -> PathBuf {
    dir.join("session.json")
}

fn write_snapshot(dir: &Path, snap: &SessionSnapshot) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let target = snapshot_path(dir);
    let tmp = dir.join(".session.json.tmp");
    let body = serde_json::to_string_pretty(snap)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &target)
}

fn read_snapshot(dir: &Path) -> Option<SessionSnapshot> {
    let f = snapshot_path(dir);
    let body = std::fs::read_to_string(&f).ok()?;
    serde_json::from_str(&body).ok()
}

/// Persist a snapshot of the current session. Throttled — callers can
/// safely invoke this on every editor change.
#[tauri::command]
pub fn autosave_session(
    code: String,
    bpm: f64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let now = Instant::now();
    {
        let mut last = state.last_autosave.lock();
        if let Some(prev) = *last
            && now.duration_since(prev) < AUTOSAVE_MIN_INTERVAL
        {
            return Ok(false);
        }
        *last = Some(now);
    }

    let dir = state
        .app_data_dir()
        .ok_or_else(|| "app data dir not initialized".to_string())?;

    let (file_path, messages) = {
        let session = state.session.lock();
        (session.file_path.clone(), session.messages.clone())
    };

    let snap = SessionSnapshot {
        file_path,
        code,
        bpm,
        messages,
        saved_at: chrono::Utc::now(),
    };

    write_snapshot(&dir, &snap).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Load the last-saved snapshot, if any. Also restores chat messages into
/// the in-memory session so subsequent AI calls have context.
#[tauri::command]
pub fn restore_session(state: State<'_, AppState>) -> Option<SessionSnapshot> {
    let dir = state.app_data_dir()?;
    let snap = read_snapshot(&dir)?;

    {
        let mut session = state.session.lock();
        session.messages = snap.messages.clone();
        session.tempo = snap.bpm;
        if let Some(path) = &snap.file_path {
            // If the file no longer exists, drop the reference so Save doesn't
            // try to overwrite a stale path.
            if path.exists() {
                session.file_path = Some(path.clone());
                session.last_saved_snapshot = Some(snap.code.clone());
                session.current_pattern = Some(snap.code.clone());
            }
        } else if !snap.code.is_empty() {
            session.current_pattern = Some(snap.code.clone());
        }
    }

    Some(snap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_roundtrips() {
        let dir = std::env::temp_dir().join("cycletron_persist_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let snap = SessionSnapshot {
            file_path: Some(PathBuf::from("/tmp/foo.strudel")),
            code: "s(\"bd\")".to_string(),
            bpm: 123.0,
            messages: vec![],
            saved_at: chrono::Utc::now(),
        };
        write_snapshot(&dir, &snap).unwrap();
        let back = read_snapshot(&dir).unwrap();
        assert_eq!(back.bpm, 123.0);
        assert_eq!(back.code, "s(\"bd\")");
        assert_eq!(
            back.file_path.unwrap().to_string_lossy(),
            "/tmp/foo.strudel"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_keeps_tool_envelopes_and_reads_legacy_traces() {
        use cycletron_core::types::{ChatRole, ToolCategory, ToolOutcome, ToolTrace};
        let dir = std::env::temp_dir().join("cycletron_persist_tools_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let snap = SessionSnapshot {
            file_path: None,
            code: String::new(),
            bpm: 120.0,
            messages: vec![ChatMessage {
                id: "m1".into(),
                role: ChatRole::Assistant,
                content: "tried".into(),
                timestamp: chrono::Utc::now(),
                tools: vec![ToolTrace {
                    id: "c1".into(),
                    name: "validate_pattern".into(),
                    input: serde_json::json!({ "code": "s(\"bd\")" }),
                    outcome: ToolOutcome::failed(ToolCategory::InvalidCode, "INVALID: x"),
                    duration_ms: 7,
                }],
            }],
            saved_at: chrono::Utc::now(),
        };
        write_snapshot(&dir, &snap).unwrap();
        let back = read_snapshot(&dir).unwrap();
        let t = &back.messages[0].tools[0];
        assert_eq!(t.outcome.category, Some(ToolCategory::InvalidCode));
        assert_eq!(t.outcome.text, "INVALID: x");
        assert_eq!(t.duration_ms, 7);

        // A snapshot written before the envelope existed still restores; its
        // traces are migrated into envelopes on read.
        let legacy = r#"{
            "file_path": null, "code": "", "bpm": 100.0,
            "saved_at": "2026-01-01T00:00:00Z",
            "messages": [{
                "id": "m", "role": "assistant", "content": "", "timestamp": "2026-01-01T00:00:00Z",
                "tools": [{"id": "c", "name": "play_pattern", "input": {}, "result": "NOT PLAYED — x", "is_error": false}]
            }]
        }"#;
        std::fs::write(snapshot_path(&dir), legacy).unwrap();
        let back = read_snapshot(&dir).expect("legacy snapshot must still load");
        let t = &back.messages[0].tools[0];
        assert!(t.outcome.ok);
        assert_eq!(t.outcome.summary, "NOT PLAYED — x");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
