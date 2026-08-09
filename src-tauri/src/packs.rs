//! Optional sample packs under `{library_root}/Packs/`.
//!
//! Each pack is a directory with `pack.json`, a license file, and audio under
//! relative paths listed in the manifest. Enabled packs are listed in
//! `Packs/enabled.json` and loaded at startup by the frontend (same decode
//! path as "Load Sample Folder…").

use crate::library;
use crate::state::AppState;
use crate::sounds::{DEFAULT_DRUMS, MACHINE_KITS, PERCUSSION};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::State;

pub const PACKS_DIR: &str = "Packs";
const ENABLED_FILE: &str = "enabled.json";
const MANIFEST: &str = "pack.json";

/// SPDX ids accepted for auto-enable. User-imported packs use
/// `LicenseRef-UserProvided` and are allowed after the user installed them.
const ALLOWED_SPDX: &[&str] = &[
    "CC0-1.0",
    "MIT",
    "Apache-2.0",
    "LicenseRef-PublicDomain",
    "LicenseRef-UserProvided",
];

// --- on-disk shapes -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackManifest {
    pub schema: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// SPDX identifier (preferred).
    #[serde(default, alias = "license")]
    pub spdx: String,
    pub license_file: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub banks: Vec<PackBank>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackBank {
    pub name: String,
    #[serde(default)]
    pub pitched: bool,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct EnabledFile {
    #[serde(default = "enabled_version")]
    version: u32,
    #[serde(default)]
    enabled: Vec<String>,
}

fn enabled_version() -> u32 {
    1
}

// --- IPC shapes -----------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PackSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub spdx: String,
    pub description: String,
    pub tags: Vec<String>,
    pub banks: Vec<String>,
    pub enabled: bool,
    pub path: String,
}

/// Absolute paths ready for `read_audio_file` + frontend decode.
#[derive(Debug, Clone, Serialize)]
pub struct PackLoadBank {
    pub name: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PackLoadResult {
    pub id: String,
    pub banks: Vec<PackLoadBank>,
    /// Banks skipped because the name collides with a core bank.
    pub skipped: Vec<String>,
}

// --- filesystem helpers ---------------------------------------------------

pub fn packs_root(library_root: &Path) -> PathBuf {
    library_root.join(PACKS_DIR)
}

/// Ensure `Packs/` exists (called from library prepare).
pub fn ensure_packs_dir(library_root: &Path) -> Result<(), String> {
    let root = packs_root(library_root);
    fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))
}

fn read_enabled(packs: &Path) -> EnabledFile {
    let path = packs.join(ENABLED_FILE);
    let Ok(s) = fs::read_to_string(&path) else {
        return EnabledFile::default();
    };
    serde_json::from_str(&s).unwrap_or_default()
}

fn write_enabled(packs: &Path, enabled: &EnabledFile) -> Result<(), String> {
    fs::create_dir_all(packs).map_err(|e| format!("create {}: {e}", packs.display()))?;
    let path = packs.join(ENABLED_FILE);
    let s = serde_json::to_string_pretty(enabled).map_err(|e| e.to_string())?;
    fs::write(&path, s + "\n").map_err(|e| format!("write {}: {e}", path.display()))
}

fn is_valid_pack_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    if id.len() > 63 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Relative path with no `..` / absolute components.
fn safe_rel_path(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') {
        return Err(format!("invalid path: {rel}"));
    }
    let p = Path::new(rel);
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return Err(format!("invalid path: {rel}")),
        }
    }
    Ok(p.to_path_buf())
}

fn core_bank_names() -> HashSet<String> {
    let mut set: HashSet<String> = DEFAULT_DRUMS
        .iter()
        .chain(PERCUSSION.iter())
        .map(|s| (*s).to_string())
        .collect();
    for (machine, _, voices) in MACHINE_KITS {
        for v in *voices {
            set.insert(format!("{machine}_{v}"));
        }
    }
    set
}

fn load_manifest(dir: &Path) -> Result<PackManifest, String> {
    let path = dir.join(MANIFEST);
    let s = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let m: PackManifest =
        serde_json::from_str(&s).map_err(|e| format!("parse {}: {e}", path.display()))?;
    if m.schema != 1 {
        return Err(format!("unsupported pack schema {} in {}", m.schema, path.display()));
    }
    if !is_valid_pack_id(&m.id) {
        return Err(format!("invalid pack id {:?}", m.id));
    }
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if dir_name != m.id {
        return Err(format!(
            "pack id {:?} does not match folder name {:?}",
            m.id, dir_name
        ));
    }
    if m.spdx.is_empty() {
        return Err(format!("pack {} missing spdx/license", m.id));
    }
    if m.license_file.is_empty() {
        return Err(format!("pack {} missing license_file", m.id));
    }
    if m.banks.is_empty() {
        return Err(format!("pack {} has no banks", m.id));
    }
    for bank in &m.banks {
        if bank.name.is_empty() || bank.name.len() > 31 {
            return Err(format!("pack {} has invalid bank name {:?}", m.id, bank.name));
        }
        if bank.files.is_empty() {
            return Err(format!("pack {} bank {} has no files", m.id, bank.name));
        }
    }
    Ok(m)
}

fn validate_for_enable(dir: &Path, m: &PackManifest) -> Result<(), String> {
    if !ALLOWED_SPDX.contains(&m.spdx.as_str()) {
        return Err(format!(
            "pack {} license {:?} is not in the enable allowlist",
            m.id, m.spdx
        ));
    }
    let lic = safe_rel_path(&m.license_file)?;
    let lic_path = dir.join(&lic);
    if !lic_path.is_file() {
        return Err(format!("pack {} missing license file {}", m.id, m.license_file));
    }
    if !library::within(dir, &lic_path) {
        return Err(format!("pack {} license_file escapes pack dir", m.id));
    }
    for bank in &m.banks {
        for f in &bank.files {
            let rel = safe_rel_path(f)?;
            let abs = dir.join(&rel);
            if !abs.is_file() {
                return Err(format!("pack {} missing file {}", m.id, f));
            }
            if !library::within(dir, &abs) {
                return Err(format!("pack {} file escapes pack dir: {f}", m.id));
            }
        }
    }
    Ok(())
}

fn scan_installed(packs: &Path) -> Vec<(PathBuf, PackManifest)> {
    let Ok(rd) = fs::read_dir(packs) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join(MANIFEST).is_file() {
            continue;
        }
        match load_manifest(&path) {
            Ok(m) => out.push((path, m)),
            Err(e) => tracing::warn!("skip pack at {}: {e}", path.display()),
        }
    }
    out.sort_by(|a, b| a.1.id.cmp(&b.1.id));
    out
}

fn resolve_load(dir: &Path, m: &PackManifest) -> Result<PackLoadResult, String> {
    validate_for_enable(dir, m)?;
    let core = core_bank_names();
    let mut banks = Vec::new();
    let mut skipped = Vec::new();
    for bank in &m.banks {
        if core.contains(&bank.name) {
            skipped.push(bank.name.clone());
            continue;
        }
        let mut files = Vec::with_capacity(bank.files.len());
        for f in &bank.files {
            let rel = safe_rel_path(f)?;
            files.push(dir.join(rel).to_string_lossy().into_owned());
        }
        banks.push(PackLoadBank {
            name: bank.name.clone(),
            files,
        });
    }
    if banks.is_empty() {
        return Err(format!(
            "pack {} has no loadable banks (all names collide with core, or empty)",
            m.id
        ));
    }
    Ok(PackLoadResult {
        id: m.id.clone(),
        banks,
        skipped,
    })
}

// --- commands -------------------------------------------------------------

#[tauri::command]
pub fn list_packs(state: State<'_, AppState>) -> Result<Vec<PackSummary>, String> {
    let lib = state.library_root();
    let packs = packs_root(&lib);
    let _ = ensure_packs_dir(&lib);
    let enabled: HashSet<String> = read_enabled(&packs).enabled.into_iter().collect();
    let mut out = Vec::new();
    for (dir, m) in scan_installed(&packs) {
        out.push(PackSummary {
            id: m.id.clone(),
            name: m.name,
            version: m.version,
            spdx: m.spdx,
            description: m.description,
            tags: m.tags,
            banks: m.banks.iter().map(|b| b.name.clone()).collect(),
            enabled: enabled.contains(&m.id),
            path: dir.to_string_lossy().into_owned(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn get_pack(id: String, state: State<'_, AppState>) -> Result<PackManifest, String> {
    if !is_valid_pack_id(&id) {
        return Err(format!("invalid pack id {id:?}"));
    }
    let dir = packs_root(&state.library_root()).join(&id);
    if !dir.is_dir() {
        return Err(format!("pack not installed: {id}"));
    }
    load_manifest(&dir)
}

#[tauri::command]
pub fn enable_pack(id: String, state: State<'_, AppState>) -> Result<PackLoadResult, String> {
    if !is_valid_pack_id(&id) {
        return Err(format!("invalid pack id {id:?}"));
    }
    let packs = packs_root(&state.library_root());
    enable_pack_inner(&packs, &id)
}

#[tauri::command]
pub fn disable_pack(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if !is_valid_pack_id(&id) {
        return Err(format!("invalid pack id {id:?}"));
    }
    let packs = packs_root(&state.library_root());
    let mut en = read_enabled(&packs);
    let before = en.enabled.len();
    en.enabled.retain(|e| e != &id);
    if en.enabled.len() != before {
        write_enabled(&packs, &en)?;
    }
    Ok(())
}

/// Resolve every enabled pack for the frontend to decode.
#[tauri::command]
pub fn load_enabled_packs(state: State<'_, AppState>) -> Result<Vec<PackLoadResult>, String> {
    let lib = state.library_root();
    let packs = packs_root(&lib);
    let _ = ensure_packs_dir(&lib);
    let en = read_enabled(&packs);
    let mut out = Vec::new();
    for id in &en.enabled {
        if !is_valid_pack_id(id) {
            tracing::warn!("enabled.json has invalid id {id:?}, skipping");
            continue;
        }
        let dir = packs.join(id);
        if !dir.is_dir() {
            tracing::warn!("enabled pack {id} is not installed, skipping");
            continue;
        }
        match load_manifest(&dir).and_then(|m| resolve_load(&dir, &m)) {
            Ok(r) => out.push(r),
            Err(e) => tracing::warn!("enabled pack {id}: {e}"),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn packs_dir(state: State<'_, AppState>) -> Result<String, String> {
    let lib = state.library_root();
    ensure_packs_dir(&lib)?;
    Ok(packs_root(&lib).to_string_lossy().into_owned())
}

// --- install from folder --------------------------------------------------

/// Cap on files copied during install (Dirt-scale libraries are fine; multi-GB
/// dumps should be thinned first).
const MAX_INSTALL_FILES: usize = 8_000;
const MAX_INSTALL_BYTES: u64 = 768 * 1024 * 1024; // 768 MB

#[derive(Debug, Clone, Serialize)]
pub struct PackInstallResult {
    pub id: String,
    pub name: String,
    pub path: String,
    pub banks: Vec<String>,
    /// Banks renamed because the original name collides with a core bank.
    pub renamed: Vec<PackBankRename>,
    pub file_count: usize,
    pub bytes: u64,
    /// Present when `enable` was true and load succeeded.
    pub load: Option<PackLoadResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PackBankRename {
    pub from: String,
    pub to: String,
}

/// Derive a pack id from a folder name: lowercase, runs of non-alnum → `-`.
fn pack_id_from_folder_name(raw: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !out.is_empty() && !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 63 {
        out.truncate(63);
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        "pack".into()
    } else if is_valid_pack_id(&out) {
        out
    } else {
        // leading digit is ok; leading dash shouldn't happen
        format!("p-{out}")
    }
}

/// If `name` collides with a core bank, append `_{pack_id}` (clipped to 31).
/// Bank tokens are `[a-z0-9_]` only — pack id hyphens become underscores.
fn bank_name_for_pack(
    name: &str,
    pack_id: &str,
    core: &HashSet<String>,
    used: &mut HashSet<String>,
) -> (String, Option<PackBankRename>) {
    let id_suffix: String = pack_id
        .chars()
        .map(|c| if c == '-' { '_' } else { c })
        .collect();
    let candidate = if core.contains(name) {
        let suffix = format!("_{id_suffix}");
        let keep = 31usize.saturating_sub(suffix.len()).max(1);
        let mut s: String = name.chars().take(keep).collect();
        while s.ends_with('_') {
            s.pop();
        }
        s.push_str(&suffix);
        if s.len() > 31 {
            s.truncate(31);
        }
        s
    } else {
        name.to_string()
    };

    let mut final_name = candidate.clone();
    let mut n = 2u32;
    while !used.insert(final_name.clone()) {
        let suffix = format!("_{n}");
        let keep = 31usize.saturating_sub(suffix.len());
        final_name = candidate.chars().take(keep).collect();
        final_name.push_str(&suffix);
        n += 1;
    }

    let rename = if final_name != name {
        Some(PackBankRename {
            from: name.to_string(),
            to: final_name.clone(),
        })
    } else {
        None
    };
    (final_name, rename)
}

fn copy_file(src: &Path, dest: &Path) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::copy(src, dest).map_err(|e| format!("copy {} → {}: {e}", src.display(), dest.display()))
}

/// Install a Strudel-style sample folder as a pack under `Packs/<id>/`.
///
/// Copies audio (does not leave the pack pointing at the source). SPDX is
/// `LicenseRef-UserProvided`. Bank names that collide with the core kit are
/// renamed (`bd` → `bd_<id>`). Set `enable` to also add the pack to
/// `enabled.json` and return load paths.
#[tauri::command]
pub fn install_pack_from_folder(
    path: String,
    id: Option<String>,
    name: Option<String>,
    enable: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PackInstallResult, String> {
    let src = PathBuf::from(&path);
    if !src.is_dir() {
        return Err(format!("not a folder: {path}"));
    }

    let folder_label = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("pack");

    let pack_id = match id {
        Some(raw) if !raw.is_empty() => {
            if !is_valid_pack_id(&raw) {
                return Err(format!("invalid pack id {raw:?}"));
            }
            raw
        }
        _ => pack_id_from_folder_name(folder_label),
    };

    let display_name = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| folder_label.to_string());

    let lib = state.library_root();
    ensure_packs_dir(&lib)?;
    let packs = packs_root(&lib);
    let dest = packs.join(&pack_id);
    if dest.exists() {
        return Err(format!(
            "pack {pack_id} already exists at {} — remove it or pick another id",
            dest.display()
        ));
    }

    let scanned = crate::sounds::scan_folder_banks(&src)?;
    if scanned.is_empty() {
        return Err("no audio files found (expected subfolders of wav/ogg/mp3/flac, or loose audio at the root)".into());
    }

    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    for bank in &scanned {
        for f in &bank.files {
            let meta = fs::metadata(f).map_err(|e| format!("stat {}: {e}", f.display()))?;
            file_count += 1;
            total_bytes = total_bytes.saturating_add(meta.len());
            if file_count > MAX_INSTALL_FILES {
                return Err(format!(
                    "too many files (>{MAX_INSTALL_FILES}); thin the folder or install a subset"
                ));
            }
            if total_bytes > MAX_INSTALL_BYTES {
                return Err(format!(
                    "pack would exceed {} MB; thin the folder first",
                    MAX_INSTALL_BYTES / (1024 * 1024)
                ));
            }
        }
    }

    fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

    let core = core_bank_names();
    let mut used_names: HashSet<String> = HashSet::new();
    let mut manifest_banks: Vec<PackBank> = Vec::new();
    let mut renames: Vec<PackBankRename> = Vec::new();
    let mut bank_names: Vec<String> = Vec::new();
    let mut copied_bytes = 0u64;
    let mut copied_files = 0usize;

    for bank in scanned {
        let (bank_name, rename) =
            bank_name_for_pack(&bank.name, &pack_id, &core, &mut used_names);
        if let Some(r) = rename {
            renames.push(r);
        }

        let mut rel_files: Vec<String> = Vec::with_capacity(bank.files.len());
        for (i, src_file) in bank.files.iter().enumerate() {
            let ext = src_file
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("wav")
                .to_ascii_lowercase();
            let stem = src_file
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("sample");
            // Stable, filesystem-safe filename; keep original stem when unique.
            let dest_name = format!("{:03}_{stem}.{ext}", i);
            // Sanitize dest_name lightly (no path seps)
            let dest_name: String = dest_name
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
            let abs = dest.join(&rel);
            let n = copy_file(src_file, &abs)?;
            copied_bytes = copied_bytes.saturating_add(n);
            copied_files += 1;
            rel_files.push(rel);
        }

        bank_names.push(bank_name.clone());
        manifest_banks.push(PackBank {
            name: bank_name,
            pitched: false,
            files: rel_files,
        });
    }

    let license_body = format!(
        "User-provided sample pack installed into Cycletron.\n\
         SPDX: LicenseRef-UserProvided\n\
         Source: {path}\n\
         Pack id: {pack_id}\n\
         \n\
         Cycletron does not claim ownership of these samples. Redistribute only\n\
         if you have the right to do so under the samples' original license.\n"
    );
    fs::write(dest.join("LICENSE"), license_body)
        .map_err(|e| format!("write LICENSE: {e}"))?;

    let manifest = PackManifest {
        schema: 1,
        id: pack_id.clone(),
        name: display_name.clone(),
        version: "1.0.0".into(),
        description: format!("Installed from {path}"),
        spdx: "LicenseRef-UserProvided".into(),
        license_file: "LICENSE".into(),
        authors: vec![],
        source: Some(path.clone()),
        tags: vec!["user".into(), "installed".into()],
        banks: manifest_banks,
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())? + "\n";
    fs::write(dest.join(MANIFEST), manifest_json)
        .map_err(|e| format!("write pack.json: {e}"))?;

    let do_enable = enable.unwrap_or(true);
    let load = if do_enable {
        match enable_pack_inner(&packs, &pack_id) {
            Ok(r) => Some(r),
            Err(e) => {
                // Pack is on disk; report install success without load.
                tracing::warn!("installed {pack_id} but enable failed: {e}");
                None
            }
        }
    } else {
        None
    };

    Ok(PackInstallResult {
        id: pack_id,
        name: display_name,
        path: dest.to_string_lossy().into_owned(),
        banks: bank_names,
        renamed: renames,
        file_count: copied_files,
        bytes: copied_bytes,
        load,
    })
}

fn enable_pack_inner(packs: &Path, id: &str) -> Result<PackLoadResult, String> {
    let dir = packs.join(id);
    if !dir.is_dir() {
        return Err(format!("pack not installed: {id}"));
    }
    let m = load_manifest(&dir)?;
    let load = resolve_load(&dir, &m)?;
    let mut en = read_enabled(packs);
    if !en.enabled.iter().any(|e| e == id) {
        en.enabled.push(id.to_string());
        en.enabled.sort();
        write_enabled(packs, &en)?;
    }
    Ok(load)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_pack(root: &Path, id: &str, spdx: &str, bank: &str, files: &[&str]) {
        let dir = root.join(id);
        fs::create_dir_all(dir.join("banks").join(bank)).unwrap();
        for (i, name) in files.iter().enumerate() {
            let p = dir.join("banks").join(bank).join(name);
            let mut f = fs::File::create(&p).unwrap();
            // minimal valid-ish bytes; frontend decode not exercised here
            writeln!(f, "fake-wav-{i}").unwrap();
        }
        fs::write(dir.join("LICENSE"), "CC0\n").unwrap();
        let file_list: Vec<String> = files
            .iter()
            .map(|n| format!("banks/{bank}/{n}"))
            .collect();
        let banks_json = serde_json::json!([{
            "name": bank,
            "files": file_list,
        }]);
        let manifest = serde_json::json!({
            "schema": 1,
            "id": id,
            "name": id,
            "version": "1.0.0",
            "spdx": spdx,
            "license_file": "LICENSE",
            "banks": banks_json,
        });
        fs::write(
            dir.join("pack.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn pack_id_rules() {
        assert!(is_valid_pack_id("flbass-full"));
        assert!(is_valid_pack_id("a"));
        assert!(!is_valid_pack_id(""));
        assert!(!is_valid_pack_id("Bad"));
        assert!(!is_valid_pack_id("../x"));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(safe_rel_path("../etc/passwd").is_err());
        assert!(safe_rel_path("/abs").is_err());
        assert!(safe_rel_path("banks/ok.wav").is_ok());
    }

    #[test]
    fn load_and_enable_roundtrip() {
        let tmp = std::env::temp_dir().join(format!(
            "cycletron_packs_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        write_pack(&tmp, "demo-pack", "CC0-1.0", "demo_pluck", &["a.wav", "b.wav"]);

        let m = load_manifest(&tmp.join("demo-pack")).unwrap();
        assert_eq!(m.id, "demo-pack");
        let load = resolve_load(&tmp.join("demo-pack"), &m).unwrap();
        assert_eq!(load.banks.len(), 1);
        assert_eq!(load.banks[0].name, "demo_pluck");
        assert_eq!(load.banks[0].files.len(), 2);
        assert!(load.skipped.is_empty());

        let mut en = EnabledFile::default();
        en.enabled.push("demo-pack".into());
        write_enabled(&tmp, &en).unwrap();
        let en2 = read_enabled(&tmp);
        assert_eq!(en2.enabled, vec!["demo-pack".to_string()]);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn skips_core_bank_collision() {
        let tmp = std::env::temp_dir().join(format!(
            "cycletron_packs_core_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        // `bd` is a core drum bank
        write_pack(&tmp, "bad-drums", "CC0-1.0", "bd", &["x.wav"]);
        let m = load_manifest(&tmp.join("bad-drums")).unwrap();
        let err = resolve_load(&tmp.join("bad-drums"), &m).unwrap_err();
        assert!(err.contains("no loadable banks"), "{err}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_unknown_license() {
        let tmp = std::env::temp_dir().join(format!(
            "cycletron_packs_lic_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        write_pack(&tmp, "paid-pack", "Proprietary", "cool_lead", &["x.wav"]);
        let m = load_manifest(&tmp.join("paid-pack")).unwrap();
        let err = resolve_load(&tmp.join("paid-pack"), &m).unwrap_err();
        assert!(err.contains("allowlist"), "{err}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn id_must_match_folder() {
        let tmp = std::env::temp_dir().join(format!(
            "cycletron_packs_id_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        let dir = tmp.join("folder-a");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("LICENSE"), "x").unwrap();
        fs::write(
            dir.join("pack.json"),
            r#"{
              "schema": 1,
              "id": "folder-b",
              "name": "x",
              "version": "1.0.0",
              "spdx": "CC0-1.0",
              "license_file": "LICENSE",
              "banks": [{"name": "z", "files": ["LICENSE"]}]
            }"#,
        )
        .unwrap();
        let err = load_manifest(&dir).unwrap_err();
        assert!(err.contains("does not match"), "{err}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pack_id_from_folder() {
        assert_eq!(pack_id_from_folder_name("Dirt-Samples"), "dirt-samples");
        assert_eq!(pack_id_from_folder_name("  My Pack  "), "my-pack");
        assert_eq!(pack_id_from_folder_name("!!!"), "pack");
    }

    #[test]
    fn bank_rename_avoids_core() {
        let core = core_bank_names();
        let mut used = HashSet::new();
        let (n, r) = bank_name_for_pack("bd", "dirt", &core, &mut used);
        assert_eq!(n, "bd_dirt");
        assert_eq!(r.unwrap().from, "bd");
        // Non-core bank names are kept as-is.
        let (n2, r2) = bank_name_for_pack("zap", "dirt", &core, &mut used);
        assert_eq!(n2, "zap");
        assert!(r2.is_none());
    }

    #[test]
    fn install_from_folder_copies() {
        let pid = std::process::id();
        let src = std::env::temp_dir().join(format!("cycletron_install_src_{pid}"));
        let lib = std::env::temp_dir().join(format!("cycletron_install_lib_{pid}"));
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&lib);
        fs::create_dir_all(src.join("pluck")).unwrap();
        fs::create_dir_all(src.join("bd")).unwrap(); // core collision
        fs::write(src.join("pluck").join("a.wav"), b"RIFF....").unwrap();
        fs::write(src.join("bd").join("k.wav"), b"RIFF....").unwrap();

        let packs = packs_root(&lib);
        ensure_packs_dir(&lib).unwrap();

        // Inline the install body without AppState: exercise helpers.
        let scanned = crate::sounds::scan_folder_banks(&src).unwrap();
        assert_eq!(scanned.len(), 2);

        let pack_id = pack_id_from_folder_name("My-Sounds");
        assert_eq!(pack_id, "my-sounds");
        let dest = packs.join(&pack_id);
        fs::create_dir_all(&dest).unwrap();

        let core = core_bank_names();
        let mut used = HashSet::new();
        let mut manifest_banks = Vec::new();
        let mut renames = Vec::new();
        for bank in scanned {
            let (bank_name, rename) =
                bank_name_for_pack(&bank.name, &pack_id, &core, &mut used);
            if let Some(r) = rename {
                renames.push(r);
            }
            let mut rels = Vec::new();
            for (i, f) in bank.files.iter().enumerate() {
                let rel = format!("banks/{bank_name}/{i:03}.wav");
                copy_file(f, &dest.join(&rel)).unwrap();
                rels.push(rel);
            }
            manifest_banks.push(PackBank {
                name: bank_name,
                pitched: false,
                files: rels,
            });
        }
        assert!(renames.iter().any(|r| r.from == "bd" && r.to == "bd_my_sounds"));
        fs::write(dest.join("LICENSE"), "user\n").unwrap();
        let manifest = PackManifest {
            schema: 1,
            id: pack_id.clone(),
            name: "My Sounds".into(),
            version: "1.0.0".into(),
            description: String::new(),
            spdx: "LicenseRef-UserProvided".into(),
            license_file: "LICENSE".into(),
            authors: vec![],
            source: None,
            tags: vec![],
            banks: manifest_banks,
        };
        fs::write(
            dest.join("pack.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let load = enable_pack_inner(&packs, &pack_id).unwrap();
        assert!(load.banks.iter().any(|b| b.name == "pluck"));
        assert!(load.banks.iter().any(|b| b.name == "bd_my_sounds"));
        assert!(load.skipped.is_empty());

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&lib);
    }
}
