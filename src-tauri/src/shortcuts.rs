//! System-wide global shortcuts. These fire even when Cycletron is not
//! the focused app — useful for live-performance transport control.
//!
//! The Rust side translates accelerator presses into `shortcut:*` events
//! that the frontend consumes (same pattern as the menu).

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Register the default set of global shortcuts. Accelerator strings follow
/// the same syntax as menu accelerators (`CmdOrCtrl+Shift+Space`, etc.).
pub fn register_defaults<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let play_pause: Shortcut = "CmdOrCtrl+Shift+Space".parse().map_err(to_tauri_err)?;
    let stop: Shortcut = "CmdOrCtrl+Shift+Period".parse().map_err(to_tauri_err)?;
    // Comma, not R: Cmd+Shift+R is hard-refresh in every browser, and a
    // global shortcut would steal it system-wide while Cycletron runs.
    let focus: Shortcut = "CmdOrCtrl+Shift+Comma".parse().map_err(to_tauri_err)?;

    let handle = app.clone();
    let gs = app.global_shortcut();

    gs.on_shortcut(play_pause, move |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = app.emit("shortcut:play_pause", ());
        }
    })
    .map_err(to_tauri_err)?;

    gs.on_shortcut(stop, move |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = app.emit("shortcut:stop", ());
        }
    })
    .map_err(to_tauri_err)?;

    gs.on_shortcut(focus, move |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            focus_main_window(&handle);
        }
    })
    .map_err(to_tauri_err)?;

    Ok(())
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn to_tauri_err<E: std::fmt::Display>(e: E) -> tauri::Error {
    tauri::Error::Anyhow(anyhow::anyhow!(e.to_string()))
}
