//! Desktop sound library: scan the user's own sample folders from disk and
//! feed them to the WASM audio engine, plus a catalog of everything the
//! engine can currently play (synths, GM instruments, drums, user banks).
//!
//! The web REPL can only stream samples over HTTP; on the desktop we read the
//! filesystem directly. The frontend picks a folder, calls [`scan_sample_folder`]
//! to get a bank manifest, then [`read_audio_file`] per file (raw bytes →
//! `decodeAudioData` → the existing `sendSampleBatch` pipeline), and finally
//! [`register_sound_banks`] so the agent knows the new sounds exist.

use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

/// Audio extensions the webview's `decodeAudioData` can handle.
const AUDIO_EXTS: &[&str] = &["wav", "ogg", "mp3", "flac", "aif", "aiff", "m4a"];

/// The WASM bank-name buffer caps names at 31 bytes (`MAX_NAME_LEN - 1`).
const MAX_BANK_NAME_BYTES: usize = 31;

/// Refuse absurdly large files so a stray multi-GB recording can't OOM the
/// sample arena or stall the IPC bridge. 64 MB is generous for a single sample.
const MAX_AUDIO_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
pub struct SampleBank {
    /// Name to use in `s("…")`. Sanitized, lowercase, ≤31 bytes.
    pub name: String,
    /// Absolute paths to the audio files, in index order (`name:0`, `name:1`, …).
    pub files: Vec<String>,
}

#[derive(Serialize)]
pub struct SampleFolder {
    pub root: String,
    pub banks: Vec<SampleBank>,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| AUDIO_EXTS.contains(&e.as_str()))
}

/// Turn a folder/file name into a strudel-safe bank token: lowercase, runs of
/// non-`[a-z0-9_]` collapsed to a single `_`, trimmed, capped at 31 bytes.
fn sanitize_bank_name(raw: &str) -> String {
    let mut out = String::new();
    let mut last_underscore = false;
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_underscore = false;
        } else if !last_underscore && !out.is_empty() {
            out.push('_');
            last_underscore = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    // Cap at 31 bytes without splitting a char (all chars here are ASCII).
    if out.len() > MAX_BANK_NAME_BYTES {
        out.truncate(MAX_BANK_NAME_BYTES);
        while out.ends_with('_') {
            out.pop();
        }
    }
    out
}

/// Sorted audio files directly inside `dir` (one level, no recursion).
fn audio_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_audio(p))
        .collect();
    files.sort();
    files
}

/// Scan a folder into sample banks using the Strudel convention:
/// each immediate subfolder is a bank (its audio files become indices 0,1,2…
/// in alphabetical order); each loose audio file at the root is a one-shot
/// bank named after the file stem.
#[tauri::command]
pub fn scan_sample_folder(path: String) -> Result<SampleFolder, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a folder: {path}"));
    }

    let mut entries: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|e| format!("read {}: {e}", root.display()))?
        .flatten()
        .map(|e| e.path())
        .collect();
    entries.sort();

    let mut banks: Vec<SampleBank> = Vec::new();
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in &entries {
        if entry.is_dir() {
            let files = audio_files_in(entry);
            if files.is_empty() {
                continue;
            }
            let raw = entry
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let name = unique_name(sanitize_bank_name(raw), &mut used_names);
            if name.is_empty() {
                continue;
            }
            banks.push(SampleBank {
                name,
                files: files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            });
        } else if entry.is_file() && is_audio(entry) {
            let raw = entry.file_stem().and_then(|n| n.to_str()).unwrap_or_default();
            let name = unique_name(sanitize_bank_name(raw), &mut used_names);
            if name.is_empty() {
                continue;
            }
            banks.push(SampleBank {
                name,
                files: vec![entry.to_string_lossy().into_owned()],
            });
        }
    }

    banks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(SampleFolder { root: path, banks })
}

/// Disambiguate colliding sanitized names by suffixing `_2`, `_3`, … (kept ≤31 bytes).
fn unique_name(mut name: String, used: &mut std::collections::HashSet<String>) -> String {
    if name.is_empty() {
        return name;
    }
    if used.insert(name.clone()) {
        return name;
    }
    let base = name.clone();
    let mut n = 2;
    loop {
        let suffix = format!("_{n}");
        let keep = MAX_BANK_NAME_BYTES.saturating_sub(suffix.len());
        let mut candidate: String = base.chars().take(keep).collect();
        candidate.push_str(&suffix);
        if used.insert(candidate.clone()) {
            name = candidate;
            break;
        }
        n += 1;
    }
    name
}

/// Read an audio file's raw bytes for the frontend to decode. Returns the bytes
/// as an efficient binary IPC response (not a JSON number array).
#[tauri::command]
pub fn read_audio_file(path: String) -> Result<tauri::ipc::Response, String> {
    let pb = PathBuf::from(&path);
    if !is_audio(&pb) {
        return Err(format!("not an audio file: {path}"));
    }
    let meta = std::fs::metadata(&pb).map_err(|e| format!("stat {}: {e}", pb.display()))?;
    if meta.len() > MAX_AUDIO_FILE_BYTES {
        return Err(format!(
            "{} is {} MB — exceeds the {} MB limit",
            pb.display(),
            meta.len() / (1024 * 1024),
            MAX_AUDIO_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&pb).map_err(|e| format!("read {}: {e}", pb.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Record bank names the frontend has loaded, so the agent's `list_sounds` tool
/// can report them. Idempotent; de-dupes.
#[tauri::command]
pub fn register_sound_banks(names: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let mut banks = state.loaded_sample_banks.lock().unwrap();
    for n in names {
        if !n.is_empty() && !banks.contains(&n) {
            banks.push(n);
        }
    }
    banks.sort();
    Ok(())
}

/// Built-in synth/oscillator names (from `strudel-sounds` + new wavetables).
pub const SYNTHS: &[&str] = &[
    "sine", "triangle", "sawtooth", "square", "pulse", "fm", "supersaw", "supersquare",
    "superpwm", "superzow", "white", "pink", "brown", "crackle", "sbd",
];

/// Wavetable synths — richer timbres, 20 tables baked at WASM compile time.
/// Use with `note("…").s("wt_flute")` etc.
pub const WAVETABLES: &[&str] = &[
    "wt_flute", "wt_clarinet", "wt_oboe", "wt_violin", "wt_cello",
    "wt_trumpet", "wt_bassoon", "wt_organ", "wt_piano", "wt_bell",
    "wt_pluck", "wt_bass", "wt_lead", "wt_pad", "wt_choir", "wt_strings",
    "wt_sine", "wt_tri", "wt_square", "wt_saw",
];

/// Drum sample banks loaded by default at startup.
pub const DEFAULT_DRUMS: &[&str] = &[
    "bd", "sd", "sn", "hh", "cp", "oh", "ht", "mt", "lt", "cr", "cb", "rs",
];

/// Bundled drum machine kits and their voices.
/// Bank names are `{MachineName}_{voice}`, e.g. `s("RolandTR808_bd")`.
/// (Equivalent to web-strudel's `s("bd").bank("RolandTR808")` once strudel-rs
/// implements `.bank()` prefix lookup in `apply_control_to_event`.)
pub const MACHINE_KITS: &[(&str, &str, &[&str])] = &[
    ("RolandTR808", "TR-808",   &["bd","sd","hh","oh","cp","rim","lt","mt","ht","cb"]),
    ("RolandTR909", "TR-909",   &["bd","sd","hh","oh","cp","rd","rim"]),
    ("RolandTR707", "TR-707",   &["bd","sd","hh","oh","cp","lt","ht"]),
    ("LinnDrum",    "LinnDrum", &["bd","sd","hh","cp"]),
    ("BossDR55",    "DR-55",    &["bd","sd","hh","rim"]),
];

/// A representative slice of the General MIDI soundfont instruments that load on
/// demand. (Any `gm_*` General MIDI name works; these are common picks.)
pub const GM_INSTRUMENTS: &[&str] = &[
    "gm_piano", "gm_epiano1", "gm_harpsichord", "gm_acoustic_bass",
    "gm_electric_bass_finger", "gm_violin", "gm_cello", "gm_string_ensemble_1",
    "gm_trumpet", "gm_trombone", "gm_alto_sax", "gm_flute", "gm_clarinet",
    "gm_acoustic_guitar_nylon", "gm_overdriven_guitar", "gm_church_organ",
    "gm_synth_bass_1", "gm_lead_1_square", "gm_pad_warm", "gm_marimba", "gm_xylophone",
];

/// Everything currently playable, for the UI and the agent's `list_sounds` tool.
pub fn sound_catalog(state: &AppState) -> serde_json::Value {
    let user_banks = state.loaded_sample_banks.lock().unwrap().clone();
    let machines: Vec<serde_json::Value> = MACHINE_KITS.iter().map(|(machine, display, voices)| {
        let banks: Vec<String> = voices.iter().map(|v| format!("{machine}_{v}")).collect();
        serde_json::json!({
            "machine": machine,
            "display": display,
            "banks": banks,
        })
    }).collect();
    serde_json::json!({
        "synths": SYNTHS,
        "wavetables": WAVETABLES,
        "drums": DEFAULT_DRUMS,
        "drum_machines": machines,
        "drum_machine_note": "Use s(\"RolandTR808_bd\") etc. Bank prefix .bank() not yet supported by the engine.",
        "gm_instruments": GM_INSTRUMENTS,
        "gm_note": "Any General MIDI name (gm_*) works; streams in on first use, first cycle may be silent.",
        "user_sample_banks": user_banks,
    })
}

/// Command form of [`sound_catalog`] for the frontend.
#[tauri::command]
pub fn list_sounds(state: State<'_, AppState>) -> serde_json::Value {
    sound_catalog(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn sanitize_lowercases_and_collapses_separators() {
        assert_eq!(sanitize_bank_name("Roland TR-909"), "roland_tr_909");
        assert_eq!(sanitize_bank_name("My Kick!!"), "my_kick");
        assert_eq!(sanitize_bank_name("  spaced  out  "), "spaced_out");
        assert_eq!(sanitize_bank_name("808bd"), "808bd");
    }

    #[test]
    fn sanitize_caps_at_31_bytes_without_trailing_underscore() {
        let long = "a_very_long_folder_name_that_exceeds_the_limit";
        let out = sanitize_bank_name(long);
        assert!(out.len() <= MAX_BANK_NAME_BYTES, "got {} bytes", out.len());
        assert!(!out.ends_with('_'));
    }

    #[test]
    fn unique_name_disambiguates_collisions() {
        let mut used = HashSet::new();
        assert_eq!(unique_name("kick".into(), &mut used), "kick");
        assert_eq!(unique_name("kick".into(), &mut used), "kick_2");
        assert_eq!(unique_name("kick".into(), &mut used), "kick_3");
    }

    #[test]
    fn is_audio_matches_extensions_case_insensitively() {
        assert!(is_audio(Path::new("/x/BD.WAV")));
        assert!(is_audio(Path::new("/x/loop.flac")));
        assert!(!is_audio(Path::new("/x/notes.txt")));
        assert!(!is_audio(Path::new("/x/noext")));
    }
}
