use crate::files::Recents;
use crate::library::{self, LibrarySettings};
use crate::settings::UserSettings;
use robostrudel_agent::ClaudeClient;
use robostrudel_core::config::AppConfig;
use robostrudel_core::session::Session;
use robostrudel_corpus::InMemoryCorpusIndex;
use std::path::PathBuf;
use std::sync::Mutex;

/// Shared application state managed by Tauri.
/// Audio is handled by the WASM REPL in the frontend — the backend
/// only manages AI, corpus, and session state.
pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub session: Mutex<Session>,
    pub corpus: Mutex<Option<InMemoryCorpusIndex>>,
    pub agent_client: Mutex<Option<ClaudeClient>>,
    pub recents: Mutex<Recents>,
    /// User library settings (root path for the in-app file explorer).
    pub library: Mutex<LibrarySettings>,
    /// User-editable preferences overlay (settings.json).
    pub user_settings: Mutex<UserSettings>,
    /// App data directory (for recents.json + session.json).
    /// Populated during `initialize_with_dir` after Tauri hands us the resolved path.
    pub app_data_dir: Mutex<Option<PathBuf>>,
    /// Timestamp of the last successful autosave. Populated/read by persistence.
    pub last_autosave: Mutex<Option<std::time::Instant>>,
    /// Sample bank names the frontend has loaded from the user's disk (so the
    /// agent's `list_sounds` tool can report which custom sounds are playable).
    pub loaded_sample_banks: Mutex<Vec<String>>,
}

impl AppState {
    pub fn new() -> Self {
        let config = AppConfig::default();
        let session = Session::new(config.audio.default_tempo);

        Self {
            config: Mutex::new(config),
            session: Mutex::new(session),
            corpus: Mutex::new(None),
            agent_client: Mutex::new(None),
            recents: Mutex::new(Recents::new()),
            library: Mutex::new(LibrarySettings {
                root: PathBuf::new(),
            }),
            user_settings: Mutex::new(UserSettings::default()),
            app_data_dir: Mutex::new(None),
            last_autosave: Mutex::new(None),
            loaded_sample_banks: Mutex::new(Vec::new()),
        }
    }

    /// Initialize corpus, Claude client, and load persisted state from disk.
    /// `data_dir` is the Tauri-resolved per-app data directory.
    pub fn initialize(&self, data_dir: PathBuf) -> anyhow::Result<()> {
        *self.app_data_dir.lock().unwrap() = Some(data_dir.clone());

        // User settings overlay first so the rest of init sees the merged config.
        let user = UserSettings::load(&data_dir);
        {
            let mut config = self.config.lock().unwrap();
            user.apply_to(&mut config);
            // Session tempo follows config.audio.default_tempo.
            self.session.lock().unwrap().tempo = config.audio.default_tempo;
        }
        *self.user_settings.lock().unwrap() = user;

        let config = self.config.lock().unwrap();

        // Corpus. The config path may be relative — anchor it against the
        // workspace root (one level up from this crate's manifest dir) so
        // `cargo tauri dev` works regardless of the process cwd.
        let corpus_path = resolve_corpus_path(&config.corpus.path);
        let curated_path = config
            .corpus
            .curated_path
            .as_ref()
            .map(|p| resolve_corpus_path(p));
        match InMemoryCorpusIndex::load_with_curated(&corpus_path, curated_path.as_deref()) {
            Ok(corpus) => *self.corpus.lock().unwrap() = Some(corpus),
            Err(e) => tracing::warn!("corpus failed to load: {e}"),
        }

        // Claude client
        let api_key = config
            .anthropic
            .api_key
            .clone()
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok());

        if let Some(key) = api_key {
            let client =
                ClaudeClient::new(&key, &config.anthropic.model, config.anthropic.max_tokens);
            *self.agent_client.lock().unwrap() = Some(client);
        } else {
            tracing::warn!("no ANTHROPIC_API_KEY configured — AI features disabled");
        }
        drop(config);

        // Recents
        let mut recents = Recents::load(&data_dir);
        recents.prune_missing();
        *self.recents.lock().unwrap() = recents;

        // Library: load settings or fall back to {app_data_dir}/library,
        // ensure the directory exists so the explorer always has a home.
        let settings = LibrarySettings::load_or_default(&data_dir);
        if let Err(e) = library::ensure_root_exists(&settings.root) {
            tracing::warn!(
                "could not create library root {}: {e}",
                settings.root.display()
            );
        }
        *self.library.lock().unwrap() = settings;

        Ok(())
    }

    pub fn library_root(&self) -> PathBuf {
        self.library.lock().unwrap().root.clone()
    }

    /// Rebuild the Anthropic client from current config. Called after the
    /// user changes their API key / model / max-tokens via Preferences.
    pub fn rebuild_agent_client(&self) {
        let config = self.config.lock().unwrap();
        let api_key = config
            .anthropic
            .api_key
            .clone()
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok());
        let new_client = api_key.map(|key| {
            ClaudeClient::new(&key, &config.anthropic.model, config.anthropic.max_tokens)
        });
        drop(config);
        *self.agent_client.lock().unwrap() = new_client;
    }

    pub fn app_data_dir(&self) -> Option<PathBuf> {
        self.app_data_dir.lock().unwrap().clone()
    }
}

/// Turn a relative corpus path into an absolute one, anchored at the
/// workspace root (parent of this crate's Cargo manifest dir). Absolute
/// paths are returned as-is. `cargo tauri dev` runs the binary with cwd
/// at `src-tauri/` so we can't rely on process cwd.
fn resolve_corpus_path(path: &std::path::Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(manifest_dir);
    workspace_root.join(path)
}
