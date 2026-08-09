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
    let dir = packs.join(&id);
    if !dir.is_dir() {
        return Err(format!("pack not installed: {id}"));
    }
    let m = load_manifest(&dir)?;
    let load = resolve_load(&dir, &m)?;

    let mut en = read_enabled(&packs);
    if !en.enabled.iter().any(|e| e == &id) {
        en.enabled.push(id);
        en.enabled.sort();
        write_enabled(&packs, &en)?;
    }
    Ok(load)
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

// --- tests ----------------------------------------------------------------

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
}
