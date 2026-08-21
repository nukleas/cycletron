//! Native application menu. Emits `menu:<action>` events to the frontend,
//! which translates them into file-manager / editor / examples calls.

use std::path::Path;
use tauri::menu::{
    Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn build_app_menu<R: Runtime>(
    app: &AppHandle<R>,
    recents: &[std::path::PathBuf],
) -> tauri::Result<Menu<R>> {
    // App-level (macOS conventions: Preferences with Cmd+,)
    let app_menu = SubmenuBuilder::new(app, "Cycletron")
        .item(&MenuItemBuilder::with_id("app.about", "About Cycletron").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("app.preferences", "Preferences…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit"))?)
        .build()?;

    // File → Open Recent submenu (dynamic)
    let mut open_recent = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        // Even when empty, expose a working "Open File…" item so the submenu
        // never feels broken on first launch.
        open_recent = open_recent
            .item(
                &MenuItemBuilder::with_id("file.recent_empty", "No recent files")
                    .enabled(false)
                    .build(app)?,
            )
            .separator()
            .item(&MenuItemBuilder::with_id("file.recent_open", "Open File…").build(app)?);
    } else {
        for (idx, p) in recents.iter().take(10).enumerate() {
            let label = display_recent(p);
            open_recent = open_recent
                .item(&MenuItemBuilder::with_id(format!("file.recent.{idx}"), label).build(app)?);
        }
        open_recent = open_recent
            .separator()
            .item(&MenuItemBuilder::with_id("file.recent_clear", "Clear Recent Files").build(app)?);
    }
    let open_recent = open_recent.build()?;

    // File
    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("file.new", "New")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&open_recent)
        .separator()
        .item(
            &MenuItemBuilder::with_id("file.save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.save_as", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("file.import_midi", "Import MIDI…").build(app)?)
        .item(
            &MenuItemBuilder::with_id("file.export_audio", "Export Audio…")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("file.export_midi", "Export MIDI…").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit"))?)
        .build()?;

    // Edit
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(
            &MenuItemBuilder::with_id("edit.undo", "Undo Pattern")
                .accelerator("CmdOrCtrl+Alt+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("edit.redo", "Redo Pattern")
                .accelerator("CmdOrCtrl+Alt+Shift+Z")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::undo(app, Some("Undo Text"))?)
        .item(&PredefinedMenuItem::redo(app, Some("Redo Text"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("edit.clear_session", "Clear Session").build(app)?)
        .build()?;

    // View
    let view = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("view.toggle_ai", "Toggle AI Panel")
                .accelerator("CmdOrCtrl+Shift+A")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("view.browse_examples", "Browse Examples").build(app)?)
        .item(
            &MenuItemBuilder::with_id("view.reload_corpus", "Reload Corpus & Recipes")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("view.immersive_viz", "Immersive Visualizer")
                .accelerator("CmdOrCtrl+Shift+V")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view.next_viz", "Next Visualization")
                .accelerator("CmdOrCtrl+Shift+]")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    // Playback
    let playback = SubmenuBuilder::new(app, "Playback")
        .item(
            &MenuItemBuilder::with_id("playback.toggle", "Play / Pause")
                .accelerator("CmdOrCtrl+Return")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("playback.stop", "Stop")
                .accelerator("Escape")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("playback.tempo_up", "Tempo +1").build(app)?)
        .item(&MenuItemBuilder::with_id("playback.tempo_down", "Tempo −1").build(app)?)
        .build()?;

    // Help
    let help = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("help.about", "About Cycletron").build(app)?)
        .item(&MenuItemBuilder::with_id("help.user_guide", "User Guide…").build(app)?)
        .item(&MenuItemBuilder::with_id("help.shortcuts", "Keyboard Shortcuts…").build(app)?)
        .item(&MenuItemBuilder::with_id("help.dialect", "Cycletron Dialect…").build(app)?)
        .item(&MenuItemBuilder::with_id("help.docs", "Open Strudel Docs (web)").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("help.show_logs", "Show Logs…").build(app)?)
        .item(&MenuItemBuilder::with_id("help.welcome", "Show Welcome…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("help.check_updates", "Check for Updates…").build(app)?)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&playback)
        .item(&help)
        .build()
}

/// Translate a menu click into a `menu:<action>` event for the frontend.
/// Certain actions (e.g. opening a recent file) require backend state so
/// we also inline-serve their payload. Most actions are pure UI and just
/// tell the frontend to do the work.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    tracing::info!(target: "cycletron::menu", menu_id = id, "menu event received");

    // Dynamic recents submenu: each item id is `file.recent.{idx}`. We look
    // the path up in current state (so a stale menu still resolves correctly
    // if the user has just updated the list).
    if let Some(idx_str) = id.strip_prefix("file.recent.") {
        if let Ok(idx) = idx_str.parse::<usize>() {
            let path = app
                .state::<crate::state::AppState>()
                .recents
                .lock()
                .entries
                .get(idx)
                .cloned();
            if let Some(p) = path {
                let _ = app.emit("open-files", vec![p.to_string_lossy().into_owned()]);
            }
        }
        return;
    }

    if id == "file.recent_clear" {
        let state = app.state::<crate::state::AppState>();
        let dir = state.app_data_dir();
        {
            let mut r = state.recents.lock();
            *r = crate::files::Recents::new();
            if let Some(dir) = dir {
                let _ = r.save(&dir);
            }
        }
        let _ = rebuild_menu(app);
        return;
    }

    let topic = match id {
        "app.about" | "help.about" => "menu:about",
        "app.preferences" => "menu:preferences",
        "file.new" => "menu:new",
        "file.open" | "file.recent_open" => "menu:open",
        "file.save" => "menu:save",
        "file.save_as" => "menu:save_as",
        "file.import_midi" => "menu:import_midi",
        "file.export_audio" => "menu:export_audio",
        "file.export_midi" => "menu:export_midi",
        "edit.undo" => "menu:undo",
        "edit.redo" => "menu:redo",
        "edit.clear_session" => "menu:clear_session",
        "view.toggle_ai" => "menu:toggle_ai",
        "view.browse_examples" => "menu:browse_examples",
        "view.reload_corpus" => "menu:reload_corpus",
        "view.immersive_viz" => "menu:immersive_viz",
        "view.next_viz" => "menu:next_viz",
        "playback.toggle" => "menu:play_pause",
        "playback.stop" => "menu:stop",
        "playback.tempo_up" => "menu:tempo_up",
        "playback.tempo_down" => "menu:tempo_down",
        "help.user_guide" => "menu:user_guide",
        "help.shortcuts" => "menu:shortcuts",
        "help.dialect" => "menu:dialect",
        "help.docs" => "menu:docs",
        "help.show_logs" => "menu:show_logs",
        "help.welcome" => "menu:welcome",
        "help.check_updates" => "menu:check_updates",
        _ => return,
    };
    match app.emit(topic, ()) {
        Ok(_) => tracing::info!(target: "cycletron::menu", topic, "emitted menu topic"),
        Err(e) => {
            tracing::error!(target: "cycletron::menu", topic, error = ?e, "failed to emit menu topic")
        }
    }
}

/// Rebuild the application menu from the current recents list and apply it.
/// Call this whenever the recents list changes so the submenu stays fresh.
pub fn rebuild_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let recents = app
        .state::<crate::state::AppState>()
        .recents
        .lock()
        .entries
        .clone();
    let menu = build_app_menu(app, &recents)?;
    app.set_menu(menu)?;
    Ok(())
}

/// Truncate paths for display in the Open Recent submenu so very long
/// paths don't blow out the menu width.
fn display_recent(path: &Path) -> String {
    let s = path.to_string_lossy();
    if s.len() <= 48 {
        return s.into_owned();
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| s.to_string());
    let parent = path
        .parent()
        .map(|p| p.to_string_lossy())
        .unwrap_or_default();
    if parent.is_empty() {
        return name;
    }
    let tail = parent
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or("");
    if tail.is_empty() {
        return name;
    }
    format!("{tail}/{name}")
}
