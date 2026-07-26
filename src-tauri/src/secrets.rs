//! API-key storage in the OS keychain.
//!
//! Keys are stored per provider so a Claude key and a Grok key can coexist.
//! Service = `"cycletron"`, account = the provider id (`"anthropic"`,
//! `"grok"`, `"openai"`, …). Reads fall back to a provider-specific environment
//! variable when the keychain has no entry, preserving the old
//! `ANTHROPIC_API_KEY` workflow.
//!
//! Pre-rename builds used service `"robostrudel"` — re-enter keys once after upgrade
//! (or set the env var) if the keychain entry is missing.

use keyring::Entry;

const SERVICE: &str = "cycletron";

/// Resolve a provider's API key.
///
/// Release builds: keychain first (the UI-managed key wins), env var second.
///
/// Debug builds: **env var first**. Every `cargo tauri dev` rebuild is a new
/// unsigned binary, so macOS re-prompts for keychain access on every launch —
/// "Always Allow" can never stick. Checking the env var first means a dev
/// shell with ANTHROPIC_API_KEY etc. exported never touches the keychain and
/// never prompts. (To exercise the keychain flow in dev, unset the var.)
pub fn get_key(provider_id: &str) -> Option<String> {
    let from_env = || {
        env_var_for(provider_id)
            .and_then(|var| std::env::var(var).ok())
            .filter(|s| !s.is_empty())
    };
    let from_keychain = || {
        if let Ok(entry) = Entry::new(SERVICE, provider_id)
            && let Ok(pw) = entry.get_password()
            && !pw.is_empty()
        {
            return Some(pw);
        }
        None
    };
    if cfg!(debug_assertions) {
        from_env().or_else(from_keychain)
    } else {
        from_keychain().or_else(from_env)
    }
}

/// Store (or, when `key` is empty, delete) a provider's key in the keychain.
pub fn set_key(provider_id: &str, key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| e.to_string())?;
    if key.is_empty() {
        // Deleting a non-existent credential is not an error we care about.
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry.set_password(key).map_err(|e| e.to_string())
    }
}

/// Whether a usable key exists for this provider (keychain or env fallback).
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
