//! Desktop sound library: scan the user's own sample folders from disk and
//! feed them to the WASM audio engine, plus a catalog of everything the
//! engine can currently play (synths, GM instruments, drums, user banks).
//!
//! The web REPL can only stream samples over HTTP; on the desktop we read the
//! filesystem directly. The frontend picks a folder, previews the banks
//! to get a bank manifest, then [`read_audio_file`] per file (raw bytes →
//! `decodeAudioData` → the existing `sendSampleBatch` pipeline), and finally
//! [`register_sound_banks`] so the agent knows the new sounds exist.

use crate::state::AppState;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

/// Audio extensions the webview's `decodeAudioData` can handle.
const AUDIO_EXTS: &[&str] = &["wav", "ogg", "mp3", "flac", "aif", "aiff", "m4a"];

/// The WASM bank-name buffer caps names at 31 bytes (`MAX_NAME_LEN - 1`).
const MAX_BANK_NAME_BYTES: usize = 31;

/// Refuse absurdly large files so a stray multi-GB recording can't OOM the
/// sample arena or stall the IPC bridge. 64 MB is generous for a single sample.
const MAX_AUDIO_FILE_BYTES: u64 = 64 * 1024 * 1024;

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

/// How a directory of loose audio files was turned into banks.
///
/// Reported so the import UI can say what it did — a user who sees
/// "one indexed bank" knows to look for a foldered download instead of
/// wondering why their kit has one voice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupStrategy {
    /// `BD-dx200-Kick.wav` → `bd`. A leading type tag before the first separator.
    LeadingTag,
    /// `BD0050.WAV` → `bd`. A trailing index run stripped from the stem.
    TrailingIndex,
    /// Everything in one bank named after the folder. The honest floor.
    SingleBank,
}

/// A kit does not have 65 voice types; past this the grouping is noise.
const MAX_GROUPS: usize = 64;
/// Above this share of one-file groups, the convention isn't really there.
const MAX_SINGLETON_RATIO: f32 = 0.70;

/// Compare so `BD 2` sorts before `BD 10`.
///
/// Array order *is* the `:n` the user will type, so a plain lexical sort would
/// silently scramble which sample is `:2`.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        let (ca, cb) = (a[i], b[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let si = i;
            let sj = j;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            // Compare as numbers, ignoring leading zeros.
            let na = &a[si..i];
            let nb = &b[sj..j];
            let ta = na
                .iter()
                .position(|c| *c != b'0')
                .map_or(&na[..0], |p| &na[p..]);
            let tb = nb
                .iter()
                .position(|c| *c != b'0')
                .map_or(&nb[..0], |p| &nb[p..]);
            match ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb)) {
                std::cmp::Ordering::Equal => {}
                other => return other,
            }
            continue;
        }
        match ca.to_ascii_lowercase().cmp(&cb.to_ascii_lowercase()) {
            std::cmp::Ordering::Equal => {}
            other => return other,
        }
        i += 1;
        j += 1;
    }
    (a.len() - i).cmp(&(b.len() - j))
}

/// `BD-dx200-909ishKick-768kbps` → `bd`. The leading run before the first
/// separator, which is how hardware sample packs tag voice type.
fn leading_tag(stem: &str) -> String {
    let head: String = stem
        .chars()
        .take_while(|c| *c != '-' && *c != '_' && *c != ' ' && *c != '.')
        .collect();
    sanitize_bank_name(&head)
}

/// `BD0050` → `bd`, `Snaredrum-01` → `snaredrum`. Strips a trailing digit run
/// (and the separators in front of it) from the stem.
fn trailing_index(stem: &str) -> String {
    let t = stem.trim_end_matches(|c: char| c.is_ascii_digit());
    let t = t.trim_end_matches([' ', '_', '-', '.']);
    sanitize_bank_name(t)
}

/// Bucket `files` by `key`, preserving natural order within each bucket and
/// first-appearance order between them. `None` when the keying is unusable.
fn bucket_by(
    files: &[PathBuf],
    key: impl Fn(&str) -> String,
) -> Option<Vec<(String, Vec<PathBuf>)>> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<PathBuf>> =
        std::collections::HashMap::new();

    for f in files {
        let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        let k = key(stem);
        if k.is_empty() {
            return None; // keying produced nothing usable for this file
        }
        if !groups.contains_key(&k) {
            order.push(k.clone());
        }
        groups.entry(k).or_default().push(f.clone());
    }

    if order.len() > MAX_GROUPS {
        return None;
    }
    let singletons = groups.values().filter(|v| v.len() == 1).count();
    if !order.is_empty() && singletons as f32 / order.len() as f32 > MAX_SINGLETON_RATIO {
        return None;
    }

    let mut out = Vec::with_capacity(order.len());
    for k in order {
        let mut v = groups.remove(&k).unwrap_or_default();
        v.sort_by(|a, b| {
            natural_cmp(
                a.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
                b.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
            )
        });
        out.push((k, v));
    }
    Some(out)
}

/// Turn a flat directory of audio files into banks.
///
/// Before this, every loose file became its own single-sample bank named after
/// the file stem. A flat 85-file hardware pack (`BD-dx200-Kick.wav`,
/// `SD-dx200-Snare.wav`, …) imported as 85 one-sample banks: `:n` indexing was
/// dead, autocomplete and the agent's sound list filled with junk, and the kit
/// was unplayable. The ladder below recovers `bd`/`sd`/`hat`/… instead, and
/// falls back to exactly the old single-bank behaviour when no convention is
/// present rather than guessing.
pub(crate) fn group_audio_files(
    dir_label: &str,
    files: &[PathBuf],
    used: &mut HashSet<String>,
) -> (GroupStrategy, Vec<ScannedBank>) {
    let build = |groups: Vec<(String, Vec<PathBuf>)>, used: &mut HashSet<String>| {
        groups
            .into_iter()
            .map(|(name, files)| ScannedBank {
                name: unique_name(name, used),
                files,
            })
            .collect::<Vec<_>>()
    };

    if let Some(groups) = bucket_by(files, leading_tag) {
        return (GroupStrategy::LeadingTag, build(groups, used));
    }
    if let Some(groups) = bucket_by(files, trailing_index) {
        return (GroupStrategy::TrailingIndex, build(groups, used));
    }

    // Floor: one bank named after the folder, files in natural order.
    let mut sorted = files.to_vec();
    sorted.sort_by(|a, b| {
        natural_cmp(
            a.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
            b.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
        )
    });
    let name = unique_name(sanitize_bank_name(dir_label), used);
    if name.is_empty() || sorted.is_empty() {
        return (GroupStrategy::SingleBank, Vec::new());
    }
    (
        GroupStrategy::SingleBank,
        vec![ScannedBank {
            name,
            files: sorted,
        }],
    )
}

/// One bank from a folder scan: sanitized name + absolute source paths.
#[derive(Debug, Clone)]
pub struct ScannedBank {
    pub name: String,
    pub files: Vec<PathBuf>,
}

/// Scan a folder into banks.
///
/// Each immediate subdirectory is a bank. Loose audio at the root is grouped by
/// [`group_audio_files`] rather than becoming one bank per file — see that
/// function for why. Subdirectories keep their folder name; only their file
/// order is natural-sorted, so existing Strudel-shaped packs scan exactly as
/// they always did.
pub fn scan_folder_banks(root: &Path) -> Result<Vec<ScannedBank>, String> {
    Ok(scan_folder_banks_detailed(root)?.1)
}

/// [`scan_folder_banks`] plus the strategy used for the root's loose files,
/// which the import preview reports to the user.
pub fn scan_folder_banks_detailed(
    root: &Path,
) -> Result<(GroupStrategy, Vec<ScannedBank>), String> {
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
    let mut used_names: HashSet<String> = HashSet::new();
    let mut loose: Vec<PathBuf> = Vec::new();

    for entry in &entries {
        if entry.is_dir() {
            let mut files = audio_files_in(entry);
            if files.is_empty() {
                continue;
            }
            files.sort_by(|a, b| {
                natural_cmp(
                    a.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
                    b.file_name().and_then(|s| s.to_str()).unwrap_or_default(),
                )
            });
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
            loose.push(entry.clone());
        }
    }

    let label = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("samples");
    let strategy = if loose.is_empty() {
        GroupStrategy::SingleBank
    } else {
        let (strategy, grouped) = group_audio_files(label, &loose, &mut used_names);
        banks.extend(grouped);
        strategy
    };

    banks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((strategy, banks))
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
    DEFAULT_DRUMS, DRUM_MACHINE_NOTE, INSTRUMENTS, MACHINE_KITS, PERCUSSION, SYNTHS, VCSL_ONESHOTS,
    VCSL_PITCHED, WAVETABLES, gm_instruments,
};

/// True when a downloadable sample set is active AND on disk — the state in
/// which live playback + export resolve from that set's manifests instead of
/// the bundled Cycletron banks. (`active_set_banks` is only populated for a
/// ready non-bundled active set.)
fn manifest_set_active(state: &AppState) -> bool {
    !state.active_set_banks.lock().is_empty()
}

/// Everything currently playable, for the UI and the agent's `list_sounds` tool.
/// Flat set of every sound name that resolves today: the built-in catalog plus
/// user-loaded banks — plus the strudel-rs set's banks when that mode is
/// active. `gm_*` names are NOT enumerated here (any GM name streams
/// on demand) — callers should treat the `gm_` prefix as known. Used by the
/// silence linter. (In strudel mode a handful of bundled-only names, e.g.
/// `flbass`, stay in the set even though they no longer resolve — the linter
/// errs permissive rather than flagging sounds that mostly do exist.)
pub fn known_sound_set(state: &AppState) -> cycletron_analysis::sounds::SoundSet {
    let mut banks = state.loaded_sample_banks.lock().clone();
    {
        let set = state.active_set_banks.lock();
        banks.extend(set.pitched.iter().cloned());
        banks.extend(set.one_shots.iter().cloned());
    }
    cycletron_analysis::sounds::SoundSet::with_user_banks(banks)
}

/// The GM list is the engine's own 128-program table; the note keeps the
/// agent from treating it as "piano and a few others".
const GM_NOTE: &str = "All 128 General MIDI voices (streamed on first use — the first cycle may be \
                       silent). Families: pianos/epianos, organs, guitars, basses, solo strings, \
                       ensembles/choir, brass, reeds, pipes, synth leads 1-8, synth pads 1-8, fx, \
                       world (sitar, banjo, shamisen, koto, kalimba, bagpipe, fiddle, shanai), \
                       percussive (tinkle bell, agogo, steel drums, woodblock, taiko, melodic tom), \
                       sound effects. gm_piano:7 / :16 / :24 pick the other piano programs.";

pub fn sound_catalog(state: &AppState) -> serde_json::Value {
    let user_banks = state.loaded_sample_banks.lock().clone();

    // A downloadable sample set is active: the drum/percussion/instrument
    // sections below describe the bundled Cycletron banks, which are not
    // loaded in this state — report the active set's banks instead.
    if manifest_set_active(state) {
        let active = state.user_settings.lock().samples.active.clone();
        let set = state.active_set_banks.lock();
        return serde_json::json!({
            "synths": SYNTHS,
            "wavetables": WAVETABLES,
            "active_sample_set": active,
            "sample_set_pitched": set.pitched.clone(),
            "sample_set_pitched_note": "Note-mapped instruments: note(\"c3 e3 g3\").s(\"<bank>\") repitches properly (nearest recorded note). Use these for melodies and chords.",
            "sample_set_one_shots": set.one_shots.clone(),
            "drum_machines": set.machines.iter().map(|m| serde_json::json!({
                "machine": m.machine,
                "voices": m.voices,
            })).collect::<Vec<_>>(),
            "drum_machine_note": DRUM_MACHINE_NOTE,
            "sample_set_one_shots_note": "Indexed one-shots: note() repitches by playback rate from an assumed C3 root (like web strudel) — timbre stretches at extreme intervals, so keep melodies within ~an octave of C3. s(\"<bank>:n\") selects variants; .speed(r) is the raw rate control. For high-fidelity melodies prefer the pitched banks, gm_*, wt_*, or synths.",
            "sample_set_note": "A downloaded sample set is active (Samples manager) — these banks replace the bundled drum/percussion/instrument catalog. For the built-in 'strudel' set, defaults like bd/sd/hh come from the uzu drumkit and the rest (arpy, casio, breaks165, …) from Dirt-Samples. Banks load lazily — the first cycle of a new bank may be silent.",
            "gm_instruments": gm_instruments(),
            "gm_note": GM_NOTE,
            "user_sample_banks": user_banks,
        });
    }

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
        "drums_note": "Default kit is multi-variant: s(\"hh\"), s(\"hh:2\"), s(\"bd:4\"). Index 0 is the original Fischer 808 take. hh:1–5 and rd/rim/sh/tb/brk are uzu-drumkit. rim == rs. cl/ma/lc/mc/hc are extra 808 voices (claves, maracas, congas).",
        "percussion": PERCUSSION,
        "percussion_note": "Single one-shot color banks: perc=cajon, click=claves, metal=anvil, east=woodblock, hand=conga, industrial=brake drum — raw fortissimo foley with no :n variants. Sparse genre-appropriate accents only (industrial/EBM/experimental), tamed with low gain + filtering; never default texture or percussion variety. space/arpy = atmosphere & pluck; tabla/jvbass = tonal.",
        "instruments": INSTRUMENTS,
        "instruments_note": "Melodic/speech expansion banks (CC0 Clean-Samples slices). flbass=fretless bass, uke=ukulele, cpluck=cello pluck, cbow=cello bow short, speech=synth speech chops. Multi-variant: s(\"flbass:2\"). Unpitched one-shots — for in-tune melodies prefer gm_* / wt_*.",
        "vcsl_instruments": VCSL_PITCHED,
        "vcsl_instruments_note": "Real acoustic instruments (VCSL, CC0), note-mapped: note(\"c4 e4 g4\").s(\"kalimba\") plays in tune. \
                                  kalimba/marimba/vibraphone/glockenspiel/tubularbells/balafon = mallets & bells; harp, strumstick, \
                                  psaltery_pluck, dantranh (Vietnamese zither) = plucked strings; ocarina, recorder_alto_sus, harmonica = \
                                  winds (sustains — add .release()); steinway = grand piano. Prefer these over wt_* when the genre wants a \
                                  real instrument.",
        "vcsl_percussion": VCSL_ONESHOTS,
        "vcsl_percussion_note": "Real percussion one-shots (VCSL, CC0) with :n variants: gong, timpani, didgeridoo, bongo, shaker_small, \
                                 tambourine, agogo, guiro, sleighbells, triangles, framedrum, darbuka. Use as genre colour on the grid, not \
                                 as the default kit.",
        "drum_machines": machines,
        "drum_machine_note": DRUM_MACHINE_NOTE,
        "gm_instruments": gm_instruments(),
        "gm_note": GM_NOTE,
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

    /// Real filenames from Legowelt's Yamaha DX200 pack (flat, no subfolders).
    /// Verified against an archive.org mirror of the pack.
    const DX200: &[&str] = &[
        "BASS-dx200-FilteredWaveC-768kbps.wav",
        "BASS-dx200-RaveBassC-768kbps.wav",
        "BASS-dx200-RealBassG-768kbps.wav",
        "BD-dx200-909ishFilletKick-768kbps.wav",
        "BD-dx200-RotterdamGabberKick-768kbps.wav",
        "BD-dx200-SubBooooom-768kbps.wav",
        "BD-dx200-realbdz-768kbps.wav",
        "BD-dx200-realbdz2-768kbps.wav",
        "CLAP-dx200-Clapzzz-768kbps.wav",
        "CYMB-dx200-909ishCrash-768kbps.wav",
        "CYMB-dx200-JazzyRide-768kbps.wav",
        "HAT-dx200-909HatOPEN-768kbps.wav",
        "HAT-dx200-AnalogHatCLOSED-768kbps.wav",
        "HAT-dx200-RealhatOPEN-768kbps.wav",
        "PERC-dx200-Clave-768kbps.wav",
        "PERC-dx200-Indianstyle1-768kbps.wav",
        "PERC-dx200-Shaker2-768kbps.wav",
        "SD-dx200-909Snare-768kbps.wav",
        "SD-dx200-JungleSnare-768kbps.wav",
        "SD-dx200-Realsnare1-768kbps.wav",
        "TOM-dx200-909Tom-768kbps.wav",
        "TOM-dx200-LazerTom-768kbps.wav",
    ];

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|n| PathBuf::from("/pack").join(n))
            .collect()
    }

    fn group(names: &[&str]) -> (GroupStrategy, Vec<ScannedBank>) {
        let mut used = HashSet::new();
        group_audio_files("pack", &paths(names), &mut used)
    }

    #[test]
    fn leading_tag_recovers_a_playable_kit_from_a_flat_pack() {
        let (strategy, banks) = group(DX200);
        assert_eq!(strategy, GroupStrategy::LeadingTag);
        let got: Vec<(String, usize)> = banks
            .iter()
            .map(|b| (b.name.clone(), b.files.len()))
            .collect();
        // Every file lands in a typed bank instead of becoming its own.
        assert_eq!(
            got,
            vec![
                ("bass".to_string(), 3),
                ("bd".to_string(), 5),
                ("clap".to_string(), 1),
                ("cymb".to_string(), 2),
                ("hat".to_string(), 3),
                ("perc".to_string(), 3),
                ("sd".to_string(), 3),
                ("tom".to_string(), 2),
            ]
        );
    }

    #[test]
    fn trailing_index_groups_a_fischer_style_grid() {
        // BD0050.WAV etc. have no leading tag separator, so the ladder falls
        // through to stripping the index run.
        let (strategy, banks) = group(&[
            "BD0000.WAV",
            "BD0025.WAV",
            "BD0050.WAV",
            "SD0000.WAV",
            "SD0025.WAV",
        ]);
        assert_eq!(strategy, GroupStrategy::TrailingIndex);
        assert_eq!(banks.len(), 2);
        assert_eq!(banks[0].name, "bd");
        assert_eq!(banks[0].files.len(), 3);
        assert_eq!(banks[1].name, "sd");
    }

    #[test]
    fn note_named_files_fall_back_to_one_bank() {
        // A pitched multisample: every stem is unique, so neither tag nor index
        // grouping is real. One bank named after the folder is the honest answer.
        let (strategy, banks) = group(&["B2.mp3", "Ds3.mp3", "Gs3.mp3", "Cs4.mp3", "Fs4.mp3"]);
        assert_eq!(strategy, GroupStrategy::SingleBank);
        assert_eq!(banks.len(), 1);
        assert_eq!(banks[0].name, "pack");
        assert_eq!(banks[0].files.len(), 5);
    }

    #[test]
    fn too_many_distinct_names_fall_back_rather_than_guess() {
        let names: Vec<String> = (0..80).map(|i| format!("unique{i}name.wav")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let (strategy, banks) = group(&refs);
        assert_eq!(strategy, GroupStrategy::SingleBank);
        assert_eq!(banks.len(), 1);
        assert_eq!(banks[0].files.len(), 80);
    }

    #[test]
    fn index_order_is_natural_so_bd_2_precedes_bd_10() {
        let (_, banks) = group(&["BD 10.wav", "BD 2.wav", "BD 1.wav", "SD 1.wav", "SD 2.wav"]);
        let bd = banks.iter().find(|b| b.name == "bd").expect("bd bank");
        let order: Vec<&str> = bd
            .files
            .iter()
            .map(|f| f.file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(order, vec!["BD 1.wav", "BD 2.wav", "BD 10.wav"]);
    }

    #[test]
    fn natural_cmp_orders_numeric_runs_by_value() {
        use std::cmp::Ordering;
        assert_eq!(natural_cmp("a2", "a10"), Ordering::Less);
        assert_eq!(natural_cmp("a010", "a10"), Ordering::Equal);
        assert_eq!(natural_cmp("b1", "a9"), Ordering::Greater);
    }

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
