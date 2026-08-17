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
        .map(str::to_ascii_lowercase)
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

/// One bank from a folder scan: sanitized name + absolute source paths.
#[derive(Debug, Clone)]
pub struct ScannedBank {
    pub name: String,
    pub files: Vec<PathBuf>,
}

/// Scan a folder into banks (Strudel layout: each subfolder is a bank; loose
/// audio files at the root are one-shot banks named after the file stem).
pub fn scan_folder_banks(root: &Path) -> Result<Vec<ScannedBank>, String> {
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }

    let mut entries: Vec<PathBuf> = std::fs::read_dir(root)
        .map_err(|e| format!("read {}: {e}", root.display()))?
        .flatten()
        .map(|e| e.path())
        .collect();
    entries.sort();

    let mut banks: Vec<ScannedBank> = Vec::new();
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
            banks.push(ScannedBank { name, files });
        } else if entry.is_file() && is_audio(entry) {
            let raw = entry
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let name = unique_name(sanitize_bank_name(raw), &mut used_names);
            if name.is_empty() {
                continue;
            }
            banks.push(ScannedBank {
                name,
                files: vec![entry.clone()],
            });
        }
    }

    banks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(banks)
}

/// Scan a folder into sample banks using the Strudel convention:
/// each immediate subfolder is a bank (its audio files become indices 0,1,2…
/// in alphabetical order); each loose audio file at the root is a one-shot
/// bank named after the file stem.
#[tauri::command]
pub fn scan_sample_folder(path: String) -> Result<SampleFolder, String> {
    let root = PathBuf::from(&path);
    let banks = scan_folder_banks(&root)?
        .into_iter()
        .map(|b| SampleBank {
            name: b.name,
            files: b
                .files
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
        })
        .collect();
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
    let mut banks = state.loaded_sample_banks.lock();
    for n in names {
        if !n.is_empty() && !banks.contains(&n) {
            banks.push(n);
        }
    }
    banks.sort();
    Ok(())
}

// Built-in sound catalog lives in the shared analysis crate so CLI tools use
// the same known-sound set; user-loaded banks are layered on here.
pub use cycletron_analysis::sounds::{
    DEFAULT_DRUMS, DRUM_MACHINE_NOTE, GM_INSTRUMENTS, INSTRUMENTS, MACHINE_KITS, PERCUSSION,
    SYNTHS, WAVETABLES,
};

/// Everything currently playable, for the UI and the agent's `list_sounds` tool.
/// Flat set of every sound name that resolves today: the built-in catalog plus
/// user-loaded banks. `gm_*` names are NOT enumerated here (any GM name streams
/// on demand) — callers should treat the `gm_` prefix as known. Used by the
/// silence linter.
pub fn known_sound_set(state: &AppState) -> cycletron_analysis::sounds::SoundSet {
    cycletron_analysis::sounds::SoundSet::with_user_banks(state.loaded_sample_banks.lock().clone())
}

pub fn sound_catalog(state: &AppState) -> serde_json::Value {
    let user_banks = state.loaded_sample_banks.lock().clone();
    let machines: Vec<serde_json::Value> = MACHINE_KITS
        .iter()
        .map(|(machine, display, voices)| {
            let banks: Vec<String> = voices.iter().map(|v| format!("{machine}_{v}")).collect();
            serde_json::json!({
                "machine": machine,
                "display": display,
                "banks": banks,
            })
        })
        .collect();
    serde_json::json!({
        "synths": SYNTHS,
        "wavetables": WAVETABLES,
        "drums": DEFAULT_DRUMS,
        "percussion": PERCUSSION,
        "percussion_note": "Single one-shot color banks: perc=cajon, click=claves, metal=anvil, east=woodblock, hand=conga, industrial=brake drum — raw fortissimo foley with no :n variants. Sparse genre-appropriate accents only (industrial/EBM/experimental), tamed with low gain + filtering; never default texture or percussion variety. space/arpy = atmosphere & pluck; tabla/jvbass = tonal.",
        "instruments": INSTRUMENTS,
        "instruments_note": "Melodic/speech expansion banks (CC0 Clean-Samples slices). flbass=fretless bass, uke=ukulele, cpluck=cello pluck, cbow=cello bow short, speech=synth speech chops. Multi-variant: s(\"flbass:2\"). Unpitched one-shots — for in-tune melodies prefer gm_* / wt_*.",
        "drum_machines": machines,
        "drum_machine_note": DRUM_MACHINE_NOTE,
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
