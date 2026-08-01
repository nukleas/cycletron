use crate::files::Recents;
use crate::library::{self, LibrarySettings};
use crate::settings::UserSettings;
use cycletron_agent::{ClaudeClient, CodexClient, LlmProvider, OpenAiClient};
use cycletron_core::config::AppConfig;
use cycletron_core::session::Session;
use cycletron_corpus::{InMemoryCorpusIndex, Recipe};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Shared application state managed by Tauri.
/// Audio is handled by the WASM REPL in the frontend — the backend
/// only manages AI, corpus, and session state.
pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub session: Mutex<Session>,
    pub corpus: Mutex<Option<InMemoryCorpusIndex>>,
    /// Active LLM backend. Boxed behind the [`LlmProvider`] trait so the
    /// selected provider (Claude, Grok, OpenAI-compatible, local) is swappable
    /// without the rest of the app knowing which one is live.
    pub agent_client: Mutex<Option<Arc<dyn LlmProvider>>>,
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
    /// Genre recipes loaded from `<corpus>/genres/*.md` — the knowledge base
    /// behind the `genre_recipe` tool.
    pub recipes: Mutex<Vec<Recipe>>,
    /// Per-turn library read budget `(files, bytes)` — bounds how much of the
    /// user's own files `read_song` can send to the model in one turn, so a
    /// broad library root can't be dumped to a cloud provider. Reset each turn.
    pub read_budget: Mutex<(usize, usize)>,
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
            recipes: Mutex::new(Vec::new()),
            read_budget: Mutex::new((0, 0)),
        }
    }

    /// Start a fresh per-turn library read budget.
    pub fn reset_read_budget(&self) {
        *self.read_budget.lock().unwrap() = (0, 0);
    }

    /// Account one `read_song` against this turn's egress budget. Returns an
    /// error (and does NOT charge the budget) when the read would exceed the
    /// per-turn file-count or byte ceiling — the caller then refuses the read so
    /// the content never leaves the machine.
    pub fn account_read(&self, bytes: usize) -> Result<(), String> {
        let mut b = self.read_budget.lock().unwrap();
        if b.0 >= crate::library_index::MAX_READ_FILES_PER_TURN {
            return Err(format!(
                "Read limit reached: {} songs already opened this turn. Be selective about which \
                 song you open, or ask the user to narrow it down.",
                crate::library_index::MAX_READ_FILES_PER_TURN
            ));
        }
        if b.1 + bytes > crate::library_index::MAX_READ_BYTES_PER_TURN {
            return Err(format!(
                "Read size budget reached (~{} KB of library content this turn). Open fewer or \
                 smaller songs.",
                crate::library_index::MAX_READ_BYTES_PER_TURN / 1024
            ));
        }
        b.0 += 1;
        b.1 += bytes;
        Ok(())
    }

    /// Initialize corpus, Claude client, and load persisted state from disk.
    /// `data_dir` is the Tauri-resolved per-app data directory.
    pub fn initialize(&self, data_dir: PathBuf) -> anyhow::Result<()> {
        *self.app_data_dir.lock().unwrap() = Some(data_dir.clone());
        // Debug: keys go to `{data_dir}/provider-keys.json` (no keychain prompts).
        // Release: OS keychain. Must run before any get_key/set_key.
        crate::secrets::init(&data_dir);
        crate::xai_oauth::init(&data_dir);
        crate::codex_oauth::init(&data_dir);

        // User settings overlay first so the rest of init sees the merged config.
        let mut user = UserSettings::load(&data_dir);

        // Migrate a pre-multiprovider plaintext API key out of settings.json.
        if let Some(key) = user.migrate_legacy_anthropic() {
            match crate::secrets::set_key("anthropic", &key) {
                Ok(()) => {
                    tracing::info!("migrated plaintext API key into secrets store");
                    let _ = user.save(&data_dir);
                }
                Err(e) => {
                    tracing::warn!("could not migrate API key into secrets store: {e}");
                    user.anthropic.api_key = Some(key);
                }
            }
        }

        {
            let mut config = self.config.lock().unwrap();
            user.apply_to(&mut config);
            // Session tempo follows config.audio.default_tempo.
            self.session.lock().unwrap().tempo = config.audio.default_tempo;
        }
        *self.user_settings.lock().unwrap() = user;

        // Corpus + genre recipes — the agent's knowledge base.
        self.load_knowledge();

        // AI backend, built from the active provider profile + its keychain key.
        let client = self.build_agent_client();
        if client.is_none() {
            tracing::warn!("no AI provider configured — AI features disabled");
        }
        *self.agent_client.lock().unwrap() = client;

        // Recents
        let mut recents = Recents::load(&data_dir);
        recents.prune_missing();
        *self.recents.lock().unwrap() = recents;

        // Library: load settings or fall back to {app_data_dir}/library,
        // then prepare (mkdir + seed Demos/). Same path as set_library_root.
        let settings = LibrarySettings::load_or_default(&data_dir);
        if let Err(e) = library::prepare_root(&settings.root) {
            tracing::warn!(
                "could not initialize library at {}: {e}",
                settings.root.display()
            );
        }
        *self.library.lock().unwrap() = settings;

        Ok(())
    }

    /// (Re)load the corpus index and genre recipes from disk into state. Safe to
    /// call again at runtime — the `reload_corpus` command uses it so regenerated
    /// recipes / edited corpus entries are picked up without restarting the app
    /// (recipes are otherwise read exactly once at startup). Returns the recipe
    /// count for the caller to report.
    pub fn load_knowledge(&self) -> usize {
        let config = self.config.lock().unwrap();
        // The config path may be relative — anchor it against the workspace root
        // (one level up from this crate's manifest dir) so `cargo tauri dev` works
        // regardless of the process cwd.
        let corpus_path = resolve_corpus_path(&config.corpus.path);
        let curated_path = config
            .corpus
            .curated_path
            .as_ref()
            .map(|p| resolve_corpus_path(p));
        drop(config);

        match InMemoryCorpusIndex::load_with_curated(&corpus_path, curated_path.as_deref()) {
            Ok(corpus) => *self.corpus.lock().unwrap() = Some(corpus),
            Err(e) => tracing::warn!("corpus failed to load: {e}"),
        }

        // Genre recipes live under `<corpus>/genres/` — prefer the curated dir
        // (the repo's hand-gated corpus), falling back to the bulk corpus path.
        let genres_dir = curated_path
            .unwrap_or_else(|| corpus_path.clone())
            .join("genres");
        let recipes = cycletron_corpus::recipes::load_recipes(&genres_dir);
        let n = recipes.len();
        tracing::info!("loaded {n} genre recipe(s) from {}", genres_dir.display());
        *self.recipes.lock().unwrap() = recipes;
        n
    }

    pub fn library_root(&self) -> PathBuf {
        self.library.lock().unwrap().root.clone()
    }

    /// Rebuild the AI client from the active provider profile + keychain key.
    /// Called after the user changes provider / model / key via Preferences.
    pub fn rebuild_agent_client(&self) {
        let new_client = self.build_agent_client();
        *self.agent_client.lock().unwrap() = new_client;
    }

    /// Construct the client for the active provider, pulling its key from the
    /// keychain (env fallback) or xAI OAuth for Grok. Returns `None` when the
    /// provider can't run — Anthropic with no key, or an OpenAI-compatible
    /// provider with no base URL.
    fn build_agent_client(&self) -> Option<Arc<dyn LlmProvider>> {
        let (active, profile) = {
            let us = self.user_settings.lock().unwrap();
            (us.llm.active.clone(), us.llm.active_profile())
        };
        // Prefer a still-valid SuperGrok OAuth access token for Grok; fall
        // back to API key / env. Callers that need a guaranteed-fresh token
        // should run `xai_oauth::ensure_fresh` first (see send_message).
        let key = resolve_provider_credential(&active);

        match profile.codec.as_str() {
            "anthropic" => {
                // Anthropic authenticates every request — no key means disabled.
                let key = key?;
                Some(Arc::new(ClaudeClient::new(
                    &key,
                    &profile.model,
                    profile.max_tokens,
                )))
            }
            "codex" => {
                // ChatGPT subscription OAuth → Codex Responses backend.
                let (access, account_id) = crate::codex_oauth::peek_credential()?;
                let base = profile.base_url.as_deref();
                Some(Arc::new(CodexClient::new(
                    &access,
                    &account_id,
                    &profile.model,
                    profile.max_tokens,
                    base,
                )))
            }
            "openai" => {
                let base = profile.base_url.clone().unwrap_or_default();
                if base.is_empty() {
                    tracing::warn!("provider '{active}' has no base URL configured — AI disabled");
                    return None;
                }
                // Key is optional here so local servers (Ollama) work unauthenticated.
                Some(Arc::new(OpenAiClient::new(
                    key.as_deref().unwrap_or(""),
                    &base,
                    &profile.model,
                    profile.max_tokens,
                )))
            }
            other => {
                tracing::warn!("unknown provider codec '{other}' — AI disabled");
                None
            }
        }
    }

    pub fn app_data_dir(&self) -> Option<PathBuf> {
        self.app_data_dir.lock().unwrap().clone()
    }
}

/// Resolve a bearer/API credential for `provider_id`: an OAuth access token if
/// the provider uses subscription OAuth and is signed in (see [`crate::oauth`]),
/// otherwise the stored/env API key. Codex additionally needs an account id, so
/// `build_agent_client` reads its full credential directly — this returns only
/// the bearer, used for generic key resolution.
pub(crate) fn resolve_provider_credential(provider_id: &str) -> Option<String> {
    crate::oauth::peek_access_token(provider_id)
        .or_else(|| crate::secrets::get_key(provider_id))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library_index::{MAX_READ_BYTES_PER_TURN, MAX_READ_FILES_PER_TURN};

    #[test]
    fn read_budget_bounds_files_and_bytes_per_turn() {
        let s = AppState::new();
        s.reset_read_budget();
        // up to the file limit is fine…
        for _ in 0..MAX_READ_FILES_PER_TURN {
            assert!(s.account_read(1_000).is_ok());
        }
        // …the next read is refused (file-count ceiling).
        assert!(s.account_read(1_000).is_err());

        // A fresh turn resets, and the BYTE ceiling also bites.
        s.reset_read_budget();
        assert!(s.account_read(MAX_READ_BYTES_PER_TURN).is_ok());
        assert!(s.account_read(1).is_err());
    }
}
