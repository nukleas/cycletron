//! Transport control surface: one snapshot out, one set of command topics in.
//!
//! Everything outside the webview that cares about playback reads the same
//! snapshot — the tray label/tooltip, and a JSON state file that desktop
//! widgets (the Omarchy bar plugin, a waybar script, anything else) can watch.
//! Commands travel the other way as `transport:*` events; the tray, the global
//! shortcuts, and the CLI verbs are all just emitters of those.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Event topics the frontend listens on. Every transport source emits these,
/// so a new source (CLI verb, MIDI pedal, D-Bus call) needs no frontend work.
pub mod topic {
    pub const PLAY_PAUSE: &str = "transport:play_pause";
    pub const PLAY: &str = "transport:play";
    pub const PAUSE: &str = "transport:pause";
    pub const STOP: &str = "transport:stop";
    pub const TEMPO: &str = "transport:tempo";
    /// Relative tempo change. A keybind can't read the current BPM to add to
    /// it, so the app does the arithmetic.
    pub const TEMPO_NUDGE: &str = "transport:tempo_nudge";
}

/// What the frontend reports whenever transport state changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackSnapshot {
    /// `"playing"`, `"paused"`, or `"stopped"`.
    pub state: String,
    pub bpm: f64,
    /// Cycles per second — the scheduler's own clock rate, not re-derived here.
    pub cps: f64,
    /// Cycle position at the moment of the snapshot.
    pub cycle: f64,
    /// Display name of the open document, e.g. `"acid.strudel"`.
    pub file: String,
    /// Absolute path, when the document has been saved somewhere.
    pub path: Option<String>,
}

impl PlaybackSnapshot {
    pub fn is_playing(&self) -> bool {
        self.state == "playing"
    }
}

/// The on-disk shape: the snapshot plus enough for a reader to tell a live
/// instance from one that died without writing its final `stopped`.
#[derive(Debug, Serialize)]
struct StateFile<'a> {
    #[serde(flatten)]
    snapshot: &'a PlaybackSnapshot,
    pid: u32,
    updated_ms: i64,
}

/// Fan a frontend snapshot out to every external consumer.
#[tauri::command]
pub fn set_playback_state(
    snapshot: PlaybackSnapshot,
    app: AppHandle,
    tray_state: tauri::State<'_, crate::tray::TrayStateHolder>,
) -> Result<(), String> {
    crate::tray::apply_playback(&app, &tray_state, &snapshot);
    write_state_file(&app, &snapshot);
    #[cfg(target_os = "linux")]
    crate::mpris::update(&snapshot);
    Ok(())
}

/// Take the state file away on the way out. Presence of the file is how a
/// watcher answers "is there a session?", so leaving a stopped snapshot behind
/// would be a lie about a window that no longer exists.
pub fn remove_state_file(app: &AppHandle) {
    let Some(dir) = state_file_path(app) else {
        return;
    };
    let _ = std::fs::remove_file(dir.join("state.json"));
}

/// Volatile per-session state belongs on the runtime tmpfs, which is also
/// where a Linux desktop widget expects to find it. Everywhere else there is
/// no such directory, so it sits beside the rest of the app data.
fn state_file_path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(runtime_dir).join("cycletron"));
    }

    app.path().app_data_dir().ok()
}

/// Best-effort: a widget that can't read the state file is a cosmetic
/// problem, and a failing write must never disturb playback.
fn write_state_file(app: &AppHandle, snapshot: &PlaybackSnapshot) {
    let Some(dir) = state_file_path(app) else {
        return;
    };

    let body = match serde_json::to_string_pretty(&StateFile {
        snapshot,
        pid: std::process::id(),
        updated_ms: chrono::Utc::now().timestamp_millis(),
    }) {
        Ok(body) => body,
        Err(e) => {
            tracing::warn!("could not serialize playback state: {e}");
            return;
        }
    };

    // Atomic rename so a reader never catches a half-written file.
    let tmp = dir.join(".state.json.tmp");
    let target = dir.join("state.json");
    let write = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&tmp, body))
        .and_then(|_| std::fs::rename(&tmp, &target));

    if let Err(e) = write {
        tracing::warn!("could not write playback state to {}: {e}", target.display());
    }
}
