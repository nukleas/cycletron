//! User-editable settings overlay (Preferences modal).
//!
//! Lives at `{app_data_dir}/settings.json`. The on-disk shape is a small
//! subset of `AppConfig` — only the bits the user is meant to change at
//! runtime — plus updater configuration. Anything not set in the file
//! falls back to defaults from `config/default.toml`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserSettings {
    /// Multi-provider LLM configuration (active provider + per-provider
    /// profiles). API keys are NOT stored here — they live in the OS keychain.
    #[serde(default)]
    pub llm: LlmSettings,
    /// Legacy single-provider Anthropic block. Kept only so the pre-multiprovider
    /// plaintext key/model can be migrated into `llm` + the keychain on first
    /// launch; new writes go through `llm` and the keychain. See
    /// [`UserSettings::migrate_legacy_anthropic`].
    #[serde(default)]
    pub anthropic: AnthropicOverrides,
    #[serde(default)]
    pub audio: AudioOverrides,
    #[serde(default)]
    pub updater: UpdaterSettings,
    #[serde(default)]
    pub notifications: NotificationSettings,
    #[serde(default)]
    pub metronome: MetronomeSettings,
    #[serde(default)]
    pub midi_input: MidiInputSettings,
    /// First-run welcome modal has been dismissed. Defaults to false so a
    /// fresh install sees the onboarding flow.
    #[serde(default)]
    pub first_run_done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetronomeSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_metronome_volume")]
    pub volume: f32,
}

impl Default for MetronomeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            volume: default_metronome_volume(),
        }
    }
}

fn default_metronome_volume() -> f32 {
    0.4
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiInputSettings {
    /// Selected input device id (native `midir` port index, as a string).
    /// `None` = listen on all inputs.
    #[serde(default)]
    pub device_id: Option<String>,
    /// MIDI CC number that drives master gain (default: 7).
    #[serde(default = "default_cc_gain")]
    pub cc_gain: u8,
    /// MIDI CC number that drives BPM (default: 74).
    #[serde(default = "default_cc_bpm")]
    pub cc_bpm: u8,
    /// Play notes through a separate GM-soundfont synth as the keyboard is
    /// played (live monitoring), independent of the strudel scheduler.
    #[serde(default)]
    pub monitor_enabled: bool,
    /// Bank name of the monitor instrument (e.g. `"gm_piano"`).
    #[serde(default = "default_monitor_instrument")]
    pub monitor_instrument: String,
    /// Monitor output gain (0.0 – 1.0).
    #[serde(default = "default_monitor_gain")]
    pub monitor_gain: f32,
    /// Pad/key → action bindings configured via "learn" mode.
    #[serde(default)]
    pub pad_assignments: Vec<PadAssignment>,
}

impl Default for MidiInputSettings {
    fn default() -> Self {
        Self {
            device_id: None,
            cc_gain: default_cc_gain(),
            cc_bpm: default_cc_bpm(),
            monitor_enabled: false,
            monitor_instrument: default_monitor_instrument(),
            monitor_gain: default_monitor_gain(),
            pad_assignments: Vec::new(),
        }
    }
}

/// A single pad/key → action binding. The `trigger` is the MIDI message that
/// fires the `action`; both are matched/dispatched on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PadAssignment {
    pub trigger: PadTrigger,
    /// Action id, e.g. `"togglePlay"`, `"stop"`, `"hush"`, `"evaluate"`,
    /// `"commit"`, `"clear"`, `"newTrack"`.
    pub action: String,
}

/// The MIDI message that triggers a pad action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PadTrigger {
    /// `"cc"` or `"note"`.
    pub kind: String,
    /// CC number or note number.
    pub value: u8,
}

fn default_cc_gain() -> u8 { 7 }
fn default_cc_bpm() -> u8 { 74 }
fn default_monitor_instrument() -> String { "sawtooth".to_string() }
fn default_monitor_gain() -> f32 { 0.8 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnthropicOverrides {
    /// API key. `None` means fall back to `ANTHROPIC_API_KEY` env var.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Model id. `None` means use the bundled default.
    #[serde(default)]
    pub model: Option<String>,
    /// Max tokens per response. `None` means use the bundled default.
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

// ---------------------------------------------------------------------------
// Multi-provider LLM settings
// ---------------------------------------------------------------------------

/// LLM provider configuration: which provider is active, plus a per-provider
/// profile for each preset. API keys are never stored here — they live in the
/// OS keychain (see `secrets.rs`), keyed by provider id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSettings {
    /// Active provider id: `"anthropic"`, `"grok"`, `"openai"`, `"local"`, or
    /// `"custom"`.
    #[serde(default = "default_active_provider")]
    pub active: String,
    /// Per-provider profiles keyed by id. Missing entries fall back to the
    /// built-in preset defaults, so a partial map is fine.
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderProfile>,
}

/// One provider's settings. The API key lives in the keychain, not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProfile {
    /// Wire codec: `"anthropic"` (Messages API) or `"openai"` (OpenAI-compatible
    /// chat completions — covers Grok, OpenAI, Ollama, LM Studio, …).
    pub codec: String,
    /// Base URL for OpenAI-compatible providers (e.g. `https://api.x.ai/v1`).
    /// `None`/empty for the Anthropic codec (endpoint is fixed).
    #[serde(default)]
    pub base_url: Option<String>,
    /// Model id.
    pub model: String,
    /// Max output tokens per response.
    pub max_tokens: u32,
}

fn default_active_provider() -> String {
    "anthropic".to_string()
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            active: default_active_provider(),
            providers: builtin_profiles(),
        }
    }
}

impl LlmSettings {
    /// Resolve the active provider's profile, filling in built-in defaults for
    /// any missing profile or unknown active id.
    pub fn active_profile(&self) -> ProviderProfile {
        self.providers
            .get(&self.active)
            .cloned()
            .or_else(|| builtin_profile(&self.active))
            .unwrap_or_else(|| builtin_profile("anthropic").expect("anthropic preset exists"))
    }
}

/// Built-in preset profile for a provider id, or `None` for an unknown id.
pub fn builtin_profile(id: &str) -> Option<ProviderProfile> {
    let p = |codec: &str, base: Option<&str>, model: &str, max_tokens: u32| ProviderProfile {
        codec: codec.to_string(),
        base_url: base.map(|s| s.to_string()),
        model: model.to_string(),
        max_tokens,
    };
    Some(match id {
        "anthropic" => p("anthropic", None, "claude-sonnet-4-6", 64000),
        "grok" => p("openai", Some("https://api.x.ai/v1"), "grok-4.5", 32000),
        "openai" => p("openai", Some("https://api.openai.com/v1"), "gpt-4.1", 16000),
        "local" => p("openai", Some("http://localhost:11434/v1"), "llama3.1", 8192),
        "custom" => p("openai", None, "", 8192),
        _ => return None,
    })
}

fn builtin_profiles() -> BTreeMap<String, ProviderProfile> {
    ["anthropic", "grok", "openai", "local", "custom"]
        .into_iter()
        .filter_map(|id| builtin_profile(id).map(|p| (id.to_string(), p)))
        .collect()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioOverrides {
    /// Default tempo in BPM (`None` = use bundled default).
    #[serde(default)]
    pub default_tempo: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdaterSettings {
    /// Whether to check for updates automatically on startup. The actual
    /// endpoint(s) live in `tauri.conf.json` under `plugins.updater.endpoints`
    /// since the Tauri v2 updater plugin reads them at build time, not from
    /// user settings.
    #[serde(default = "default_true")]
    pub auto_check: bool,
}

fn default_true() -> bool {
    true
}

impl UserSettings {
    pub fn load(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join(SETTINGS_FILE);
        if let Ok(s) = fs::read_to_string(&path)
            && let Ok(parsed) = serde_json::from_str::<Self>(&s)
        {
            return parsed;
        }
        Self::default()
    }

    pub fn save(&self, app_data_dir: &Path) -> std::io::Result<()> {
        fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join(SETTINGS_FILE);
        let s = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(path, s)
    }

    /// Migrate the pre-multiprovider `anthropic` block into the new `llm` model
    /// plus the OS keychain. Returns the plaintext API key that should be moved
    /// into the keychain (the caller stores it, since keychain access lives in
    /// the app crate). Mutates `self`: blanks the legacy key/model/max_tokens
    /// and seeds the `anthropic` provider profile from any legacy overrides.
    /// Idempotent — a second run finds nothing to migrate and returns `None`.
    pub fn migrate_legacy_anthropic(&mut self) -> Option<String> {
        let key = self.anthropic.api_key.take().filter(|k| !k.is_empty());
        let legacy_model = self.anthropic.model.take().filter(|m| !m.is_empty());
        let legacy_max_tokens = self.anthropic.max_tokens.take();

        if legacy_model.is_some() || legacy_max_tokens.is_some() {
            let profile = self
                .llm
                .providers
                .entry("anthropic".to_string())
                .or_insert_with(|| builtin_profile("anthropic").expect("anthropic preset exists"));
            if let Some(model) = legacy_model {
                profile.model = model;
            }
            if let Some(max_tokens) = legacy_max_tokens {
                profile.max_tokens = max_tokens;
            }
        }

        key
    }

    /// Apply user overrides on top of an [`AppConfig`]. Mutates in place.
    pub fn apply_to(&self, config: &mut robostrudel_core::config::AppConfig) {
        if let Some(key) = &self.anthropic.api_key {
            if !key.is_empty() {
                config.anthropic.api_key = Some(key.clone());
            }
        }
        if let Some(model) = &self.anthropic.model {
            if !model.is_empty() {
                config.anthropic.model = model.clone();
            }
        }
        if let Some(n) = self.anthropic.max_tokens {
            config.anthropic.max_tokens = n;
        }
        if let Some(t) = self.audio.default_tempo {
            config.audio.default_tempo = t;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_profile_falls_back_to_builtin() {
        // Empty providers map: resolver still returns the built-in preset.
        let llm = LlmSettings {
            active: "grok".to_string(),
            providers: BTreeMap::new(),
        };
        let p = llm.active_profile();
        assert_eq!(p.codec, "openai");
        assert_eq!(p.base_url.as_deref(), Some("https://api.x.ai/v1"));
    }

    #[test]
    fn unknown_active_falls_back_to_anthropic() {
        let llm = LlmSettings {
            active: "does-not-exist".to_string(),
            providers: BTreeMap::new(),
        };
        assert_eq!(llm.active_profile().codec, "anthropic");
    }

    #[test]
    fn migrate_moves_key_and_seeds_profile() {
        let mut s = UserSettings::default();
        s.anthropic.api_key = Some("sk-legacy".to_string());
        s.anthropic.model = Some("claude-opus-4-8".to_string());
        s.anthropic.max_tokens = Some(12345);

        let key = s.migrate_legacy_anthropic();
        assert_eq!(key.as_deref(), Some("sk-legacy"));
        // Legacy fields blanked.
        assert!(s.anthropic.api_key.is_none());
        assert!(s.anthropic.model.is_none());
        assert!(s.anthropic.max_tokens.is_none());
        // Anthropic profile seeded from the legacy overrides.
        let p = &s.llm.providers["anthropic"];
        assert_eq!(p.model, "claude-opus-4-8");
        assert_eq!(p.max_tokens, 12345);

        // Idempotent: a second run finds nothing to migrate.
        assert!(s.migrate_legacy_anthropic().is_none());
    }
}
