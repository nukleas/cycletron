//! System tray icon with a minimal transport menu.
//!
//! The tray reflects playback state via its tooltip + the Play/Pause label.
//! The frontend updates state by invoking `tray_set_playback`.
//! Clicking the tray icon toggles window visibility.

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub struct TrayState<R: Runtime> {
    pub play_pause_item: MenuItem<R>,
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayState<R>> {
    let play_pause_item = MenuItemBuilder::with_id("tray.play_pause", "Play").build(app)?;
    let stop_item = MenuItemBuilder::with_id("tray.stop", "Stop").build(app)?;
    let show_item = MenuItemBuilder::with_id("tray.show", "Show Cycletron").build(app)?;
    let quit_item = MenuItemBuilder::with_id("tray.quit", "Quit").build(app)?;

    let menu: Menu<R> = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&play_pause_item)
        .item(&stop_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let handle = app.clone();
    let _tray = TrayIconBuilder::with_id("cycletron-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Cycletron — stopped")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(&handle);
            }
        })
        .on_menu_event(|app, event| handle_tray_menu_event(app, event))
        .build(app)?;

    Ok(TrayState { play_pause_item })
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn handle_tray_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        "tray.show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "tray.play_pause" => {
            let _ = app.emit("tray:play_pause", ());
        }
        "tray.stop" => {
            let _ = app.emit("tray:stop", ());
        }
        "tray.quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

/// Command invoked by the frontend whenever playback state changes so the
/// tray tooltip + Play/Pause label stay in sync.
#[tauri::command]
pub fn tray_set_playback(
    state: String,
    app: AppHandle,
    tray_state: tauri::State<'_, TrayStateHolder>,
) -> Result<(), String> {
    let label = match state.as_str() {
        "playing" => "Pause",
        _ => "Play",
    };
    let tooltip = match state.as_str() {
        "playing" => "Cycletron — playing",
        "paused" => "Cycletron — paused",
        _ => "Cycletron — stopped",
    };

    if let Some(item) = tray_state.play_pause.lock().unwrap().as_ref() {
        let _ = item.set_text(label);
    }
    if let Some(tray) = app.tray_by_id("cycletron-tray") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
    Ok(())
}

/// Holds references to tray menu items that need to be mutated at runtime.
pub struct TrayStateHolder {
    pub play_pause: std::sync::Mutex<Option<MenuItem<tauri::Wry>>>,
}

impl TrayStateHolder {
    pub fn new() -> Self {
        Self {
            play_pause: std::sync::Mutex::new(None),
        }
    }
}
