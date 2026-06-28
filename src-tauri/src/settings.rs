//! User-editable settings overlay (Preferences modal).
//!
//! Lives at `{app_data_dir}/settings.json`. The on-disk shape is a small
//! subset of `AppConfig` — only the bits the user is meant to change at
//! runtime — plus updater configuration. Anything not set in the file
//! falls back to defaults from `config/default.toml`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserSettings {
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
