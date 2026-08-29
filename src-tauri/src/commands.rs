use crate::agent_loop;
use crate::files::{self, FileDoc, Recents};
use crate::library::{self, DirEntry};
use crate::logs::{self, LogEntry};
use crate::settings::UserSettings;
use crate::snapshots::{self, Snapshot};
use crate::state::AppState;
use cycletron_analysis as strudel;
use cycletron_midi as midi;
use midi_to_strudel::{InstrumentMode, SectionNamingStrategy, drums::DrumBank};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};

/// Send a user message to the AI composer.
/// `editor_code` is the current content of the WASM REPL editor, passed
/// from the frontend so the AI always knows what's playing.
#[tauri::command]
pub async fn send_message(
    message: String,
    editor_code: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    {
        let mut session = state.session.lock();
        if let Some(code) = &editor_code {
            session.current_pattern = Some(code.clone());
        }
        session.add_user_message(message.clone());
    }

    // Refresh subscription OAuth before building the client so the bearer is not
    // stale. `crate::oauth` owns which providers this applies to.
    {
        let active = state.user_settings.lock().llm.active.clone();
        if crate::oauth::refresh_if_stale(&active).await {
            state.rebuild_agent_client();
        }
    }

    let Some(client) = state.agent_client.lock().clone() else {
        let msg = "AI is off. Turn it on with “Enable AI” in the AI panel, then pick a provider in Preferences → AI (or sign in with SuperGrok / add an API key).";
        let mut session = state.session.lock();
        session.add_assistant_message(msg.to_string());
        return Ok(msg.to_string());
    };

    let messages = {
        let session = state.session.lock();
        session.messages.clone()
    };

    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

    let handle = app_handle.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = handle.emit("agent-event", &event);
        }
    });

    let result = agent_loop::run_agent_loop(client.as_ref(), &messages, &state, event_tx).await;
    let _ = forwarder.await;

    match result {
        Ok((response, tools)) => {
            let mut session = state.session.lock();
            session.add_assistant_message_with_tools(response.clone(), tools);
            Ok(response)
        }
        Err(e) => {
            let error_msg = format!("Agent error: {e}");
            let mut session = state.session.lock();
            session.add_assistant_message(error_msg.clone());
            Ok(error_msg)
        }
    }
}

/// Validate a pattern without playing (backend validation via strudel-dsl).
#[tauri::command]
pub fn validate_pattern(code: String) -> Result<String, String> {
    if code.trim().is_empty() {
        return Ok("empty".to_string());
    }
    match strudel::validate_code(&code) {
        Ok(_) => Ok("valid".to_string()),
        Err(e) => Ok(format!("invalid: {e}")),
    }
}

/// Inspect a pattern: evaluate it and return a structured digest of what it
/// actually emits (events per cycle, sounds, pitch range, loop length, silent
/// cycles). Lets the editor "see" a pattern, mirroring the agent's tool.
#[tauri::command]
pub fn inspect_pattern(
    code: String,
    cycles: Option<usize>,
) -> Result<strudel::PatternDigest, String> {
    strudel::Evaluated::new(&code, cycles.unwrap_or(8)).map(strudel::Evaluated::into_digest)
}

/// Analyze a pattern's arrangement: detect the loop period and segment it into
/// sections by active instrumentation, with the song form and wall-clock
/// lengths. Scans up to `max_cycles` (default 32).
#[tauri::command]
pub fn analyze_arrangement(
    code: String,
    max_cycles: Option<usize>,
) -> Result<strudel::ArrangementAnalysis, String> {
    strudel::Evaluated::new(&code, max_cycles.unwrap_or(32)).map(|ev| strudel::analyze(&ev))
}

/// Detect one-playthrough length for offline export (WAV/MIDI).
///
/// Unlike `analyze_arrangement` (short loop window for the agent), this scans
/// far enough to resolve full MIDI dumps and `pickRestart` forms. Returns
/// `None` fields when no clean length is found.
#[tauri::command]
pub fn detect_pattern_length(
    code: String,
    max_cycles: Option<usize>,
) -> Result<Option<strudel::PatternLength>, String> {
    strudel::detect_pattern_length(&code, max_cycles.unwrap_or(1024))
}

/// Critique a pattern: heuristic musical lint (clipping, silent cycles, mono
/// image, semitone clashes, missing low end, static pitch). Not correctness —
/// that's validate_pattern — but whether it's likely to sound good.
#[tauri::command]
pub fn critique_pattern(code: String, cycles: Option<usize>) -> Result<strudel::Critique, String> {
    strudel::Evaluated::new(&code, cycles.unwrap_or(16).max(4)).map(|ev| strudel::critique(&ev))
}

/// Critique a pattern's FORM: section-length grid, energy contrast/build,
/// robotic 1-bar loops under long sections, and (with pickRestart labels)
/// name-vs-density sanity. Reuses the `Critique` shape as `critique_pattern`.
#[tauri::command]
pub fn critique_form(code: String, cycles: Option<usize>) -> Result<strudel::Critique, String> {
    strudel::Evaluated::new(&code, cycles.unwrap_or(32).clamp(8, 64))
        .map(|ev| strudel::critique_form(&ev))
}

/// Genre recipes. With no `genre`, returns every loaded recipe (for a picker);
/// with a `genre`, returns the matching recipe(s) by name or alias.
#[tauri::command]
pub fn genre_recipe(
    genre: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<cycletron_corpus::Recipe>, String> {
    let recipes = state.recipes.lock();
    match genre {
        Some(q) if !q.trim().is_empty() => {
            Ok(recipes.iter().filter(|r| r.matches(&q)).cloned().collect())
        }
        _ => Ok(recipes.clone()),
    }
}

/// Reload the corpus index and genre recipes from disk. Recipes are otherwise
/// read once at startup, so a running app never picks up newly-generated recipes
/// (e.g. after `cargo run -p gen-recipes`) until restart — this refreshes them in
/// place. Returns the number of recipes now loaded.
#[tauri::command]
pub fn reload_corpus(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(state.load_knowledge())
}

/// Get pattern history for the current session.
#[tauri::command]
pub fn get_pattern_history(
    state: State<'_, AppState>,
) -> Vec<cycletron_core::session::PatternEntry> {
    let session = state.session.lock();
    session.pattern_history.clone()
}

/// Get current config.
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> cycletron_core::config::AppConfig {
    state.config.lock().clone()
}

/// Clear the session — reset chat history and pattern state for a new composition.
#[tauri::command]
pub fn clear_session(state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.lock();
    let tempo = config.audio.default_tempo;
    drop(config);
    let mut session = state.session.lock();
    *session = cycletron_core::session::Session::new(tempo);
    Ok(())
}

// ---------------------------------------------------------------------------
// File lifecycle
// ---------------------------------------------------------------------------

/// Open a file and load its contents into the session.
#[tauri::command]
pub fn open_file(
    path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<FileDoc, String> {
    let pb = PathBuf::from(&path);
    let doc = files::read_file(&pb).map_err(|e| format!("read {}: {e}", pb.display()))?;

    {
        let mut session = state.session.lock();
        session.load_code(doc.code.clone(), Some(pb.clone()));
        if let Some(fm) = &doc.frontmatter
            && let Some(bpm) = fm.bpm
        {
            session.tempo = bpm;
        }
    }
    push_recent(&state, pb.clone());
    rebuild_menu_after_recents_change(&app_handle);

    Ok(doc)
}

/// Save the current buffer to the session's existing file path. Errors if
/// there is no current file — the UI should fall back to `save_as` in that case.
#[tauri::command]
pub fn save_current(
    code: String,
    bpm: Option<f64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = {
        let session = state.session.lock();
        session
            .file_path
            .clone()
            .ok_or_else(|| "no current file — use save_as".to_string())?
    };
    files::write_file(&path, &code, bpm).map_err(|e| format!("write {}: {e}", path.display()))?;

    if let Some(dir) = state.app_data_dir() {
        snapshots::record(&dir, &path, &code);
    }

    {
        let mut session = state.session.lock();
        session.mark_saved(path.clone(), code);
        if let Some(b) = bpm {
            session.tempo = b;
        }
    }

    Ok(path.to_string_lossy().into_owned())
}

/// Save the current buffer to a new path.
#[tauri::command]
pub fn save_as(
    path: String,
    code: String,
    bpm: Option<f64>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let pb = PathBuf::from(&path);
    files::write_file(&pb, &code, bpm).map_err(|e| format!("write {}: {e}", pb.display()))?;

    if let Some(dir) = state.app_data_dir() {
        snapshots::record(&dir, &pb, &code);
    }

    {
        let mut session = state.session.lock();
        session.mark_saved(pb.clone(), code);
        if let Some(b) = bpm {
            session.tempo = b;
        }
    }
    push_recent(&state, pb.clone());
    rebuild_menu_after_recents_change(&app_handle);

    Ok(pb.to_string_lossy().into_owned())
}

/// Clear the current file reference and editor buffer.
#[tauri::command]
pub fn new_file(state: State<'_, AppState>) -> Result<(), String> {
    let mut session = state.session.lock();
    session.new_file();
    Ok(())
}

/// Check whether `code` differs from the last-saved snapshot.
#[tauri::command]
pub fn is_dirty(code: String, state: State<'_, AppState>) -> bool {
    let session = state.session.lock();
    session.is_dirty(&code)
}

/// Metadata about the current file (path + dirty state).
#[derive(serde::Serialize)]
pub struct CurrentFile {
    pub path: Option<String>,
    pub name: Option<String>,
    pub dirty: bool,
}

#[tauri::command]
pub fn get_current_file(code: String, state: State<'_, AppState>) -> CurrentFile {
    let session = state.session.lock();
    let path = session.file_path.clone();
    CurrentFile {
        dirty: session.is_dirty(&code),
        name: path
            .as_ref()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),
        path: path.map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn get_recents(state: State<'_, AppState>) -> Vec<String> {
    state
        .recents
        .lock()
        .entries
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub fn clear_recents(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state
        .app_data_dir()
        .ok_or_else(|| "app data dir not initialized".to_string())?;
    let mut r = state.recents.lock();
    *r = Recents::new();
    r.save(&dir).map_err(|e| e.to_string())
}

fn push_recent(state: &State<'_, AppState>, path: PathBuf) {
    {
        let mut recents = state.recents.lock();
        recents.push(path);
        if let Some(dir) = state.app_data_dir()
            && let Err(e) = recents.save(&dir)
        {
            tracing::warn!("failed to persist recents: {e}");
        }
    }
}

/// Rebuild the native menu so the Open Recent submenu stays fresh.
/// Called from `open_file` / `save_as` after `push_recent` has updated state.
fn rebuild_menu_after_recents_change(app: &tauri::AppHandle) {
    if let Err(e) = crate::menu::rebuild_menu(app) {
        tracing::warn!("rebuild_menu after recents change: {e}");
    }
}

// ---------------------------------------------------------------------------
// MIDI import
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct MidiImport {
    pub code: String,
    pub bpm: f64,
    pub source_path: String,
    /// In-memory cleanup stats (source file is never rewritten).
    pub cleanup: midi::CleanupReport,
}

/// Frontend-supplied MIDI conversion options. All fields optional; missing
/// fields fall back to the backend defaults. String-typed enums (instrument
/// mode, drum bank) are validated server-side.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportMidiOptions {
    pub notes_per_bar: Option<usize>,
    pub auto_resolution: Option<bool>,
    pub bar_limit: Option<usize>,
    pub compact: Option<bool>,
    pub compose: Option<bool>,
    pub section_naming: Option<String>,
    pub detect_drum_names: Option<bool>,
    pub instrument_mode: Option<String>,
    pub drum_bank: Option<String>,
    pub included_channels: Option<Vec<u8>>,
    /// Master switch for pre-conversion cleanup. When `Some(false)`, all
    /// cleanup is disabled regardless of the per-knob fields below.
    pub cleanup: Option<bool>,
    /// Drop notes shorter than 1/N of a quarter. 0 = off. Typical 16/32/64.
    pub short_note_divisor: Option<u32>,
    pub remove_duplicates: Option<bool>,
    /// `"off" | "moderate" | "strong"`.
    pub velocity_mode: Option<String>,
}

fn build_import_options(input: Option<ImportMidiOptions>) -> Result<midi::ImportOptions, String> {
    let mut opts = midi::ImportOptions::default();
    let Some(input) = input else {
        return Ok(opts);
    };
    if let Some(n) = input.notes_per_bar {
        opts.notes_per_bar = n;
    }
    if let Some(b) = input.auto_resolution {
        opts.auto_resolution = b;
    }
    if let Some(n) = input.bar_limit {
        opts.bar_limit = n;
    }
    if let Some(b) = input.compact {
        opts.compact = b;
    }
    if let Some(b) = input.compose {
        opts.compose = b;
    }
    if let Some(s) = input.section_naming.as_deref() {
        opts.section_naming = match s.to_ascii_lowercase().as_str() {
            "heuristic" => SectionNamingStrategy::Heuristic,
            "generic" => SectionNamingStrategy::Generic,
            other => return Err(format!("unknown section_naming: {other}")),
        };
    }
    if let Some(b) = input.detect_drum_names {
        opts.detect_drum_names = b;
    }
    if let Some(s) = input.instrument_mode.as_deref() {
        opts.instrument_mode =
            InstrumentMode::parse(s).ok_or_else(|| format!("unknown instrument_mode: {s}"))?;
    }
    if let Some(s) = input.drum_bank.as_deref() {
        opts.drum_bank = DrumBank::parse(s).ok_or_else(|| format!("unknown drum_bank: {s}"))?;
    }
    if let Some(chs) = input.included_channels {
        opts.included_channels = Some(chs);
    }

    // Cleanup knobs. Master `cleanup: false` forces everything off; otherwise
    // individual fields override the conservative defaults.
    if input.cleanup == Some(false) {
        opts.cleanup = midi::CleanupOptions::off();
    } else {
        if let Some(n) = input.short_note_divisor {
            opts.cleanup.short_note_divisor = n;
        }
        if let Some(b) = input.remove_duplicates {
            opts.cleanup.remove_duplicates = b;
        }
        if let Some(s) = input.velocity_mode.as_deref() {
            opts.cleanup.velocity_mode = midi::VelocityMode::parse(s)
                .ok_or_else(|| format!("unknown velocity_mode: {s}"))?;
        }
    }
    Ok(opts)
}

/// Convert a .mid file at `path` into strudel code. Does NOT touch the
/// session's current file — the UI treats the result as an unsaved buffer
/// derived from MIDI.
#[tauri::command]
pub fn import_midi(path: String, options: Option<ImportMidiOptions>) -> Result<MidiImport, String> {
    let pb = PathBuf::from(&path);
    let opts = build_import_options(options)?;
    let result = midi::convert_file(&pb, &opts).map_err(|e| format!("midi import: {e:#}"))?;
    Ok(MidiImport {
        code: result.code,
        bpm: result.bpm,
        source_path: pb.to_string_lossy().into_owned(),
        cleanup: result.cleanup,
    })
}

/// Inspect a .mid file without converting. Returns track-level metadata so
/// the MIDI Lab UI can render checkboxes + per-track stats.
#[tauri::command]
pub fn inspect_midi(path: String) -> Result<midi::MidiMetadata, String> {
    let pb = PathBuf::from(&path);
    midi::inspect_file(&pb).map_err(|e| format!("midi inspect: {e:#}"))
}

/// Convert a .mid file and write the resulting strudel into the user
/// library. `file_name` is optional — derived from `path` if absent.
/// Returns the absolute path of the written file so the caller can open it
/// via `fileManager.openPath`.
#[tauri::command]
pub fn save_midi_to_library(
    path: String,
    options: Option<ImportMidiOptions>,
    target_dir: Option<String>,
    file_name: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let pb = PathBuf::from(&path);
    let opts = build_import_options(options)?;
    let result = midi::convert_file(&pb, &opts).map_err(|e| format!("midi import: {e:#}"))?;

    let root = state.library_root();
    let dir = match target_dir.as_deref() {
        Some(d) if !d.is_empty() => {
            let candidate = PathBuf::from(d);
            if !library::within(&root, &candidate) {
                return Err(format!("{} is outside the library", candidate.display()));
            }
            candidate
        }
        _ => root.clone(),
    };
    library::ensure_root_exists(&dir).map_err(|e| e.to_string())?;

    let base = file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::string::ToString::to_string)
        .unwrap_or_else(|| {
            pb.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "imported".to_string())
        });
    let with_ext = if base.ends_with(".strudel") || base.ends_with(".js") {
        base
    } else {
        format!("{base}.strudel")
    };

    let mut target = dir.join(&with_ext);
    // Refuse silent overwrite — bump a numeric suffix instead.
    let mut suffix = 1u32;
    while target.exists() {
        let stem = target
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("imported")
            .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-')
            .to_string();
        let ext = target
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("strudel");
        target = dir.join(format!("{stem}-{suffix}.{ext}"));
        suffix += 1;
    }

    files::write_file(&target, &result.code, Some(result.bpm))
        .map_err(|e| format!("write {}: {e}", target.display()))?;

    let _ = app_handle.emit("library-changed", target.to_string_lossy().into_owned());
    Ok(target.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Undo / redo (pattern history)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn session_undo(state: State<'_, AppState>) -> Option<String> {
    let mut session = state.session.lock();
    session.undo().map(std::string::ToString::to_string)
}

#[tauri::command]
pub fn session_redo(state: State<'_, AppState>) -> Option<String> {
    let mut session = state.session.lock();
    session.redo().map(std::string::ToString::to_string)
}

// ---------------------------------------------------------------------------
// User library (file explorer)
// ---------------------------------------------------------------------------

/// Return the current library root as a string.
#[tauri::command]
pub fn get_library_root(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.library_root().to_string_lossy().into_owned())
}

/// Change the library root and persist the new setting.
/// Initializes the folder the same way as first launch: create + seed `Demos/`.
#[tauri::command]
pub fn set_library_root(
    path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let pb = PathBuf::from(&path);
    library::prepare_root(&pb)?;
    {
        let mut lib = state.library.lock();
        lib.root = pb.clone();
        if let Some(dir) = state.app_data_dir()
            && let Err(e) = lib.save(&dir)
        {
            tracing::warn!("persist library settings: {e}");
        }
    }
    let _ = app_handle.emit("library-changed", &path);
    Ok(pb.to_string_lossy().into_owned())
}

/// List a directory inside the library. Defaults to the library root when
/// `path` is `None`.
#[tauri::command]
pub fn list_library(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<DirEntry>, String> {
    let root = state.library_root();
    library::ensure_root_exists(&root).map_err(|e| e.to_string())?;

    let target = match path.as_deref() {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => root.clone(),
    };
    if !library::within(&root, &target) {
        return Err(format!("{} is outside the library", target.display()));
    }
    library::list_dir(&target).map_err(|e| format!("list {}: {e}", target.display()))
}

#[tauri::command]
pub fn create_library_folder(
    path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let target = guard_path(&state, &path)?;
    library::create_dir(&target).map_err(|e| format!("mkdir {}: {e}", target.display()))?;
    let _ = app_handle.emit("library-changed", &path);
    Ok(())
}

/// Create a new (empty-ish) strudel file. Writes the standard frontmatter
/// so the new file is round-trip compatible with `files::read_file`.
#[tauri::command]
pub fn create_library_file(
    path: String,
    bpm: Option<f64>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let target = guard_path(&state, &path)?;
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    files::write_file(&target, "", bpm).map_err(|e| format!("write {}: {e}", target.display()))?;
    let _ = app_handle.emit("library-changed", &path);
    Ok(())
}

#[tauri::command]
pub fn delete_library_path(
    path: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let target = guard_path(&state, &path)?;
    let root = state.library_root();
    if target == root {
        return Err("cannot delete the library root".to_string());
    }
    library::delete_path(&target).map_err(|e| format!("delete {}: {e}", target.display()))?;
    // If the deleted path was the current session file, clear the session.
    {
        let mut session = state.session.lock();
        if session.file_path.as_deref() == Some(target.as_path()) {
            session.new_file();
        }
    }
    let _ = app_handle.emit("library-changed", &path);
    Ok(())
}

#[tauri::command]
pub fn rename_library_path(
    from: String,
    to: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let src = guard_path(&state, &from)?;
    let dst = guard_path(&state, &to)?;
    library::rename_path(&src, &dst).map_err(|e| format!("rename: {e}"))?;
    // Update session if the renamed path was the current file.
    {
        let mut session = state.session.lock();
        if session.file_path.as_deref() == Some(src.as_path()) {
            session.file_path = Some(dst.clone());
        }
    }
    let _ = app_handle.emit("library-changed", &to);
    Ok(())
}

/// Reveal `path` in the OS file manager (Finder / Explorer / xdg-open).
#[tauri::command]
pub fn reveal_in_os(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let target = guard_path(&state, &path)?;
    library::reveal_in_os(&target)
}

fn guard_path(state: &State<'_, AppState>, path: &str) -> Result<PathBuf, String> {
    let root = state.library_root();
    let pb = PathBuf::from(path);
    if !library::within(&root, &pb) {
        return Err(format!("{} is outside the library", pb.display()));
    }
    Ok(pb)
}

// ---------------------------------------------------------------------------
// User settings (Preferences modal)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_user_settings(state: State<'_, AppState>) -> UserSettings {
    state.user_settings.lock().clone()
}

/// Persist `settings` and rebuild dependent state (e.g. the AI client).
/// API keys are NOT part of `settings` — they go through `set_provider_key`
/// into the OS keychain.
#[tauri::command]
pub fn set_user_settings(
    settings: UserSettings,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // A non-bundled sample set is only meaningful once it's on disk.
    if !crate::sample_sets::is_ready(&app_handle, &settings.samples.active) {
        return Err(format!(
            "Sample set '{}' is not downloaded — download it first (Samples manager).",
            settings.samples.active
        ));
    }

    // Apply to the in-memory config so the rest of the app sees the change.
    {
        let mut config = state.config.lock();
        settings.apply_to(&mut config);
    }

    // Persist to disk and swap in the new settings before rebuilding, so the
    // rebuild reads the just-selected provider profile.
    {
        let mut current = state.user_settings.lock();
        *current = settings;
        if let Some(dir) = state.app_data_dir() {
            current.save(&dir).map_err(|e| e.to_string())?;
        }
    }
    // The agent's sound catalog follows the active sample set.
    crate::sample_sets::refresh_bank_names(&app_handle);
    state.rebuild_agent_client();
    Ok(())
}

/// Store (or clear, when `key` is empty) a provider's API key, then rebuild
/// the client so the change takes effect immediately.
/// Debug: app-data file. Release: OS keychain.
/// `provider` is the provider id: `"anthropic"`, `"grok"`, `"openai"`, etc.
#[tauri::command]
pub fn set_provider_key(
    provider: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::secrets::set_key(&provider, &key)?;
    state.rebuild_agent_client();
    Ok(())
}

/// Whether a usable key exists for `provider` (stored secret or env fallback).
/// The key value itself is never returned to the frontend.
#[tauri::command]
pub fn has_provider_key(provider: String) -> bool {
    crate::secrets::has_key(&provider)
}

// ---------------------------------------------------------------------------
// xAI SuperGrok / SuperHeavy OAuth
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn xai_oauth_status() -> crate::xai_oauth::OAuthStatus {
    crate::xai_oauth::status()
}

/// Copy a Grok Build / Grok CLI session from `~/.grok/auth.json` into Cycletron.
#[tauri::command]
pub fn xai_oauth_import_grok_build(
    state: State<'_, AppState>,
) -> Result<crate::xai_oauth::OAuthStatus, String> {
    let status = crate::xai_oauth::import_from_grok_build()?;
    state.rebuild_agent_client();
    Ok(status)
}

/// Begin device-code login. Opens the verification URL in the system browser.
#[tauri::command]
pub async fn xai_oauth_start_login(
    app: tauri::AppHandle,
) -> Result<crate::xai_oauth::DeviceStart, String> {
    let start = crate::xai_oauth::start_device_login().await?;
    let url = start
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| start.verification_uri.clone());
    // Best-effort browser open; UI also shows the code/URL.
    use tauri_plugin_opener::OpenerExt as _;
    let _ = app.opener().open_url(url, Option::<String>::None);
    Ok(start)
}

/// Poll until the user approves the device code from [`xai_oauth_start_login`].
#[tauri::command]
pub async fn xai_oauth_poll_login(
    device_code: String,
    interval: u64,
    expires_in: u64,
    state: State<'_, AppState>,
) -> Result<crate::xai_oauth::OAuthStatus, String> {
    let status = crate::xai_oauth::poll_device_login(&device_code, interval, expires_in).await?;
    // Prefer Grok as the active provider after a successful OAuth login.
    {
        let mut us = state.user_settings.lock();
        if us.llm.active != "grok" {
            us.llm.active = "grok".into();
            if let Some(dir) = state.app_data_dir() {
                let _ = us.save(&dir);
            }
        }
    }
    state.rebuild_agent_client();
    Ok(status)
}

#[tauri::command]
pub fn xai_oauth_logout(state: State<'_, AppState>) -> Result<(), String> {
    crate::xai_oauth::logout()?;
    state.rebuild_agent_client();
    Ok(())
}

// ---------------------------------------------------------------------------
// ChatGPT / Codex OAuth (subscription)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn codex_oauth_status() -> crate::codex_oauth::CodexOAuthStatus {
    crate::codex_oauth::status()
}

/// Copy a Codex CLI session from `~/.codex/auth.json` into Cycletron.
#[tauri::command]
pub fn codex_oauth_import_cli(
    state: State<'_, AppState>,
) -> Result<crate::codex_oauth::CodexOAuthStatus, String> {
    let status = crate::codex_oauth::import_from_codex_cli()?;
    // Prefer Codex as active after import.
    {
        let mut us = state.user_settings.lock();
        us.llm.active = "codex".into();
        if let Some(dir) = state.app_data_dir() {
            let _ = us.save(&dir);
        }
    }
    state.rebuild_agent_client();
    Ok(status)
}

/// Browser PKCE login (same client as `codex login`). Binds localhost:1455.
#[tauri::command]
pub async fn codex_oauth_login(
    state: State<'_, AppState>,
) -> Result<crate::codex_oauth::CodexOAuthStatus, String> {
    let status = crate::codex_oauth::login_with_browser().await?;
    {
        let mut us = state.user_settings.lock();
        us.llm.active = "codex".into();
        if let Some(dir) = state.app_data_dir() {
            let _ = us.save(&dir);
        }
    }
    state.rebuild_agent_client();
    Ok(status)
}

#[tauri::command]
pub fn codex_oauth_logout(state: State<'_, AppState>) -> Result<(), String> {
    crate::codex_oauth::logout()?;
    state.rebuild_agent_client();
    Ok(())
}

// ---------------------------------------------------------------------------
// App metadata (About modal)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
    pub tauri_version: String,
}

#[tauri::command]
pub fn get_app_info(app_handle: tauri::AppHandle) -> AppInfo {
    let package = app_handle.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        identifier: app_handle.config().identifier.clone(),
        tauri_version: tauri::VERSION.to_string(),
    }
}

/// List snapshots for a given file path (most recent first).
#[tauri::command]
pub fn list_snapshots(path: String, state: State<'_, AppState>) -> Result<Vec<Snapshot>, String> {
    let dir = state
        .app_data_dir()
        .ok_or_else(|| "app data dir not initialized".to_string())?;
    Ok(snapshots::list(&dir, std::path::Path::new(&path)))
}

/// Return the code of a specific snapshot (does NOT touch the editor).
#[tauri::command]
pub fn read_snapshot(
    path: String,
    snapshot_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dir = state
        .app_data_dir()
        .ok_or_else(|| "app data dir not initialized".to_string())?;
    snapshots::read(&dir, std::path::Path::new(&path), &snapshot_id)
        .map_err(|e| format!("read snapshot: {e}"))
}

/// Set or clear the macOS dock / Linux taskbar badge.
/// `count == 0` clears the badge.
#[tauri::command]
pub fn set_dock_badge(count: u32, app_handle: tauri::AppHandle) -> Result<(), String> {
    let target = if count == 0 { None } else { Some(count) };
    if let Some(window) = app_handle.get_webview_window("main") {
        window
            .set_badge_count(target.map(|n| n as i64))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the in-memory ring buffer of recent log lines.
#[tauri::command]
pub fn get_logs() -> Vec<LogEntry> {
    logs::snapshot()
}

#[tauri::command]
pub fn clear_logs() {
    logs::clear()
}

/// Append a frontend-originated event into the same in-memory log ring
/// that powers the Logs modal. Used to capture drag-drop / menu / dialog
/// events from the webview so we can debug release builds where the JS
/// console isn't visible.
#[tauri::command]
pub fn log_diagnostic(level: String, target: String, message: String) {
    let tgt = if target.is_empty() {
        "cycletron::frontend".to_string()
    } else {
        target
    };
    match level.as_str() {
        "error" => tracing::error!(target: "cycletron::frontend", source = %tgt, "{}", message),
        "warn" => tracing::warn!(target: "cycletron::frontend", source = %tgt, "{}", message),
        "debug" => tracing::debug!(target: "cycletron::frontend", source = %tgt, "{}", message),
        _ => tracing::info!(target: "cycletron::frontend", source = %tgt, "{}", message),
    }
}

/// Produce a copy-and-paste diagnostic dump: app + OS version followed
/// by the recent log buffer. Useful for bug reports.
#[tauri::command]
pub fn diagnostic_dump(app_handle: tauri::AppHandle) -> String {
    let package = app_handle.package_info();
    let identifier = app_handle.config().identifier.clone();
    let mut out = String::new();
    out.push_str("=== Cycletron diagnostic dump ===\n");
    out.push_str(&format!(
        "App      : {} {}\n",
        package.name, package.version
    ));
    out.push_str(&format!("Bundle   : {}\n", identifier));
    out.push_str(&format!("Tauri    : {}\n", tauri::VERSION));
    out.push_str(&format!(
        "OS       : {} {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    out.push_str(&format!("Time     : {}\n", chrono::Utc::now().to_rfc3339()));
    out.push_str("\n=== Recent logs ===\n");
    for entry in logs::snapshot() {
        out.push_str(&format!(
            "{} {:>5} {} - {}\n",
            chrono::DateTime::from_timestamp_millis(entry.ts_ms)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default(),
            entry.level,
            entry.target,
            entry.message,
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Offline export (WAV / MP3 / stems / MIDI)
// ---------------------------------------------------------------------------

/// Offline-render the editor pattern to WAV and/or MP3 (same engine as
/// `strudio render`), optionally splitting multi-track stems.
///
/// `format` is `"wav"`, `"mp3"`, or `"both"`. MP3 requires `ffmpeg` on PATH.
/// `stems` splits `$:` tracks or a top-level `stack(...)` into separate files.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_audio(
    code: String,
    path: String,
    duration_secs: f64,
    bpm: Option<f64>,
    gain: Option<f32>,
    format: String,
    stems: bool,
    app_handle: tauri::AppHandle,
) -> Result<crate::export::ExportAudioResult, String> {
    let fmt = crate::export::AudioFormat::parse(&format)?;
    let samples = active_sample_set(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::export::export_audio(&code, &path, duration_secs, bpm, gain, fmt, stems, &samples)
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
}

/// Resolve the sample-set manifests the active set renders exports from —
/// the same set live playback loads, so the two cannot drift apart.
fn active_sample_set(app: &tauri::AppHandle) -> Result<crate::export::SampleSetPaths, String> {
    let active = app
        .state::<AppState>()
        .user_settings
        .lock()
        .samples
        .active
        .clone();
    if active == crate::sample_sets::BUNDLED_SET_ID {
        let manifest = app
            .path()
            .resolve(
                "cycletron.strudel.json",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("could not resolve bundled sample manifest: {e}"))?;
        if !manifest.is_file() {
            return Err(format!(
                "bundled sample manifest missing: {}",
                manifest.display()
            ));
        }
        return Ok(crate::export::SampleSetPaths::Cycletron { manifest });
    }
    let manifests = crate::sample_sets::manifest_paths(app, &active)?;
    if manifests.iter().any(|m| !m.is_file()) {
        return Err(format!(
            "sample set '{active}' is not downloaded — download it in the Samples manager"
        ));
    }
    Ok(crate::export::SampleSetPaths::Strudel { manifests })
}

/// Convert the current pattern to a Standard MIDI File (`strudio to-midi`).
#[tauri::command]
pub async fn export_midi(
    code: String,
    path: String,
    cycles: u32,
    bpm: Option<f64>,
) -> Result<crate::export::ExportMidiResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::export::export_midi(&code, &path, cycles, bpm)
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// External-change watcher
// ---------------------------------------------------------------------------

/// Spawn a background thread that polls the current session file's mtime
/// and emits `file-externally-changed` when something else modifies it on
/// disk. Polling is cheap (one stat call every ~1.5s) and is correct
/// enough for editor-style "reload?" prompts without dragging in `notify`.
///
/// Uses a plain `std::thread` rather than `tokio::spawn` so it works
/// regardless of whether a tokio runtime is currently entered — Tauri's
/// `setup` callback isn't inside one.
pub fn spawn_external_change_watcher(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_path: Option<PathBuf> = None;
        let mut last_mtime: Option<std::time::SystemTime> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let state: tauri::State<'_, AppState> = app_handle.state::<AppState>();
            let current_path: Option<PathBuf> = {
                let session = state.session.lock();
                session.file_path.clone()
            };
            // Reset the baseline when the user opens a different file.
            if current_path != last_path {
                last_path = current_path.clone();
                last_mtime = current_path
                    .as_ref()
                    .and_then(|p| std::fs::metadata(p).ok())
                    .and_then(|m| m.modified().ok());
                continue;
            }
            let Some(path) = current_path else { continue };
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            // First sighting just records the baseline.
            let Some(prev) = last_mtime else {
                last_mtime = Some(modified);
                continue;
            };
            if modified != prev {
                last_mtime = Some(modified);
                let _ = app_handle.emit(
                    "file-externally-changed",
                    path.to_string_lossy().into_owned(),
                );
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Single-instance hand-off (file associations)
// ---------------------------------------------------------------------------

/// Called by the single-instance plugin when a second launch happens — e.g.
/// the user double-clicks a `.strudel` or `.mid` file in Finder. We refocus
/// the existing window and forward any file paths to the frontend.
pub fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>) {
    // Bring the main window forward.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    // Filter out flags / the binary path; keep things that look like file paths.
    let paths: Vec<String> = args
        .into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && std::path::Path::new(a).exists())
        .collect();

    if !paths.is_empty() {
        let _ = app.emit("open-files", paths);
    }
}

/// Installed-app path captured at startup. After an update installs, the
/// running executable has been *moved* to a temp backup (macOS: the updater
/// renames the live bundle to `$TMPDIR/tauri_current_app*` before dropping
/// the new one into place), so resolving `current_exe()` at relaunch time
/// points at the stale copy and boots the old version. Capturing before any
/// update can run pins the true install location.
static INSTALLED_APP: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Call once, early in `run()`, before the updater could possibly fire.
pub fn capture_installed_app_path() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    // macOS: relaunch the .app bundle, not the inner binary.
    #[cfg(target_os = "macos")]
    let path = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(std::path::Path::to_path_buf)
        .unwrap_or(exe);
    #[cfg(not(target_os = "macos"))]
    let path = exe;
    let _ = INSTALLED_APP.set(path);
}

/// Relaunch into the *installed* app after an update, then exit.
///
/// Spawns a detached, slightly delayed launcher so this process is fully
/// gone before the new one starts — otherwise the single-instance plugin
/// forwards the fresh launch to the dying process and nothing comes up.
/// (`@tauri-apps/plugin-process` `relaunch()` is not used: the plugin was
/// never registered, and Tauri's restart resolves the moved executable —
/// the exact bug this replaces.)
#[tauri::command]
pub fn relaunch_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    let installed = INSTALLED_APP
        .get()
        .ok_or("install path was not captured at startup")?;

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/bin/sh")
        .args(["-c", r#"sleep 1; /usr/bin/open -n "$0""#])
        .arg(installed)
        .spawn();
    #[cfg(target_os = "linux")]
    let spawned = {
        // AppImage runs from a mount point; $APPIMAGE is the real file.
        let target = std::env::var("APPIMAGE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| installed.clone());
        std::process::Command::new("/bin/sh")
            .args(["-c", r#"sleep 1; exec "$0""#])
            .arg(target)
            .spawn()
    };
    // Windows normally never gets here — the NSIS installer restarts the
    // app itself — but keep a best-effort fallback.
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "ping -n 2 127.0.0.1 >nul & start \"\" "])
        .arg(installed)
        .spawn();

    spawned.map_err(|e| format!("failed to spawn relauncher: {e}"))?;
    app_handle.exit(0);
    Ok(())
}

/// How this install can receive updates. The Tauri updater can only truly
/// self-update native bundles (macOS/Windows) and Linux AppImages; deb/rpm/
/// pacman installs are owned by the system package manager, and the plugin's
/// dpkg/rpm paths fail silently on other distros (issue #5).
///
/// - "native": macOS / Windows — self-update works.
/// - "appimage": Linux, actually running as an AppImage — self-update works.
/// - "package": any other Linux install — notify-only.
#[tauri::command]
pub fn updater_install_kind() -> &'static str {
    #[cfg(not(target_os = "linux"))]
    {
        "native"
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            "appimage"
        } else {
            "package"
        }
    }
}
