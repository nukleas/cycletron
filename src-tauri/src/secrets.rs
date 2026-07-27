//! API-key storage.
//!
//! Keys are stored per provider so a Claude key and a Grok key can coexist.
//! Account id = the provider id (`"anthropic"`, `"grok"`, `"openai"`, …).
//!
//! **Debug builds (`cargo tauri dev`):** keys live in a local file under the
//! app data dir (`provider-keys.json`). The OS keychain is **never** touched.
//! Dev binaries are unsigned / re-linked on every rebuild, so keychain
//! “Always Allow” cannot stick and re-prompts on every launch — that is the
//! whole reason for the file store.
//!
//! **Release builds:** OS keychain first (service `"cycletron"`), then the
//! provider’s environment variable (`ANTHROPIC_API_KEY`, `XAI_API_KEY`,
//! `OPENAI_API_KEY`).
//!
//! Builds from before the product rename used keychain service `"robostrudel"`.
//! Re-enter keys once after upgrade if the keychain entry is missing.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use keyring::Entry;

const SERVICE: &str = "cycletron";
const DEV_KEYS_FILE: &str = "provider-keys.json";

static DEV_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Call once at app startup with the resolved app-data directory.
/// Required for debug file storage; harmless in release.
pub fn init(app_data_dir: &Path) {
    if let Ok(mut guard) = DEV_DIR.lock() {
        *guard = Some(app_data_dir.to_path_buf());
    }
    if cfg!(debug_assertions) {
        tracing::info!(
            target: "cycletron::secrets",
            path = %app_data_dir.join(DEV_KEYS_FILE).display(),
            "debug build: API keys stored in local file (keychain disabled)"
        );
    }
}

/// Resolve a provider's API key.
pub fn get_key(provider_id: &str) -> Option<String> {
    let from_env = || {
        env_var_for(provider_id)
            .and_then(|var| std::env::var(var).ok())
            .filter(|s| !s.is_empty())
    };

    if cfg!(debug_assertions) {
        // Env still wins so a shell export overrides the file without editing UI.
        return from_env().or_else(|| file_get(provider_id));
    }

    from_keychain(provider_id).or_else(from_env)
}

/// Store (or, when `key` is empty, delete) a provider's key.
pub fn set_key(provider_id: &str, key: &str) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return file_set(provider_id, key);
    }
    keychain_set(provider_id, key)
}

/// Whether a usable key exists for this provider.
pub fn has_key(provider_id: &str) -> bool {
    get_key(provider_id).is_some()
}

fn env_var_for(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "grok" => Some("XAI_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        _ => None,
    }
}

// ── Debug file store ──────────────────────────────────────────────────────

fn file_path() -> Result<PathBuf, String> {
    DEV_DIR
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .map(|d| d.join(DEV_KEYS_FILE))
        .ok_or_else(|| "secrets store not initialized (call secrets::init first)".into())
}

fn file_load() -> BTreeMap<String, String> {
    let Ok(path) = file_path() else {
        return BTreeMap::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn file_get(provider_id: &str) -> Option<String> {
    file_load()
        .get(provider_id)
        .cloned()
        .filter(|s| !s.is_empty())
}

fn file_set(provider_id: &str, key: &str) -> Result<(), String> {
    let path = file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut map = file_load();
    if key.is_empty() {
        map.remove(provider_id);
    } else {
        map.insert(provider_id.to_string(), key.to_string());
    }
    let raw = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    write_private(&path, raw.as_bytes())?;
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| e.to_string())
}

// ── Release keychain ──────────────────────────────────────────────────────

fn from_keychain(provider_id: &str) -> Option<String> {
    if let Ok(entry) = Entry::new(SERVICE, provider_id)
        && let Ok(pw) = entry.get_password()
        && !pw.is_empty()
    {
        return Some(pw);
    }
    None
}

fn keychain_set(provider_id: &str, key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| e.to_string())?;
    if key.is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry.set_password(key).map_err(|e| e.to_string())
    }
}
