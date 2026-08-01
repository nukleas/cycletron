use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub corpus: CorpusConfig,
    pub audio: AudioConfig,
    pub ui: UiConfig,
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
    /// Path to the ingested-idiom store produced by `midi-ingest` (holds the
    /// `*.index.json` manifests + converted `.strudel` snippets). Queried by
    /// `strudel-search` and the research pipeline. Lives outside the repo.
    #[serde(default = "default_ingested_path")]
    pub ingested_path: Option<PathBuf>,
}

fn default_curated_path() -> Option<PathBuf> {
    Some(PathBuf::from("corpus"))
}

fn default_ingested_path() -> Option<PathBuf> {
    Some(PathBuf::from("../strudel-training/ingested"))
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
            corpus: CorpusConfig {
                path: PathBuf::from("../strudel-corpus"),
                metadata_index: None,
                parts_index: None,
                curated_path: default_curated_path(),
                ingested_path: default_ingested_path(),
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
