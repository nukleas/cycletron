// Registering app commands here generates `allow-<command>` permission
// identifiers that capabilities can grant. This is required because our
// production build serves the webview from a `http://127.0.0.1:<port>`
// origin (needed for SharedArrayBuffer support), which Tauri treats as
// "remote" content — and remote origins must explicitly opt into every
// invoke handler via capability permissions.
const COMMANDS: &[&str] = &[
    "send_message",
    "validate_pattern",
    "search_corpus",
    "get_corpus_source",
    "get_pattern_history",
    "get_config",
    "clear_session",
    "open_file",
    "save_current",
    "save_as",
    "new_file",
    "is_dirty",
    "get_current_file",
    "get_recents",
    "clear_recents",
    "session_undo",
    "session_redo",
    "get_library_root",
    "set_library_root",
    "list_library",
    "create_library_folder",
    "create_library_file",
    "delete_library_path",
    "rename_library_path",
    "reveal_in_os",
    "autosave_session",
    "restore_session",
    "tray_set_playback",
    "import_midi",
    "inspect_midi",
    "save_midi_to_library",
    "get_user_settings",
    "set_user_settings",
    "get_app_info",
    "write_binary_file",
    "list_snapshots",
    "read_snapshot",
    "get_logs",
    "clear_logs",
    "log_diagnostic",
    "diagnostic_dump",
    "set_dock_badge",
    "scan_sample_folder",
    "read_audio_file",
    "register_sound_banks",
    "list_sounds",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
