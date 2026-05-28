use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub anthropic: AnthropicConfig,
    pub corpus: CorpusConfig,
    pub audio: AudioConfig,
    pub ui: UiConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicConfig {
    /// API key, or read from ANTHROPIC_API_KEY env var.
    pub api_key: Option<String>,
    /// Model to use.
    #[serde(default = "default_model")]
    pub model: String,
    /// Max tokens per response.
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusConfig {
    /// Path to strudel-corpus directory.
    pub path: PathBuf,
    /// Path to the normalized metadata index.
    #[serde(default)]
    pub metadata_index: Option<PathBuf>,
    /// Path to the agent parts index.
    #[serde(default)]
    pub parts_index: Option<PathBuf>,
    /// Path to the hand-curated corpus directory (gated by `corpus-check`).
    /// Loaded ahead of the bulk corpus so curated entries surface first.
    #[serde(default = "default_curated_path")]
    pub curated_path: Option<PathBuf>,
}

fn default_curated_path() -> Option<PathBuf> {
    Some(PathBuf::from("corpus"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    /// Default tempo in BPM.
    #[serde(default = "default_tempo")]
    pub default_tempo: f64,
    /// Path to samples directory or strudel.json manifest.
    pub samples_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiConfig {
    /// Dark or light theme.
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_model() -> String {
    "claude-sonnet-4-6".to_string()
}

fn default_max_tokens() -> u32 {
    8192
}

fn default_tempo() -> f64 {
    120.0
}

fn default_theme() -> String {
    "dark".to_string()
}

impl AppConfig {
    /// Load config from a TOML file, falling back to defaults.
    pub fn load(path: &Path) -> crate::Result<Self> {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            toml::from_str(&content).map_err(|e| crate::Error::Config(e.to_string()))
        } else {
            Ok(Self::default())
        }
    }

    /// Save config to a TOML file.
    pub fn save(&self, path: &Path) -> crate::Result<()> {
        let content =
            toml::to_string_pretty(self).map_err(|e| crate::Error::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            anthropic: AnthropicConfig {
                api_key: None,
                model: default_model(),
                max_tokens: default_max_tokens(),
            },
            corpus: CorpusConfig {
                path: PathBuf::from("../strudel-corpus"),
                metadata_index: None,
                parts_index: None,
                curated_path: default_curated_path(),
            },
            audio: AudioConfig {
                default_tempo: default_tempo(),
                samples_path: None,
            },
            ui: UiConfig {
                theme: default_theme(),
            },
        }
    }
}
