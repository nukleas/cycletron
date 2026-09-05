//! Downloadable sample sets — a small registry, package-manager style.
//!
//! A **sample set** is an ordered list of `strudel.json` manifest sources;
//! the order is the mapping: the first manifest owning a bank name wins,
//! exactly like strudio's registration order. Built in:
//!
//! - `cycletron` — the bundled, license-audited set (always ready, nothing to
//!   download; export resolves it from the app's resource dir).
//! - the downloadable [`BUILTIN_SETS`]: the strudio defaults, the strudel.cc
//!   defaults, and the individual packs those are made of (drum machines,
//!   VCSL, mridangam) so nobody downloads 300 MB for one kit.
//!
//! Users can define more sets in `{app_data}/sample-sets.json`:
//!
//! ```json
//! [{"id": "my-breaks", "label": "My breaks",
//!   "sources": ["github:user/breaks-pack", "https://example.com/kit.json"]}]
//! ```
//!
//! Downloads land in `{app_cache}/sample-sets/sources/<slug>/`, one dir per
//! *source*, so sets that share a source (VCSL is in both `vcsl` and
//! `strudel-cc`) share one download. Nothing is redistributed by us: the user's
//! machine fetches from the same upstream URLs the strudel-rs engine streams
//! from. Per source we write a *localized* `strudel.json` — the upstream
//! manifest with `_base` stripped, resolved against its own directory —
//! atomically and **last**, so its presence marks the source complete
//! (interrupted downloads resume by skipping files that already exist).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use strudel_audio::default_sources;
use tauri::{Emitter, Manager};
use tokio::sync::Semaphore;

/// The always-ready bundled set. Not listed in [`definitions`]' downloadable
/// entries' cache dirs — export resolves it from the Tauri resource dir.
pub const BUNDLED_SET_ID: &str = "cycletron";

/// User-defined set registry, relative to the app data dir.
const REGISTRY_FILE: &str = "sample-sets.json";

/// Concurrent file downloads per source. Dirt-Samples is ~1,800 raw
/// GitHub fetches; keep this modest to stay under rate limits.
const CONCURRENCY: usize = 6;
const RETRIES: u32 = 3;

/// Localized per-source manifest filename (written last = completion marker).
const LOCAL_MANIFEST: &str = "strudel.json";

static DOWNLOAD_RUNNING: AtomicBool = AtomicBool::new(false);

/// One sample set: an id, a human label, and manifest sources in precedence
/// order (`github:user/repo[/branch]` or a direct manifest URL).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetDefinition {
    pub id: String,
    pub label: String,
    /// One line for the Samples manager: what it adds and under what license.
    #[serde(default)]
    pub description: String,
    pub sources: Vec<String>,
}

/// A definition plus its on-disk download state, for the Preferences UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStatus {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Built-in sets can't be edited away; the bundled one can't be removed.
    pub builtin: bool,
    /// Bundled set: always true. Others: every source's localized manifest
    /// is on disk.
    pub ready: bool,
    pub files: u64,
    pub bytes: u64,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    set: &'a str,
    source: &'a str,
    done: usize,
    total: usize,
}

/// A source's localized manifest, handed to the frontend so live playback
/// can lazy-load banks from the same files export renders from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceManifest {
    pub id: String,
    /// Directory the manifest's relative paths resolve against.
    pub dir: String,
    pub manifest: serde_json::Value,
}

/// Resolve strudel's `github:user/repo[/branch]` (and other special) source
/// URLs to their manifest URL — the engine's own resolver, so a set's
/// sources mean exactly what they'd mean to `strudio`.
fn resolve_source_url(url: &str) -> String {
    strudel_sounds::resolve_special_url(url).into_owned()
}

/// Readable, filesystem-safe fragment of a source URL for its cache dir name.
fn source_slug(url: &str) -> String {
    let trimmed = url
        .strip_prefix("github:")
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url)
        .trim_end_matches("/strudel.json")
        .trim_end_matches(".json");
    let mut slug: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    slug.truncate(48);
    if slug.is_empty() {
        "source".into()
    } else {
        slug
    }
}

/// A built-in downloadable set. Sources are in registration order — the
/// first manifest owning a bank name wins, so `bd` in `strudel` is
/// uzu-drumkit's rather than Dirt-Samples', exactly as in strudio.
struct BuiltinSet {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    sources: &'static [&'static str],
}

/// The downloadable sets every install offers. The two "defaults" sets
/// reproduce another player's startup palette in its precedence order; the
/// single-pack sets exist so a user who only wants the drum machines does
/// not have to fetch Dirt-Samples too. Sources are shared on disk, so
/// activating `strudel-cc` after `vcsl` only fetches what is missing.
const BUILTIN_SETS: &[BuiltinSet] = &[
    BuiltinSet {
        id: "strudel",
        label: "strudel-rs (strudio defaults)",
        description: "What `strudio play` registers: Salamander piano (CC-BY), uzu drumkit \
                      (Unlicense), uzu wavetables, then all of Dirt-Samples (no license). ~300 MB.",
        sources: &[
            default_sources::PIANO,
            default_sources::UZU_DRUMKIT,
            default_sources::UZU_WAVETABLES,
            default_sources::DIRT_SAMPLES,
        ],
    },
    BuiltinSet {
        id: "strudel-cc",
        label: "strudel.cc defaults",
        description: "What strudel.cc loads at startup, in its order: piano, VCSL, 71 drum \
                      machines, uzu drumkit + wavetables, mridangam, then Dirt-Samples. The largest set.",
        sources: &[
            default_sources::PIANO,
            default_sources::VCSL_SAMPLES,
            default_sources::TIDAL_DRUM_MACHINES,
            default_sources::UZU_DRUMKIT,
            default_sources::UZU_WAVETABLES,
            default_sources::MRIDANGAM,
            default_sources::DIRT_SAMPLES,
        ],
    },
    BuiltinSet {
        id: "drum-machines",
        label: "Drum machines",
        description: "71 classic boxes from tidal-drum-machines (no license file upstream): \
                      s(\"bd sd\").bank(\"RolandTR909\"), AkaiMPC60, LinnDrum, OberheimDMX, YamahaRX5…",
        sources: &[default_sources::TIDAL_DRUM_MACHINES],
    },
    BuiltinSet {
        id: "vcsl",
        label: "VCSL orchestral & world",
        description: "Versilian Community Sample Library (CC0): 128 real instruments — kalimba, \
                      marimba, vibraphone, harp, ocarina, recorders, gong, timpani, didgeridoo…",
        sources: &[default_sources::VCSL_SAMPLES],
    },
    BuiltinSet {
        id: "mridangam",
        label: "Mridangam",
        description: "South Indian mridangam strokes (ta, dhi, thom…) by Arthur Carabott and \
                      Harishankar V Menon, CC-BY-SA.",
        sources: &[default_sources::MRIDANGAM],
    },
];

fn builtin_definitions() -> Vec<SetDefinition> {
    BUILTIN_SETS
        .iter()
        .map(|b| SetDefinition {
            id: b.id.into(),
            label: b.label.into(),
            description: b.description.into(),
            sources: b.sources.iter().map(|s| (*s).to_string()).collect(),
        })
        .collect()
}

fn is_builtin(id: &str) -> bool {
    id == BUNDLED_SET_ID || BUILTIN_SETS.iter().any(|b| b.id == id)
}

/// All downloadable set definitions: [`BUILTIN_SETS`] plus any user-defined
/// sets from `{app_data}/sample-sets.json`. (The bundled `cycletron` set is
/// not in this list — it has no sources to download.)
pub fn definitions(app: &tauri::AppHandle) -> Vec<SetDefinition> {
    let mut defs = builtin_definitions();
    let Ok(data_dir) = app.path().app_data_dir() else {
        return defs;
    };
    let path = data_dir.join(REGISTRY_FILE);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return defs;
    };
    match serde_json::from_str::<Vec<SetDefinition>>(&raw) {
        Ok(user_defs) => {
            for def in user_defs {
                let id_ok = !def.id.is_empty()
                    && def
                        .id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
                if !id_ok || def.id == BUNDLED_SET_ID || defs.iter().any(|d| d.id == def.id) {
                    tracing::warn!(
                        target: "cycletron::sample_sets",
                        id = def.id,
                        "skipping sample-set definition (invalid or duplicate id; use lowercase a-z, 0-9, '-')"
                    );
                    continue;
                }
                if def.sources.is_empty() {
                    tracing::warn!(
                        target: "cycletron::sample_sets",
                        id = def.id,
                        "skipping sample-set definition with no sources"
                    );
                    continue;
                }
                defs.push(def);
            }
        }
        Err(e) => {
            tracing::warn!(
                target: "cycletron::sample_sets",
                path = %path.display(),
                error = %e,
                "could not parse sample-set registry"
            );
        }
    }
    defs
}

fn definition(app: &tauri::AppHandle, set_id: &str) -> Result<SetDefinition, String> {
    definitions(app)
        .into_iter()
        .find(|d| d.id == set_id)
        .ok_or_else(|| format!("unknown sample set '{set_id}'"))
}

fn sets_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve app cache dir: {e}"))?;
    let root = cache.join("sample-sets");
    migrate_per_set_layout(&root);
    Ok(root)
}

/// Sub-directory of the sets root holding one dir per downloaded source.
const SOURCES_DIR: &str = "sources";

/// Cache dir for one source, shared by every set that lists it.
fn source_dir(root: &Path, url: &str) -> PathBuf {
    root.join(SOURCES_DIR).join(source_slug(url))
}

/// Per-source cache dirs for a set, in precedence order.
fn source_dirs(app: &tauri::AppHandle, def: &SetDefinition) -> Result<Vec<PathBuf>, String> {
    let root = sets_root(app)?;
    Ok(def
        .sources
        .iter()
        .map(|url| source_dir(&root, url))
        .collect())
}

/// Forward-only migration from the original `<set-id>/<NN>-<slug>/` layout
/// (one copy per set) to `sources/<slug>/`. Renames are free; a slug that
/// already exists in the new layout wins and the old copy is deleted. Runs on
/// every root lookup but is a single `read_dir` once nothing is left to move.
fn migrate_per_set_layout(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let sources = root.join(SOURCES_DIR);
    for set_dir in entries.flatten().map(|e| e.path()) {
        if !set_dir.is_dir() || set_dir.file_name().is_some_and(|n| n == SOURCES_DIR) {
            continue;
        }
        let Ok(subdirs) = std::fs::read_dir(&set_dir) else {
            continue;
        };
        for old in subdirs.flatten().map(|e| e.path()) {
            let Some(name) = old.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // `<NN>-<slug>`: two digits, a dash, the slug.
            let Some(slug) = name.get(3..).filter(|_| {
                name.len() > 3
                    && name.as_bytes()[..2].iter().all(u8::is_ascii_digit)
                    && &name[2..3] == "-"
            }) else {
                continue;
            };
            let dest = sources.join(slug);
            let result = if dest.exists() {
                std::fs::remove_dir_all(&old)
            } else {
                std::fs::create_dir_all(&sources).and_then(|()| std::fs::rename(&old, &dest))
            };
            if let Err(e) = result {
                tracing::warn!(
                    target: "cycletron::sample_sets",
                    from = %old.display(),
                    to = %dest.display(),
                    error = %e,
                    "could not migrate sample-set source dir"
                );
            }
        }
        // Empty once every source moved; leave it alone otherwise.
        let _ = std::fs::remove_dir(&set_dir);
    }
}

/// The localized manifest paths for a set, in precedence order. Errors on an
/// unknown set id; the bundled set has no manifest paths here.
pub fn manifest_paths(app: &tauri::AppHandle, set_id: &str) -> Result<Vec<PathBuf>, String> {
    let def = definition(app, set_id)?;
    Ok(source_dirs(app, &def)?
        .into_iter()
        .map(|d| d.join(LOCAL_MANIFEST))
        .collect())
}

pub fn is_ready(app: &tauri::AppHandle, set_id: &str) -> bool {
    set_id == BUNDLED_SET_ID
        || manifest_paths(app, set_id).is_ok_and(|paths| paths.iter().all(|p| p.is_file()))
}

/// Every known set with its download state — the bundled set first, then the
/// downloadable definitions. Drives the Preferences "Sample set" list.
#[tauri::command]
pub fn list_sample_sets(app_handle: tauri::AppHandle) -> Result<Vec<SetStatus>, String> {
    let mut out = vec![SetStatus {
        id: BUNDLED_SET_ID.into(),
        label: "Cycletron (bundled)".into(),
        description: "The license-audited offline kit that ships with the app: Fischer 808 drums, \
                      three drum machines, VCSL percussion colors, Clean-Samples melodic slices."
            .into(),
        builtin: true,
        ready: true,
        files: 0,
        bytes: 0,
        sources: Vec::new(),
    }];
    for def in definitions(&app_handle) {
        let dirs = source_dirs(&app_handle, &def)?;
        let (mut files, mut bytes) = (0, 0);
        for dir in &dirs {
            let (f, b) = dir_stats(dir);
            files += f;
            bytes += b;
        }
        out.push(SetStatus {
            builtin: is_builtin(&def.id),
            ready: dirs.iter().all(|d| d.join(LOCAL_MANIFEST).is_file()),
            files,
            bytes,
            id: def.id,
            label: def.label,
            description: def.description,
            sources: def.sources,
        });
    }
    Ok(out)
}

/// The active set's localized manifests for the frontend's live sample
/// loader — `None` when the bundled set is active (frontend loads its
/// bundled banks as always).
#[tauri::command]
pub fn get_active_sample_set_manifests(
    app_handle: tauri::AppHandle,
) -> Result<Option<Vec<SourceManifest>>, String> {
    let active = app_handle
        .state::<crate::state::AppState>()
        .user_settings
        .lock()
        .samples
        .active
        .clone();
    if active == BUNDLED_SET_ID {
        return Ok(None);
    }
    let def = definition(&app_handle, &active)?;
    let dirs = source_dirs(&app_handle, &def)?;
    let mut out = Vec::with_capacity(dirs.len());
    for (dir, url) in dirs.iter().zip(&def.sources) {
        let raw = std::fs::read_to_string(dir.join(LOCAL_MANIFEST)).map_err(|_| {
            format!("sample set '{active}' is not downloaded — download it in the Samples manager")
        })?;
        let manifest =
            serde_json::from_str(&raw).map_err(|e| format!("corrupt manifest for '{url}': {e}"))?;
        out.push(SourceManifest {
            id: source_slug(url),
            dir: dir.to_string_lossy().into_owned(),
            manifest,
        });
    }
    Ok(Some(out))
}

/// Delete a downloaded set's cache (definition stays; it can be re-downloaded).
#[tauri::command]
pub fn remove_sample_set(set_id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    if set_id == BUNDLED_SET_ID {
        return Err("the bundled set cannot be removed".into());
    }
    // Sources are shared: only delete the ones no other set lists.
    let defs = definitions(&app_handle);
    let def = defs
        .iter()
        .find(|d| d.id == set_id)
        .ok_or_else(|| format!("unknown sample set '{set_id}'"))?;
    let root = sets_root(&app_handle)?;
    for url in &def.sources {
        let shared = defs
            .iter()
            .any(|other| other.id != set_id && other.sources.iter().any(|u| u == url));
        if shared {
            continue;
        }
        let dir = source_dir(&root, url);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("could not remove sample set: {e}"))?;
        }
    }
    refresh_bank_names(&app_handle);
    Ok(())
}

/// Download every source of a set. Resumable: files already on disk are
/// skipped, and a source with its localized manifest present is skipped
/// entirely. Emits `sample-set-progress` events (`{set, source, done, total}`).
#[tauri::command]
pub async fn download_sample_set(
    set_id: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<SetStatus>, String> {
    if set_id == BUNDLED_SET_ID {
        return Err("the bundled set is always available".into());
    }
    if DOWNLOAD_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("a sample-set download is already running".into());
    }
    let result = download_all(&app_handle, &set_id).await;
    DOWNLOAD_RUNNING.store(false, Ordering::SeqCst);
    result?;
    refresh_bank_names(&app_handle);
    list_sample_sets(app_handle)
}

/// The active set's banks split by how the engine treats `note()` on them.
/// The manifest shape decides: an object (note-name → file) bank is pitched —
/// the engine picks the nearest recorded note and repitches; an array/string
/// bank is indexed one-shots — `note()` rate-repitches from an assumed C3
/// root (`:n` selects variants), so quality degrades at extreme intervals.
#[derive(Debug, Clone, Default)]
pub struct ActiveSetBanks {
    pub pitched: Vec<String>,
    pub one_shots: Vec<String>,
    /// Drum-machine kits: one-shot banks named `{Machine}_{voice}` with a
    /// CamelCase machine prefix (`RolandTR909_bd`), the form `.bank()` targets.
    /// Grouped so the agent sees 71 machines with their voices instead of
    /// 683 flat bank names.
    pub machines: Vec<MachineBanks>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MachineBanks {
    pub machine: String,
    pub voices: Vec<String>,
}

impl ActiveSetBanks {
    pub fn is_empty(&self) -> bool {
        self.pitched.is_empty() && self.one_shots.is_empty() && self.machines.is_empty()
    }

    /// Classify bank names from manifests in precedence order (first owner
    /// wins). `is_pitched` is the manifest shape: an object bank is
    /// note-mapped, an array/string bank is indexed one-shots.
    fn classify<'a>(banks: impl IntoIterator<Item = (&'a str, bool)>) -> Self {
        let mut seen = std::collections::HashSet::new();
        let mut out = Self::default();
        let mut machines: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for (key, is_pitched) in banks {
            if key.starts_with('_') || !seen.insert(key.to_string()) {
                continue;
            }
            if is_pitched {
                out.pitched.push(key.to_string());
            } else if let Some((machine, voice)) = machine_voice(key) {
                machines
                    .entry(machine.to_string())
                    .or_default()
                    .push(voice.to_string());
            } else {
                out.one_shots.push(key.to_string());
            }
        }
        out.pitched.sort();
        out.one_shots.sort();
        out.machines = machines
            .into_iter()
            .map(|(machine, mut voices)| {
                voices.sort();
                MachineBanks { machine, voices }
            })
            .collect();
        out
    }
}

/// Split `RolandTR909_bd` into `("RolandTR909", "bd")`. Only a CamelCase
/// prefix counts as a machine — lowercase underscore names (`balafon_hard`,
/// `wt_digital`) are ordinary banks.
fn machine_voice(key: &str) -> Option<(&str, &str)> {
    let (machine, voice) = key.split_once('_')?;
    let camel = machine.starts_with(|c: char| c.is_ascii_uppercase())
        && machine.chars().all(|c| c.is_ascii_alphanumeric());
    (camel && !voice.is_empty() && voice.chars().all(|c| c.is_ascii_alphanumeric()))
        .then_some((machine, voice))
}

/// Classified bank names of the active set (empty for the bundled set or when
/// the active set isn't fully downloaded). Feeds the agent's catalog and the
/// Sounds panel. First-manifest-wins: a bank's shape comes from the source
/// that owns it.
pub fn active_set_banks(app: &tauri::AppHandle) -> ActiveSetBanks {
    let active = app
        .state::<crate::state::AppState>()
        .user_settings
        .lock()
        .samples
        .active
        .clone();
    if active == BUNDLED_SET_ID {
        return ActiveSetBanks::default();
    }
    let Ok(paths) = manifest_paths(app, &active) else {
        return ActiveSetBanks::default();
    };
    if !paths.iter().all(|p| p.is_file()) {
        return ActiveSetBanks::default();
    }
    let manifests: Vec<serde_json::Map<String, serde_json::Value>> = paths
        .iter()
        .filter_map(|path| {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|m| m.as_object().cloned())
        })
        .collect();
    ActiveSetBanks::classify(
        manifests
            .iter()
            .flat_map(|obj| obj.iter().map(|(k, v)| (k.as_str(), v.is_object()))),
    )
}

/// Refresh [`crate::state::AppState::active_set_banks`] from disk.
pub fn refresh_bank_names(app: &tauri::AppHandle) {
    let banks = active_set_banks(app);
    *app.state::<crate::state::AppState>()
        .active_set_banks
        .lock() = banks;
}

async fn download_all(app: &tauri::AppHandle, set_id: &str) -> Result<(), String> {
    let def = definition(app, set_id)?;
    let dirs = source_dirs(app, &def)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("cycletron/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    for (dir, source_url) in dirs.iter().zip(&def.sources) {
        if dir.join(LOCAL_MANIFEST).is_file() {
            continue; // already complete
        }
        download_source(app, &client, set_id, source_url, dir).await?;
    }
    Ok(())
}

async fn download_source(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    set_id: &str,
    source_url: &str,
    dir: &Path,
) -> Result<(), String> {
    let manifest_url = resolve_source_url(source_url);
    let raw = fetch_text(client, &manifest_url)
        .await
        .map_err(|e| format!("could not fetch manifest '{source_url}': {e}"))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("could not parse manifest '{source_url}': {e}"))?;
    let obj = manifest
        .as_object_mut()
        .ok_or_else(|| format!("manifest '{source_url}' is not a JSON object"))?;

    // Base for relative entries: `_base` when present, else the manifest
    // URL's directory (same derivation the engine's loader uses).
    let base = match obj.remove("_base").as_ref().and_then(|b| b.as_str()) {
        Some(b) => resolve_source_url(b),
        None => manifest_url[..=manifest_url.rfind('/').unwrap_or(0)].to_string(),
    };
    let base = base.trim_end_matches('/').to_string();

    let rel_paths = relative_sample_paths(&manifest);
    let total = rel_paths.len();
    let slug = source_slug(source_url);
    tracing::info!(
        target: "cycletron::sample_sets",
        set = set_id,
        source = slug,
        total,
        "downloading sample source"
    );

    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut tasks = tokio::task::JoinSet::new();
    for rel in rel_paths {
        let sem = sem.clone();
        let done = done.clone();
        let client = client.clone();
        let app = app.clone();
        let set_id = set_id.to_string();
        let slug = slug.clone();
        let url = format!("{base}/{}", encode_rel_url(rel.trim_start_matches('/')));
        let dest = dir.join(&rel);
        tasks.spawn(async move {
            let _permit = sem.acquire().await;
            let result = fetch_file(&client, &url, &dest).await;
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            if n.is_multiple_of(10) || n == total {
                let _ = app.emit(
                    "sample-set-progress",
                    DownloadProgress {
                        set: &set_id,
                        source: &slug,
                        done: n,
                        total,
                    },
                );
            }
            result.map_err(|e| format!("{url}: {e}"))
        });
    }

    let mut failures = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(e)) => failures.push(e),
            Err(e) => failures.push(format!("download task panicked: {e}")),
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "source '{source_url}': {} of {total} files failed (re-run the download to resume). First error: {}",
            failures.len(),
            failures[0]
        ));
    }

    // All files present — write the localized manifest last, atomically.
    // `_base` was already stripped above; relative paths now resolve against
    // this manifest's own directory.
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{LOCAL_MANIFEST}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join(LOCAL_MANIFEST))
        .map_err(|e| format!("finalize manifest '{source_url}': {e}"))?;
    Ok(())
}

/// All relative sample paths in a manifest (absolute `http(s)` entries are
/// left to stream at play time, exactly like the engine treats them; `..`
/// segments are rejected so a hostile manifest can't escape its directory).
fn relative_sample_paths(manifest: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    let Some(obj) = manifest.as_object() else {
        return out;
    };
    for (key, def) in obj {
        if key.starts_with('_') {
            continue;
        }
        match def {
            serde_json::Value::String(s) => push_rel(&mut out, s),
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(s) = item.as_str() {
                        push_rel(&mut out, s);
                    }
                }
            }
            serde_json::Value::Object(map) => {
                for note_path in map.values() {
                    if let Some(s) = note_path.as_str() {
                        push_rel(&mut out, s);
                    }
                }
            }
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Percent-encode a manifest-relative path for use in a URL, without
/// double-encoding. Manifests mix both conventions: tidal-drum-machines
/// pre-encodes (`Hat%20Open.wav`) while Dirt-Samples has literal `%` in
/// filenames (`002_0_da0-50%_1000_0_R.wav`) — so `%` is only escaped when it
/// does NOT start a valid two-hex-digit escape. Spaces/`#`/`?` are always
/// escaped (raw they'd be rejected or truncated by the server). The on-disk
/// path keeps the manifest's literal spelling, matching what the engine
/// resolves when it reads the localized manifest.
fn encode_rel_url(rel: &str) -> String {
    let bytes = rel.as_bytes();
    let mut out = String::with_capacity(rel.len());
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b' ' => out.push_str("%20"),
            b'#' => out.push_str("%23"),
            b'?' => out.push_str("%3F"),
            b'%' => {
                let valid_escape = bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                    && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit);
                out.push_str(if valid_escape { "%" } else { "%25" });
            }
            _ if b.is_ascii() => out.push(b as char),
            // Non-ASCII (UTF-8 continuation bytes included): hex-escape.
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn push_rel(out: &mut Vec<String>, path: &str) {
    if path.starts_with("http://") || path.starts_with("https://") {
        return;
    }
    if path.split('/').any(|seg| seg == "..") || path.starts_with('/') {
        tracing::warn!(target: "cycletron::sample_sets", path, "skipping unsafe manifest path");
        return;
    }
    out.push(path.to_string());
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}

/// Download one file with retries; skips work when `dest` already exists
/// (resume). Writes via a `.part` file + rename so a torn download never
/// masquerades as a finished sample.
async fn fetch_file(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
    if dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }

    let mut last_err = String::new();
    for attempt in 0..RETRIES {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * u64::from(attempt))).await;
        }
        match try_fetch_file(client, url, dest).await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

async fn try_fetch_file(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let part = dest.with_extension(match dest.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{ext}.part"),
        None => "part".to_string(),
    });
    tokio::fs::write(&part, &bytes)
        .await
        .map_err(|e| format!("write {}: {e}", part.display()))?;
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| format!("finalize {}: {e}", dest.display()))?;
    Ok(())
}

fn dir_stats(dir: &Path) -> (u64, u64) {
    fn walk(dir: &Path, files: &mut u64, bytes: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, files, bytes);
            } else if let Ok(meta) = entry.metadata() {
                *files += 1;
                *bytes += meta.len();
            }
        }
    }
    let (mut files, mut bytes) = (0, 0);
    walk(dir, &mut files, &mut bytes);
    (files, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_cover_all_manifest_shapes() {
        let manifest = serde_json::json!({
            "_base": "https://example.com/x/",
            "bd": ["bd/a.wav", "bd/b.wav"],
            "piano": {"C4": "piano/c4.mp3", "E4": "piano/e4.mp3"},
            "single": "one.wav",
            "streamed": ["https://example.com/remote.wav"],
            "evil": ["../../etc/passwd", "/abs/path.wav"],
        });
        let mut paths = relative_sample_paths(&manifest);
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "bd/a.wav",
                "bd/b.wav",
                "one.wav",
                "piano/c4.mp3",
                "piano/e4.mp3"
            ]
        );
    }

    #[test]
    fn rel_url_encoding_handles_both_percent_conventions() {
        // Literal % in a Dirt-Samples filename → escaped.
        assert_eq!(
            encode_rel_url("h/002_0_da0-50%_1000_0_R.wav"),
            "h/002_0_da0-50%25_1000_0_R.wav"
        );
        // Pre-encoded TDM path → left alone (no double-encoding).
        assert_eq!(
            encode_rel_url("RolandTR909/Hat%20Open.wav"),
            "RolandTR909/Hat%20Open.wav"
        );
        assert_eq!(encode_rel_url("bd/a b#c.wav"), "bd/a%20b%23c.wav");
        assert_eq!(encode_rel_url("bd/plain.wav"), "bd/plain.wav");
    }

    #[test]
    fn github_urls_resolve_like_the_engine() {
        assert_eq!(
            resolve_source_url("github:tidalcycles/uzu-drumkit"),
            "https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json"
        );
        assert_eq!(
            resolve_source_url("github:tidalcycles/Dirt-Samples/master"),
            "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json"
        );
        assert_eq!(
            resolve_source_url("https://example.com/x.json"),
            "https://example.com/x.json"
        );
    }

    fn builtin(id: &str) -> SetDefinition {
        builtin_definitions()
            .into_iter()
            .find(|d| d.id == id)
            .unwrap()
    }

    #[test]
    fn strudel_set_matches_strudio_registration_order() {
        assert_eq!(
            builtin("strudel").sources,
            vec![
                default_sources::PIANO,
                default_sources::UZU_DRUMKIT,
                default_sources::UZU_WAVETABLES,
                default_sources::DIRT_SAMPLES,
            ]
        );
    }

    #[test]
    fn strudel_cc_set_matches_the_website_prebake_order() {
        // website/src/repl/prebake.mjs: piano, VCSL, drum machines, uzu
        // drumkit, uzu wavetables, mridangam, then a Dirt subset. We list
        // all of Dirt last, which keeps every shared bank's owner identical.
        assert_eq!(
            builtin("strudel-cc").sources,
            vec![
                default_sources::PIANO,
                default_sources::VCSL_SAMPLES,
                default_sources::TIDAL_DRUM_MACHINES,
                default_sources::UZU_DRUMKIT,
                default_sources::UZU_WAVETABLES,
                default_sources::MRIDANGAM,
                default_sources::DIRT_SAMPLES,
            ]
        );
    }

    #[test]
    fn builtin_ids_are_unique_registry_safe_and_described() {
        let mut ids = std::collections::HashSet::new();
        for set in BUILTIN_SETS {
            assert!(ids.insert(set.id), "duplicate id {}", set.id);
            assert!(
                set.id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{} must be lowercase a-z, 0-9, '-'",
                set.id
            );
            assert!(
                !set.sources.is_empty() && !set.description.is_empty(),
                "{}",
                set.id
            );
        }
        assert!(is_builtin("strudel") && is_builtin(BUNDLED_SET_ID) && !is_builtin("my-breaks"));
    }

    #[test]
    fn single_pack_sets_reuse_the_defaults_sets_sources() {
        // Shared source dirs only pay off if the URLs are byte-identical.
        let cc = builtin("strudel-cc").sources;
        for id in ["drum-machines", "vcsl", "mridangam"] {
            for url in builtin(id).sources {
                assert!(cc.contains(&url), "{id} source {url} not in strudel-cc");
            }
        }
    }

    #[test]
    fn machine_banks_group_camelcase_prefixes_only() {
        let banks = ActiveSetBanks::classify([
            ("RolandTR909_bd", false),
            ("RolandTR909_sd", false),
            ("AkaiMPC60_hh", false),
            ("balafon_hard", false),
            ("wt_digital", false),
            ("bd", false),
            ("piano", true),
            ("_base", false),
            ("bd", false), // second manifest: first owner wins
        ]);
        assert_eq!(banks.pitched, vec!["piano"]);
        assert_eq!(banks.one_shots, vec!["balafon_hard", "bd", "wt_digital"]);
        let machines: Vec<(&str, Vec<&str>)> = banks
            .machines
            .iter()
            .map(|m| {
                (
                    m.machine.as_str(),
                    m.voices.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            machines,
            vec![("AkaiMPC60", vec!["hh"]), ("RolandTR909", vec!["bd", "sd"])]
        );
    }

    #[test]
    fn per_set_layout_migrates_to_shared_source_dirs() {
        let root = tempfile::tempdir().unwrap();
        let old = root
            .path()
            .join("strudel")
            .join("01-tidalcycles-uzu-drumkit");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(LOCAL_MANIFEST), "{}").unwrap();
        // A second set had its own copy of the same source: the first-moved
        // copy wins and the duplicate is deleted.
        let dup = root.path().join("mine").join("00-tidalcycles-uzu-drumkit");
        std::fs::create_dir_all(&dup).unwrap();

        migrate_per_set_layout(root.path());

        let shared = source_dir(root.path(), "github:tidalcycles/uzu-drumkit");
        assert!(shared.join(LOCAL_MANIFEST).is_file());
        assert!(!root.path().join("strudel").exists());
        assert!(!root.path().join("mine").exists());
        // Idempotent.
        migrate_per_set_layout(root.path());
        assert!(shared.join(LOCAL_MANIFEST).is_file());
    }

    #[test]
    fn source_slugs_are_readable_and_safe() {
        assert_eq!(
            source_slug("github:tidalcycles/uzu-drumkit"),
            "tidalcycles-uzu-drumkit"
        );
        assert_eq!(
            source_slug(
                "https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json"
            ),
            "raw-githubusercontent-com-felixroos-dough-sample"
        );
        assert!(!source_slug("///").is_empty());
    }
}
