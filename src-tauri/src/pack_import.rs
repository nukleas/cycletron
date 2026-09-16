//! Importing a sample pack from a folder or a `.zip`, with a review step.
//!
//! Nothing is copied into the library until the user has seen and approved a
//! bank mapping. That step is not decoration: hardware sample packs ship flat,
//! with human filenames, and the difference between a playable kit and 300
//! junk bank names is a heuristic that has to be checked by eye. Previewing
//! also lets the user *hear* a staged file before committing to it, because the
//! staged files are real files on disk and `read_audio_file` takes any path.
//!
//! The flow is three commands: [`preview_pack_import`] stages and proposes,
//! [`commit_pack_import`] copies the approved mapping into `Packs/<id>/`, and
//! [`cancel_pack_import`] throws the staging away. [`sweep_import_temp`] runs at
//! startup, because nothing can legitimately be mid-import when the app boots.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::library;
use crate::packs::{
    self, MANIFEST, MAX_INSTALL_BYTES, MAX_INSTALL_FILES, PackBank, PackBankRename,
    PackInstallResult, PackManifest,
};
use crate::sounds::{self, GroupStrategy};
use crate::state::AppState;

/// Staging lives in the app cache, not `env::temp_dir()`: it shares a volume
/// with the library on most setups, so the commit copy stays cheap, and it sits
/// next to the sample-set cache instead of inventing a second scratch location.
const IMPORT_DIR: &str = "pack-import";

static TOKEN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Documentation files are surfaced by name but never extracted — we report
/// that terms exist, we do not read or interpret them.
const DOC_NAMES: &[&str] = &["license", "licence", "readme", "terms", "copyright"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    /// Absolute — the review UI auditions these through `read_audio_file`.
    pub path: String,
    /// Display label with a trailing bitrate-ish token trimmed off.
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedBank {
    /// Final name, core-collision rename already applied.
    pub name: String,
    /// What the grouping derived before renaming.
    pub raw_name: String,
    pub collides_with_core: bool,
    pub files: Vec<PreviewFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackImportPreview {
    /// Empty for an in-place folder import — there is nothing to clean up.
    pub token: String,
    /// The original path, recorded in `pack.json` for provenance.
    pub source: String,
    /// Directory the proposed files live in.
    pub root: String,
    /// True when a commit or cancel must remove the staging directory.
    pub staged: bool,
    pub suggested_id: String,
    pub suggested_name: String,
    pub strategy: GroupStrategy,
    /// True when every top-level entry was a directory — already Strudel-shaped.
    pub folder_shaped: bool,
    pub file_count: usize,
    pub bytes: u64,
    /// Caps are reported up front rather than failing after a long copy.
    pub over_cap: bool,
    pub warnings: Vec<String>,
    pub banks: Vec<ProposedBank>,
}

/// The reviewed mapping, as approved in the import UI.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    /// Staging token from the preview; empty for an in-place folder import.
    pub token: String,
    /// Original zip or folder path, recorded in `pack.json` for provenance.
    pub source: String,
    /// Directory the bank file paths resolve against.
    pub root: String,
    pub id: String,
    pub name: Option<String>,
    pub banks: Vec<CommitBank>,
    pub enable: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CommitBank {
    pub name: String,
    /// Absolute paths, in the order the user approved. Order is the `:n`.
    pub files: Vec<String>,
}

fn imports_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no app cache dir: {e}"))?;
    Ok(base.join(IMPORT_DIR))
}

/// Resolve a caller-supplied token to its staging directory, refusing anything
/// that could escape the imports root.
fn stage_dir(app: &AppHandle, token: &str) -> Result<PathBuf, String> {
    if token.is_empty()
        || token.len() > 64
        || !token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid import token {token:?}"));
    }
    let root = imports_root(app)?;
    let dir = root.join(token);
    if !library::within(&root, &dir) {
        return Err("import token escapes the imports directory".into());
    }
    Ok(dir)
}

fn new_token() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        TOKEN_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Remove every staging directory. Called at startup: an import cannot span a
/// restart, so anything here is the residue of a crash or a force-quit.
pub fn sweep_import_temp(app: &AppHandle) {
    let Ok(root) = imports_root(app) else {
        return;
    };
    if root.exists()
        && let Err(e) = fs::remove_dir_all(&root)
    {
        tracing::warn!("could not sweep {}: {e}", root.display());
    }
}

fn is_doc_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    DOC_NAMES.iter().any(|d| lower.starts_with(d))
}

/// Trim a trailing encoding tag (`-768kbps`, `_16bit`) for display only. Never
/// applied to the bank name, the file identity, or the sort order.
fn display_label(stem: &str) -> String {
    let trimmed = stem.trim_end_matches(|c: char| c.is_ascii_alphanumeric());
    let tail = &stem[trimmed.len()..];
    let lower = tail.to_ascii_lowercase();
    if lower.ends_with("kbps") || lower.ends_with("bit") || lower.ends_with("khz") {
        let cut = stem.len() - tail.len();
        let head = stem[..cut].trim_end_matches(['-', '_', ' ', '.']);
        if !head.is_empty() {
            return head.to_string();
        }
    }
    stem.to_string()
}

/// Extract the audio out of a zip into `stage`.
///
/// Everything here is a refusal rule rather than a best effort: a sample pack
/// is untrusted input that we are about to write to disk.
fn stage_zip(src: &Path, stage: &Path) -> Result<(usize, u64, Vec<String>), String> {
    let file = fs::File::open(src).map_err(|e| format!("open {}: {e}", src.display()))?;
    let mut zip = zip::ZipArchive::new(io::BufReader::new(file))
        .map_err(|e| format!("not a readable zip: {e}"))?;

    let mut warnings: Vec<String> = Vec::new();
    let mut docs: Vec<String> = Vec::new();
    let mut symlinks = 0usize;
    let mut unsupported = 0usize;
    let mut unsafe_paths = 0usize;

    // Declared sizes first: refuse a bomb before writing a single byte.
    let mut declared_files = 0usize;
    let mut declared_bytes = 0u64;
    for i in 0..zip.len() {
        let entry = zip
            .by_index_raw(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(rel) = entry.enclosed_name() else {
            unsafe_paths += 1;
            continue;
        };
        if !sounds::is_audio(&rel) {
            continue;
        }
        declared_files += 1;
        declared_bytes = declared_bytes.saturating_add(entry.size());
    }
    if declared_files > MAX_INSTALL_FILES {
        return Err(format!(
            "archive holds {declared_files} audio files (limit {MAX_INSTALL_FILES}) — \
             import a subset instead"
        ));
    }
    if declared_bytes > MAX_INSTALL_BYTES {
        return Err(format!(
            "archive holds {} MB of audio (limit {} MB) — import a subset instead",
            declared_bytes / (1024 * 1024),
            MAX_INSTALL_BYTES / (1024 * 1024)
        ));
    }

    fs::create_dir_all(stage).map_err(|e| format!("create {}: {e}", stage.display()))?;

    let mut files = 0usize;
    let mut bytes = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        // enclosed_name() is the zip-slip guard: it rejects absolute paths,
        // parent traversal and drive prefixes.
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let name = rel
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        // Never follow or recreate a symlink out of an archive.
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            symlinks += 1;
            continue;
        }
        if rel
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
            || rel.starts_with("__MACOSX")
        {
            continue;
        }
        if !sounds::is_audio(&rel) {
            if is_doc_name(&name) && entry.size() <= 64 * 1024 {
                docs.push(name);
            }
            continue;
        }

        let abs = stage.join(&rel);
        if !library::within(stage, &abs) {
            unsafe_paths += 1;
            continue;
        }
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }

        // Cap while writing too: a central directory can lie about sizes.
        let remaining = MAX_INSTALL_BYTES.saturating_sub(bytes);
        let mut out =
            fs::File::create(&abs).map_err(|e| format!("write {}: {e}", abs.display()))?;
        let written = match io::copy(&mut entry.take(remaining + 1), &mut out) {
            Ok(n) => n,
            Err(e) => {
                // A single unreadable entry (unsupported compression) should not
                // sink the whole import.
                drop(out);
                let _ = fs::remove_file(&abs);
                unsupported += 1;
                tracing::warn!("skip zip entry {}: {e}", rel.display());
                continue;
            }
        };
        if written > remaining {
            drop(out);
            let _ = fs::remove_dir_all(stage);
            return Err(format!(
                "archive expands past {} MB — import a subset instead",
                MAX_INSTALL_BYTES / (1024 * 1024)
            ));
        }
        bytes = bytes.saturating_add(written);
        files += 1;
    }

    if files == 0 {
        let _ = fs::remove_dir_all(stage);
        return Err("no audio files in that archive".into());
    }
    if symlinks > 0 {
        warnings.push(format!("skipped {symlinks} symlink(s)"));
    }
    if unsafe_paths > 0 {
        warnings.push(format!(
            "skipped {unsafe_paths} entr{} with unsafe paths",
            if unsafe_paths == 1 { "y" } else { "ies" }
        ));
    }
    if unsupported > 0 {
        warnings.push(format!(
            "skipped {unsupported} file(s) using an unsupported compression method"
        ));
    }
    if !docs.is_empty() {
        warnings.push(format!(
            "the archive includes {} — check its terms; Cycletron does not read or grant them",
            docs.join(", ")
        ));
    }
    Ok((files, bytes, warnings))
}

/// True when `dir` holds audio files directly (i.e. it is a bank, or a flat pack).
fn has_direct_audio(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|rd| {
        rd.flatten()
            .any(|e| e.path().is_file() && sounds::is_audio(&e.path()))
    })
}

/// Strip redundant wrapper directories, so `Pack/Pack/bd/*.wav` roots at the
/// inner `Pack` and `Pack/*.wav` roots at `Pack`.
///
/// The subtlety is knowing when to stop: a lone child directory that holds
/// audio directly is a *bank*, not a wrapper, and descending into it would
/// throw away the bank name and leave a pack of one. The exception is the very
/// first step out of the staging root, where that same shape is a flat pack
/// wrapped in a folder and descending is exactly right.
fn unwrap_single_root(dir: &Path) -> PathBuf {
    let mut cur = dir.to_path_buf();
    for depth in 0..3 {
        let Ok(rd) = fs::read_dir(&cur) else { break };
        let entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        match entries.as_slice() {
            [only] if only.is_dir() && (depth == 0 || !has_direct_audio(only)) => {
                cur = only.clone();
            }
            _ => break,
        }
    }
    cur
}

/// True when every top-level entry is a directory — the Strudel pack layout,
/// where folder names are already the bank names.
fn is_folder_shaped(root: &Path) -> bool {
    let Ok(rd) = fs::read_dir(root) else {
        return false;
    };
    let mut saw_dir = false;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            saw_dir = true;
        } else if p.is_file() && sounds::is_audio(&p) {
            return false;
        }
    }
    saw_dir
}

/// Stage a source and propose a bank mapping. Copies nothing into the library.
#[tauri::command]
pub fn preview_pack_import(
    source: String,
    id: Option<String>,
    app_handle: AppHandle,
) -> Result<PackImportPreview, String> {
    let src = PathBuf::from(&source);
    let is_zip = src
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));

    let (token, root, staged, mut warnings, mut file_count, mut bytes) = if is_zip {
        let token = new_token();
        let dir = stage_dir(&app_handle, &token)?;
        let (files, size, warns) = stage_zip(&src, &dir)?;
        (token, unwrap_single_root(&dir), true, warns, files, size)
    } else {
        if !src.is_dir() {
            return Err(format!("not a folder or .zip: {source}"));
        }
        (String::new(), src.clone(), false, Vec::new(), 0, 0)
    };

    let folder_shaped = is_folder_shaped(&root);
    let (strategy, scanned) = sounds::scan_folder_banks_detailed(&root)?;
    if scanned.is_empty() {
        if staged {
            let _ = fs::remove_dir_all(stage_dir(&app_handle, &token)?);
        }
        return Err("no audio files found in that folder".into());
    }

    let label = root
        .file_name()
        .and_then(|n| n.to_str())
        .or_else(|| src.file_stem().and_then(|n| n.to_str()))
        .unwrap_or("pack");
    let suggested_id = match id {
        Some(raw) if !raw.is_empty() => raw,
        _ => packs::pack_id_from_folder_name(label),
    };

    // Names are shown post-rename: otherwise a user reads "bd", types s("bd"),
    // and silently gets the core kit instead of the pack they just imported.
    let core = packs::core_bank_names();
    let mut used: HashSet<String> = HashSet::new();
    let mut banks = Vec::with_capacity(scanned.len());
    for bank in &scanned {
        let (name, _) = packs::bank_name_for_pack(&bank.name, &suggested_id, &core, &mut used);
        let files = bank
            .files
            .iter()
            .map(|f| {
                if !staged && let Ok(meta) = fs::metadata(f) {
                    file_count += 1;
                    bytes = bytes.saturating_add(meta.len());
                }
                PreviewFile {
                    path: f.to_string_lossy().into_owned(),
                    label: display_label(
                        f.file_stem().and_then(|s| s.to_str()).unwrap_or_default(),
                    ),
                }
            })
            .collect();
        banks.push(ProposedBank {
            name,
            raw_name: bank.name.clone(),
            collides_with_core: core.contains(&bank.name),
            files,
        });
    }

    let over_cap = file_count > MAX_INSTALL_FILES || bytes > MAX_INSTALL_BYTES;
    if over_cap {
        warnings.push(format!(
            "over the import limit ({MAX_INSTALL_FILES} files / {} MB) — drop some banks below",
            MAX_INSTALL_BYTES / (1024 * 1024)
        ));
    }

    Ok(PackImportPreview {
        token,
        source,
        root: root.to_string_lossy().into_owned(),
        staged,
        suggested_id,
        suggested_name: label.to_string(),
        strategy,
        folder_shaped,
        file_count,
        bytes,
        over_cap,
        warnings,
        banks,
    })
}

/// Throw away a staging directory. Wired to every close path of the review UI.
#[tauri::command]
pub fn cancel_pack_import(token: String, app_handle: AppHandle) -> Result<(), String> {
    if token.is_empty() {
        return Ok(());
    }
    let dir = stage_dir(&app_handle, &token)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Copy the reviewed mapping into `Packs/<id>/` and optionally enable it.
///
/// Everything the frontend sends is re-validated here. The review UI only
/// *proposes*; a hostile or buggy caller must not be able to talk the installer
/// into copying arbitrary files out of the user's home directory.
#[tauri::command]
pub fn commit_pack_import(
    request: CommitRequest,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<PackInstallResult, String> {
    let CommitRequest {
        token,
        source,
        root,
        id,
        name,
        banks,
        enable,
    } = request;
    if !packs::is_valid_pack_id(&id) {
        return Err(format!("invalid pack id {id:?}"));
    }
    if banks.is_empty() {
        return Err("no banks selected".into());
    }

    // The root must be the staging dir we created, or the folder the user
    // picked — never an arbitrary path handed back to us.
    let root = PathBuf::from(&root);
    if !token.is_empty() {
        let stage = stage_dir(&app_handle, &token)?;
        if !library::within(&stage, &root) {
            return Err("import root escapes its staging directory".into());
        }
    }
    if !root.is_dir() {
        return Err("import source is gone — start the import again".into());
    }

    let packs_dir = packs::ensured_packs_root(&state);
    let dest = packs_dir.join(&id);
    if dest.exists() {
        return Err(format!(
            "pack {id} already exists — remove it or pick another id"
        ));
    }

    let core = packs::core_bank_names();
    let mut used: HashSet<String> = HashSet::new();
    let mut renames: Vec<PackBankRename> = Vec::new();
    let mut manifest_banks: Vec<PackBank> = Vec::new();
    let mut bank_names: Vec<String> = Vec::new();
    let mut file_count = 0usize;
    let mut bytes = 0u64;

    // Validate the whole request before writing anything.
    let mut plan: Vec<(String, Vec<PathBuf>)> = Vec::with_capacity(banks.len());
    for bank in &banks {
        let (final_name, rename) = packs::bank_name_for_pack(&bank.name, &id, &core, &mut used);
        if final_name.is_empty() {
            return Err(format!("bank name {:?} is not usable", bank.name));
        }
        if let Some(r) = rename {
            renames.push(r);
        }
        let mut files = Vec::with_capacity(bank.files.len());
        for f in &bank.files {
            let abs = PathBuf::from(f);
            if !library::within(&root, &abs) {
                return Err(format!("file escapes the import folder: {f}"));
            }
            if !abs.is_file() || !sounds::is_audio(&abs) {
                return Err(format!("not an audio file: {f}"));
            }
            let meta = fs::metadata(&abs).map_err(|e| format!("stat {f}: {e}"))?;
            file_count += 1;
            bytes = bytes.saturating_add(meta.len());
            if file_count > MAX_INSTALL_FILES {
                return Err(format!("too many files (>{MAX_INSTALL_FILES})"));
            }
            if bytes > MAX_INSTALL_BYTES {
                return Err(format!(
                    "pack would exceed {} MB",
                    MAX_INSTALL_BYTES / (1024 * 1024)
                ));
            }
            files.push(abs);
        }
        if files.is_empty() {
            continue;
        }
        plan.push((final_name, files));
    }
    if plan.is_empty() {
        return Err("every selected bank was empty".into());
    }

    fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

    let copy = (|| -> Result<(), String> {
        for (bank_name, files) in &plan {
            let mut rel_files = Vec::with_capacity(files.len());
            for (i, src_file) in files.iter().enumerate() {
                let ext = src_file
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("wav")
                    .to_ascii_lowercase();
                let stem = src_file
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("sample");
                let dest_name: String = format!("{i:03}_{stem}.{ext}")
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
                let rel = format!("banks/{bank_name}/{dest_name}");
                packs::copy_file(src_file, &dest.join(&rel))?;
                rel_files.push(rel);
            }
            bank_names.push(bank_name.clone());
            manifest_banks.push(PackBank {
                name: bank_name.clone(),
                files: rel_files,
            });
        }
        Ok(())
    })();

    if let Err(e) = copy {
        // Never leave a half-written pack behind for the next scan to find.
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }

    let display_name = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| id.clone());

    let license_body = format!(
        "User-provided sample pack installed into Cycletron.\n\
         SPDX: LicenseRef-UserProvided\n\
         Source: {source}\n\
         Pack id: {id}\n\
         \n\
         Cycletron does not claim ownership of these samples. Redistribute only\n\
         if you have the right to do so under the samples' original license.\n"
    );
    fs::write(dest.join("LICENSE"), license_body).map_err(|e| format!("write LICENSE: {e}"))?;

    let manifest = PackManifest {
        schema: 1,
        id: id.clone(),
        name: display_name.clone(),
        version: "1.0.0".into(),
        description: format!("Imported from {source}"),
        spdx: "LicenseRef-UserProvided".into(),
        license_file: "LICENSE".into(),
        authors: vec![],
        source: Some(source.clone()),
        tags: vec!["user".into(), "imported".into()],
        banks: manifest_banks,
    };
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())? + "\n";
    fs::write(dest.join(MANIFEST), json).map_err(|e| format!("write pack.json: {e}"))?;

    let load = if enable.unwrap_or(true) {
        match packs::enable_pack_inner(&packs_dir, &id) {
            Ok(r) => Some(r),
            Err(e) => {
                tracing::warn!("installed {id} but could not enable it: {e}");
                None
            }
        }
    } else {
        None
    };

    if !token.is_empty() {
        let _ = fs::remove_dir_all(stage_dir(&app_handle, &token)?);
    }

    Ok(PackInstallResult {
        id,
        name: display_name,
        path: dest.to_string_lossy().into_owned(),
        banks: bank_names,
        renamed: renames,
        file_count,
        bytes,
        load,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cycletron_import_{tag}_{}_{}",
            std::process::id(),
            TOKEN_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&p);
        p
    }

    /// Build a zip from (name, bytes) pairs. Names are written verbatim so a
    /// test can produce entries a well-behaved archiver never would.
    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        for (name, body) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(body).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn extracts_audio_and_ignores_everything_else() {
        let dir = tmp("plain");
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("pack.zip");
        make_zip(
            &zip_path,
            &[
                ("BD-x-Kick.wav", b"RIFFfake"),
                ("SD-x-Snare.wav", b"RIFFfake"),
                ("notes.txt", b"hello"),
            ],
        );
        let stage = dir.join("stage");
        let (files, bytes, _warn) = stage_zip(&zip_path, &stage).unwrap();
        assert_eq!(files, 2, "only the audio should be extracted");
        assert!(bytes > 0);
        assert!(!stage.join("notes.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_slip_entries_never_escape_the_staging_directory() {
        let dir = tmp("slip");
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("evil.zip");
        make_zip(
            &zip_path,
            &[
                ("../../escaped.wav", b"RIFFfake"),
                ("ok/BD-x-Kick.wav", b"RIFFfake"),
            ],
        );
        let stage = dir.join("stage");
        let (files, _, _) = stage_zip(&zip_path, &stage).unwrap();
        // The traversing entry is dropped; the legitimate one survives.
        assert_eq!(files, 1);
        assert!(!dir.join("escaped.wav").exists());
        assert!(!dir.parent().unwrap().join("escaped.wav").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_archive_with_no_audio_is_refused() {
        let dir = tmp("empty");
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("docs.zip");
        make_zip(&zip_path, &[("README.md", b"nothing here")]);
        let stage = dir.join("stage");
        assert!(stage_zip(&zip_path, &stage).is_err());
        // A refused import leaves nothing behind.
        assert!(!stage.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn documentation_is_reported_by_name_but_never_extracted() {
        let dir = tmp("docs");
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("pack.zip");
        make_zip(
            &zip_path,
            &[("BD-x-Kick.wav", b"RIFFfake"), ("LICENSE.txt", b"terms")],
        );
        let stage = dir.join("stage");
        let (_, _, warnings) = stage_zip(&zip_path, &stage).unwrap();
        assert!(
            warnings.iter().any(|w| w.contains("LICENSE.txt")),
            "expected the licence file to be surfaced, got {warnings:?}"
        );
        assert!(!stage.join("LICENSE.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_wrapper_directory_is_unwrapped() {
        let dir = tmp("nested");
        fs::create_dir_all(dir.join("Pack").join("bd")).unwrap();
        fs::write(dir.join("Pack").join("bd").join("a.wav"), b"RIFF").unwrap();
        assert_eq!(unwrap_single_root(&dir), dir.join("Pack"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_flat_pack_inside_one_folder_roots_at_that_folder() {
        // The Legowelt shape: PackName/BD-x-Kick.wav, no bank folders. Here the
        // lone child *does* hold audio, and descending into it is right —
        // unlike the nested case, where that shape means a bank.
        let dir = tmp("flat");
        fs::create_dir_all(dir.join("DX200 Pack")).unwrap();
        fs::write(dir.join("DX200 Pack").join("BD-x-Kick.wav"), b"RIFF").unwrap();
        fs::write(dir.join("DX200 Pack").join("SD-x-Snare.wav"), b"RIFF").unwrap();
        assert_eq!(unwrap_single_root(&dir), dir.join("DX200 Pack"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_shaped_detects_the_strudel_layout() {
        let dir = tmp("shape");
        fs::create_dir_all(dir.join("bd")).unwrap();
        fs::write(dir.join("bd").join("a.wav"), b"RIFF").unwrap();
        assert!(is_folder_shaped(&dir));
        // One loose sample at the root means the names need deriving.
        fs::write(dir.join("loose.wav"), b"RIFF").unwrap();
        assert!(!is_folder_shaped(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn display_label_trims_only_encoding_tails() {
        assert_eq!(display_label("BD-dx200-Kick-768kbps"), "BD-dx200-Kick");
        assert_eq!(display_label("Snare_16bit"), "Snare");
        // A trailing number is part of the name, not an encoding tag.
        assert_eq!(display_label("BD 01"), "BD 01");
        assert_eq!(display_label("Clap"), "Clap");
    }

    #[test]
    fn doc_names_are_recognised_case_insensitively() {
        assert!(is_doc_name("LICENSE.txt"));
        assert!(is_doc_name("readme.md"));
        assert!(!is_doc_name("kick.wav"));
    }
}
