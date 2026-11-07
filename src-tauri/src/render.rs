//! `cycletron render <show.toml>`: a show file to a music video, in this
//! binary. The render page (`viz-render.html`, the same one the seam test
//! drives) runs in small preview windows, one per job; each pulls chunks of
//! frames from here and posts every frame's pixels back over IPC, and this
//! side owns the song exports, the chunk schedule, one ffmpeg per chunk, and
//! the final concat and audio mux. The page parses the show, since the show
//! parser and the director are shared with live playback.
//!
//! The windows are visible on purpose: WebKit throttles a hidden page's whole
//! task queue within seconds, IPC included (measured 2026-11-06), so a hidden
//! render stalls. Small, on top, and a free preview.
//!
//! Protocol, as the page sees it (`ui/src/viz-render-driver.ts`):
//!   render_plan        → the show text and packs, to the first window that asks
//!   render_songs       → exports the songs, returns each one's sections
//!   render_cues        → the cues per song and the show's output settings; the schedule is built
//!   render_next        → the next chunk for this window, or null when none is left
//!   render_mix         → a song's mix, as WAV bytes
//!   render_frame       → one frame, raw RGBA, to the chunk's ffmpeg
//!   render_chunk_done  → the chunk's ffmpeg is closed and waited for
//!   render_failed      → the page hit an error; the render stops
//!   render_hidden      → the page is hidden or visible again (a notice; the render pauses meanwhile)
//!
//! In a debug build the page comes from vite, which reloads it once after its
//! first load (dependency optimization); a window that reloads mid-chunk gets
//! its chunk requeued, and an error from a page that is then reloaded is
//! dropped. Release builds serve the embedded frontend and never reload.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

const USAGE: &str = "usage: cycletron render <show.toml> [--out video.mp4] [--song n] [--section label] [--from s] [--to s] [--size WxH] [--fps n] [--jobs n] [--fresh]";
/// Rendering saturates the CPU at about eight jobs on a 14-core machine; more only contend.
const MAX_DEFAULT_JOBS: usize = 8;
/// Seconds without a word from any window before giving up.
const FIRST_CALL_TIMEOUT_SECS: u64 = 30;
const PREVIEW_WIDTH: f64 = 480.0;
const PREVIEW_HEIGHT: f64 = 270.0;

pub struct Flags {
    pub show: PathBuf,
    pub out: Option<PathBuf>,
    pub song: Option<usize>,
    pub section: Option<String>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub size: Option<(u32, u32)>,
    pub fps: Option<u32>,
    pub jobs: usize,
    pub fresh: bool,
}

pub fn parse(args: &[String]) -> Result<Flags, String> {
    let mut flags = Flags {
        show: PathBuf::new(),
        out: None,
        song: None,
        section: None,
        from: None,
        to: None,
        size: None,
        fps: None,
        jobs: std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(2))
            .unwrap_or(1)
            .clamp(1, MAX_DEFAULT_JOBS),
        fresh: false,
    };
    let mut positional = Vec::new();
    let mut it = args.iter();
    fn value<'a>(it: &mut std::slice::Iter<'a, String>, flag: &str) -> Result<&'a String, String> {
        it.next().ok_or_else(|| format!("{flag} needs a value"))
    }
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--out" => flags.out = Some(PathBuf::from(value(&mut it, "--out")?)),
            "--song" => {
                flags.song = Some(
                    value(&mut it, "--song")?
                        .parse()
                        .ok()
                        .filter(|n: &usize| *n >= 1)
                        .ok_or("--song counts from 1")?,
                );
            }
            "--section" => flags.section = Some(value(&mut it, "--section")?.clone()),
            "--from" => flags.from = Some(seconds(value(&mut it, "--from")?, "--from")?),
            "--to" => flags.to = Some(seconds(value(&mut it, "--to")?, "--to")?),
            "--size" => {
                let v = value(&mut it, "--size")?;
                let (w, h) = v
                    .split_once('x')
                    .ok_or("--size takes WIDTHxHEIGHT, e.g. 1920x1080")?;
                let size = (w.parse().ok(), h.parse().ok());
                flags.size = match size {
                    (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
                    _ => return Err("--size takes WIDTHxHEIGHT, e.g. 1920x1080".into()),
                };
            }
            "--fps" => {
                flags.fps = Some(
                    value(&mut it, "--fps")?
                        .parse()
                        .ok()
                        .filter(|n: &u32| *n > 0)
                        .ok_or("--fps needs a positive whole number")?,
                );
            }
            "--jobs" => {
                flags.jobs = value(&mut it, "--jobs")?
                    .parse()
                    .ok()
                    .filter(|n: &usize| *n > 0)
                    .ok_or("--jobs needs a positive whole number")?;
            }
            "--fresh" => flags.fresh = true,
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}\n{USAGE}")),
            _ => positional.push(arg),
        }
    }
    let [show] = positional.as_slice() else {
        return Err(USAGE.into());
    };
    flags.show = std::path::absolute(show).map_err(|e| e.to_string())?;
    Ok(flags)
}

fn seconds(v: &str, flag: &str) -> Result<f64, String> {
    v.parse()
        .ok()
        .filter(|s: &f64| *s >= 0.0)
        .ok_or_else(|| format!("{flag} needs seconds"))
}

/// Runs the render app; returns the exit code.
pub fn run(flags: Flags, context: tauri::Context<tauri::Wry>) -> u8 {
    match prepare(&flags, &context) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("cycletron render: {e}");
            return 1;
        }
    }
    // A render pauses when its windows go off screen, so keep the display awake for its run.
    #[cfg(target_os = "macos")]
    let _ = Command::new("caffeinate")
        .args(["-dimsu", "-w", &std::process::id().to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let jobs = flags.jobs;
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            render_plan,
            render_songs,
            render_cues,
            render_next,
            render_mix,
            render_frame,
            render_chunk_done,
            render_failed,
            render_hidden,
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                let render = webview.state::<Render>();
                *render.epochs.lock().unwrap().entry(webview.label().to_string()).or_insert(0) += 1;
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let render = Render::new(flags, app.handle())?;
            let url = page_url(app.handle())?;
            app.manage(render);
            // Tiled from the top left, three a row.
            for k in 0..jobs {
                WebviewWindowBuilder::new(app, format!("render-{k}"), WebviewUrl::External(url.clone()))
                    .title(format!("Cycletron render {}", k + 1))
                    .inner_size(PREVIEW_WIDTH, PREVIEW_HEIGHT)
                    .position(
                        40.0 + (PREVIEW_WIDTH + 20.0) * (k % 3) as f64,
                        40.0 + (PREVIEW_HEIGHT + 40.0) * (k / 3) as f64,
                    )
                    .always_on_top(true)
                    .focused(false)
                    .resizable(false)
                    .build()?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(FIRST_CALL_TIMEOUT_SECS));
                let render = handle.state::<Render>();
                if render.first_call.lock().unwrap().is_none() {
                    eprintln!("cycletron render: the render page did not start in {FIRST_CALL_TIMEOUT_SECS}s{}", dev_hint());
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("cycletron render: {e}");
            return 1;
        }
    };
    app.run_return(|_, _| {}).clamp(0, 255) as u8
}

fn dev_hint() -> &'static str {
    if cfg!(debug_assertions) {
        " (a debug build loads the page from vite: run `npm run dev` in ui/ first)"
    } else {
        ""
    }
}

/// Everything that can fail before a window exists.
fn prepare(flags: &Flags, context: &tauri::Context<tauri::Wry>) -> Result<(), String> {
    if !flags.show.is_file() {
        return Err(format!("{}: not a file", flags.show.display()));
    }
    if Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_err()
    {
        return Err("ffmpeg is not on the PATH; the render encodes with it".into());
    }
    #[cfg(debug_assertions)]
    {
        let dev = context
            .config()
            .build
            .dev_url
            .as_ref()
            .ok_or("devUrl must be set for debug builds")?;
        let host = dev.host_str().unwrap_or("localhost");
        let port = dev.port_or_known_default().unwrap_or(80);
        if std::net::TcpStream::connect_timeout(
            &std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
                .ok()
                .and_then(|mut a| a.next())
                .ok_or("devUrl does not resolve")?,
            std::time::Duration::from_secs(2),
        )
        .is_err()
        {
            return Err(format!("nothing is serving {dev}{}", dev_hint()));
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = context;
    Ok(())
}

/// The render page: from vite in a debug build, the embedded frontend in a release.
fn page_url(app: &AppHandle) -> Result<tauri::Url, String> {
    #[cfg(debug_assertions)]
    {
        let dev = app
            .config()
            .build
            .dev_url
            .clone()
            .ok_or("devUrl must be set for debug builds")?;
        dev.join("viz-render.html").map_err(|e| e.to_string())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        let port = tauri::async_runtime::block_on(
            crate::production_frontend::start_local_frontend_server(),
        );
        tauri::Url::parse(&format!("http://127.0.0.1:{port}/viz-render.html"))
            .map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct PackSource {
    id: String,
    source: String,
}

struct Render {
    flags: Flags,
    show_text: String,
    show_dir: PathBuf,
    home: PathBuf,
    cache: PathBuf,
    /// The bundled sample manifest, for exports.
    manifest: PathBuf,
    packs: Vec<PackSource>,
    plan: Mutex<Plan>,
    /// Flips to true once the schedule exists; `render_next` waits on it.
    ready: tokio::sync::watch::Sender<bool>,
    songs: Mutex<Vec<SongPlan>>,
    workers: Mutex<HashMap<String, Worker>>,
    /// Page loads per window, to tell a reload from a failure.
    epochs: Mutex<HashMap<String, u64>>,
    first_call: Mutex<Option<Instant>>,
    started: Instant,
    frames_done: AtomicU64,
    finished: Mutex<bool>,
}

enum Plan {
    Unclaimed,
    /// The window parsing the show.
    Claimed(String),
    Ready(Schedule),
}

struct Schedule {
    width: u32,
    height: u32,
    fps: u32,
    out: PathBuf,
    parts: PathBuf,
    chunks: Vec<Chunk>,
    done: usize,
    /// Timeline frames rendered, for the audio trim.
    first: u64,
    last: u64,
    label: String,
}

struct Chunk {
    song: usize,
    /// Song frame the chunk starts on, and how many it has.
    start: u64,
    count: u64,
    part: PathBuf,
    state: ChunkState,
}

#[derive(PartialEq)]
enum ChunkState {
    Pending,
    Running,
    Done,
}

/// A song on the timeline: its export and what the show says about it.
struct SongPlan {
    index: usize,
    source: PathBuf,
    dir: PathBuf,
    performance: PerformanceFile,
    passes: usize,
    cues: serde_json::Value,
    fade: serde_json::Value,
    gain_db: f64,
    sensitivity: f64,
    /// Timeline frame the song starts on, and its frame count.
    start: u64,
    frames: u64,
}

#[derive(Deserialize)]
struct PerformanceFile {
    code: String,
    bpm: f64,
    cycle_ns: u64,
    duration_ns: u64,
    audio: String,
    sections: Vec<PerformanceSection>,
}

#[derive(Deserialize)]
struct PerformanceSection {
    label: String,
    start_ns: u64,
    end_ns: u64,
}

#[derive(Default)]
struct Worker {
    chunk: Option<usize>,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    packs_sent: bool,
}

impl Render {
    fn new(flags: Flags, app: &AppHandle) -> Result<Self, String> {
        let show_text = std::fs::read_to_string(&flags.show)
            .map_err(|e| format!("read {}: {e}", flags.show.display()))?;
        let show_dir = flags
            .show
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        let cache = app
            .path()
            .cache_dir()
            .map(|d| d.join("cycletron").join("performance"))
            .unwrap_or_else(|_| home.join(".cache").join("cycletron").join("performance"));
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let library = crate::library::LibrarySettings::load_or_default(&data_dir).root;
        let packs = packs_for(&flags.show, &library)?;
        let manifest = crate::cli::bundled_manifest(app.package_info())?;
        let (ready, _) = tokio::sync::watch::channel(false);
        Ok(Self {
            flags,
            show_text,
            show_dir,
            home,
            cache,
            manifest,
            packs,
            plan: Mutex::new(Plan::Unclaimed),
            ready,
            songs: Mutex::new(Vec::new()),
            workers: Mutex::new(HashMap::new()),
            epochs: Mutex::new(HashMap::new()),
            first_call: Mutex::new(None),
            started: Instant::now(),
            frames_done: AtomicU64::new(0),
            finished: Mutex::new(false),
        })
    }

    fn touch(&self) {
        self.first_call
            .lock()
            .unwrap()
            .get_or_insert_with(Instant::now);
    }

    fn worker_packs(&self, label: &str) -> Vec<PackSource> {
        let mut workers = self.workers.lock().unwrap();
        let worker = workers.entry(label.to_string()).or_default();
        if worker.packs_sent {
            Vec::new()
        } else {
            worker.packs_sent = true;
            self.packs.clone()
        }
    }
}

/// The packs a show renders with: the ones of the nearest `pack.json` above
/// the show file, then the library's enabled packs, each built viz folder
/// once by id. The app loads the library's packs the same way.
fn packs_for(show: &Path, library: &Path) -> Result<Vec<PackSource>, String> {
    let mut out: Vec<PackSource> = Vec::new();
    let mut add = |dir: &Path, m: &crate::packs::PackManifest| -> Result<(), String> {
        for v in crate::packs::viz_entries(dir, m) {
            if out.iter().any(|p| p.id == v.id) {
                continue;
            }
            if !v.built {
                return Err(format!("{}: not built (no dist/index.js)", v.dir));
            }
            let built = Path::new(&v.dir).join("dist").join("index.js");
            let source =
                std::fs::read_to_string(&built).map_err(|e| format!("{}: {e}", built.display()))?;
            out.push(PackSource { id: v.id, source });
        }
        Ok(())
    };
    let mut dir = show.parent();
    while let Some(d) = dir {
        if d.join("pack.json").is_file() {
            let m = crate::packs::parse_manifest(d)?;
            add(d, &m)?;
            break;
        }
        dir = d.parent();
    }
    let root = crate::packs::packs_root(library);
    let enabled = crate::packs::read_enabled(&root).enabled;
    for (dir, m) in crate::packs::scan_installed(&root) {
        if enabled.iter().any(|e| e == &m.id) {
            add(&dir, &m)?;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct PlanRequest {
    show: String,
    dir: String,
    home: String,
    packs: Vec<PackSource>,
}

/// The show, to the first window that asks (or the same one again after a reload).
#[tauri::command]
fn render_plan(window: tauri::Window, render: State<'_, Render>) -> Option<PlanRequest> {
    render.touch();
    let label = window.label().to_string();
    {
        let mut plan = render.plan.lock().unwrap();
        match &*plan {
            Plan::Unclaimed => *plan = Plan::Claimed(label.clone()),
            Plan::Claimed(by) if *by == label => {}
            _ => return None,
        }
    }
    Some(PlanRequest {
        show: render.show_text.clone(),
        dir: render.show_dir.to_string_lossy().into_owned(),
        home: render.home.to_string_lossy().into_owned(),
        packs: render.worker_packs(&label),
    })
}

#[derive(Deserialize)]
struct SongSpec {
    index: usize,
    source: String,
    passes: usize,
    performance: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SongForm {
    index: usize,
    sections: Vec<FormSection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormSection {
    label: String,
    start_cycle: u64,
    cycles: u64,
}

/// Export every song (in parallel, from the cache when current) and return their sections.
#[tauri::command]
async fn render_songs(
    songs: Vec<SongSpec>,
    render: State<'_, Render>,
) -> Result<Vec<SongForm>, String> {
    render.touch();
    let cache = render.cache.clone();
    let manifest = render.manifest.clone();
    let fresh = render.flags.fresh;
    let plans = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SongPlan>, String> {
        std::thread::scope(|scope| {
            let handles: Vec<_> = songs
                .iter()
                .map(|song| {
                    let cache = &cache;
                    let manifest = &manifest;
                    scope.spawn(move || -> Result<SongPlan, String> {
                        let source = PathBuf::from(&song.source);
                        let dir = match &song.performance {
                            Some(dir) => PathBuf::from(dir),
                            None => exported(&source, song.passes, cache, fresh, manifest)?,
                        };
                        let json = dir.join("performance.json");
                        let performance: PerformanceFile = serde_json::from_str(
                            &std::fs::read_to_string(&json)
                                .map_err(|e| format!("read {}: {e}", json.display()))?,
                        )
                        .map_err(|e| format!("{}: {e}", json.display()))?;
                        Ok(SongPlan {
                            index: song.index,
                            source,
                            dir,
                            performance,
                            passes: song.passes,
                            cues: serde_json::Value::Null,
                            fade: serde_json::Value::Null,
                            gain_db: 0.0,
                            sensitivity: 1.0,
                            start: 0,
                            frames: 0,
                        })
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().map_err(|_| "export thread panicked".to_string())?)
                .collect()
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let forms = plans
        .iter()
        .map(|p| SongForm {
            index: p.index,
            sections: p
                .performance
                .sections
                .iter()
                .map(|s| FormSection {
                    label: s.label.clone(),
                    start_cycle: (s.start_ns as f64 / p.performance.cycle_ns as f64).round() as u64,
                    cycles: ((s.end_ns - s.start_ns) as f64 / p.performance.cycle_ns as f64).round()
                        as u64,
                })
                .collect(),
        })
        .collect();
    *render.songs.lock().unwrap() = plans;
    Ok(forms)
}

/// The song's export from the cache, made first when its file changed (or `--fresh`).
fn exported(
    source: &Path,
    passes: usize,
    cache: &Path,
    fresh: bool,
    manifest: &Path,
) -> Result<PathBuf, String> {
    use sha2::Digest as _;
    let text = std::fs::read_to_string(source)
        .map_err(|e| format!("can't read {}: {e}", source.display()))?;
    let mut hasher = sha2::Sha256::new();
    hasher.update(text.as_bytes());
    hasher.update(format!("passes={passes}").as_bytes());
    let key = hex(&hasher.finalize()[..8]);
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let dir = cache.join(format!("{stem}-{key}"));
    if dir.join("performance.json").is_file() && !fresh {
        return Ok(dir);
    }
    eprintln!(
        "exporting {}…",
        source.file_name().unwrap_or_default().to_string_lossy()
    );
    let samples = cycletron_render::SampleSetPaths::Cycletron {
        manifest: manifest.to_path_buf(),
    };
    let opts = cycletron_render::performance::Options {
        passes,
        seconds: None,
    };
    cycletron_render::performance::export(source, &dir, &opts, &samples)?;
    Ok(dir)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CuesPayload {
    songs: Vec<SongCues>,
    out: Option<String>,
    fps: Option<u32>,
    size: Option<Size>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongCues {
    index: usize,
    cues: serde_json::Value,
    fade: serde_json::Value,
    gain_db: f64,
    sensitivity: f64,
}

#[derive(Deserialize)]
struct Size {
    width: u32,
    height: u32,
}

/// The show's cues and output settings: the schedule is built and the windows start.
#[tauri::command]
fn render_cues(payload: CuesPayload, render: State<'_, Render>) -> Result<(), String> {
    render.touch();
    let flags = &render.flags;
    let out = match &flags.out {
        Some(out) => std::path::absolute(out).map_err(|e| e.to_string())?,
        None => PathBuf::from(
            payload
                .out
                .ok_or("no output: give the show an `out` in [show], or pass --out")?,
        ),
    };
    let fps = flags.fps.or(payload.fps).unwrap_or(60);
    let (width, height) = flags
        .size
        .or(payload.size.map(|s| (s.width, s.height)))
        .unwrap_or((1920, 1080));

    let mut songs = render.songs.lock().unwrap();
    for sc in payload.songs {
        let song = songs
            .iter_mut()
            .find(|s| s.index == sc.index)
            .ok_or_else(|| format!("cues for an unknown song {}", sc.index))?;
        song.cues = sc.cues;
        song.fade = sc.fade;
        song.gain_db = sc.gain_db;
        song.sensitivity = sc.sensitivity;
    }
    if let Some(n) = flags.song {
        if n > songs.len() {
            return Err(format!("--song: 1 to {}, not {n}", songs.len()));
        }
        let keep = songs[n - 1].index;
        songs.retain(|s| s.index == keep);
    }
    // Each song on the timeline.
    let mut frame = 0u64;
    for song in songs.iter_mut() {
        song.start = frame;
        song.frames = ((song.performance.duration_ns as f64 / 1e9) * fps as f64).round() as u64;
        frame += song.frames;
    }

    // What's rendered, in timeline frames.
    let mut first = 0u64;
    let mut last = frame;
    if let Some(section) = &flags.section {
        let found = songs.iter().find_map(|s| {
            s.cues
                .as_array()?
                .iter()
                .find(|c| c["label"] == *section)
                .map(|c| (s, c))
        });
        let Some((s, c)) = found else {
            return Err(format!("--section: no song here has a section '{section}'"));
        };
        let cycle = s.performance.cycle_ns as f64 / 1e9;
        let start_cycle = c["startCycle"].as_f64().unwrap_or(0.0);
        let cycles = c["cycles"].as_f64().unwrap_or(0.0);
        first = s.start + (start_cycle * cycle * fps as f64).round() as u64;
        last = s.start + ((start_cycle + cycles) * cycle * fps as f64).round() as u64;
    }
    let span = last - first;
    if let Some(to) = flags.to {
        last = last.min(first + (to * fps as f64).round() as u64);
    }
    if let Some(from) = flags.from {
        first += (from * fps as f64).round() as u64;
    }
    if last <= first {
        return Err(format!(
            "nothing to render: --from/--to leave no frames of the {:.1}s",
            span as f64 / fps as f64
        ));
    }
    let frames = last - first;

    // Chunks of at least a second (each pays a setup), never across a song.
    let size = (frames.div_ceil(flags.jobs as u64)).max(fps as u64);
    let parts = out
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
        .join(format!(".render-{}", std::process::id()));
    std::fs::create_dir_all(&parts).map_err(|e| format!("create {}: {e}", parts.display()))?;
    let mut chunks = Vec::new();
    for (i, song) in songs.iter().enumerate() {
        let from = first.max(song.start) - song.start;
        let to = last.min(song.start + song.frames) - song.start;
        let mut at = from;
        while at < to {
            let count = size.min(to - at);
            chunks.push(Chunk {
                song: i,
                start: at,
                count,
                part: parts.join(format!("{:03}.mp4", chunks.len())),
                state: ChunkState::Pending,
            });
            at += count;
        }
    }
    let playing: Vec<usize> = {
        let mut v: Vec<usize> = chunks.iter().map(|c| c.song).collect();
        v.dedup();
        v
    };
    let label = if playing.len() == 1 {
        songs[playing[0]]
            .source
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    } else {
        format!("{} songs", playing.len())
    };
    eprintln!(
        "{label}: {frames} frames at {width}x{height} {fps} fps, {} chunks on {} jobs",
        chunks.len(),
        flags.jobs
    );
    *render.plan.lock().unwrap() = Plan::Ready(Schedule {
        width,
        height,
        fps,
        out,
        parts,
        chunks,
        done: 0,
        first,
        last,
        label,
    });
    // send_replace, not send: with one job no window is waiting yet, and send
    // is refused when nobody subscribes.
    render.ready.send_replace(true);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    code: String,
    bpm: f64,
    cues: serde_json::Value,
    song: JobSong,
    width: u32,
    height: u32,
    fps: u32,
    start_frame: u64,
    count: u64,
    sensitivity: f64,
    packs: Vec<PackSource>,
    /// Which song's mix to fetch.
    mix: usize,
}

#[derive(Serialize)]
struct JobSong {
    passes: usize,
    fade: serde_json::Value,
}

/// The next chunk for this window, once the schedule exists; null when none is left.
#[tauri::command]
async fn render_next(
    window: tauri::Window,
    render: State<'_, Render>,
) -> Result<Option<Job>, String> {
    render.touch();
    let mut ready = render.ready.subscribe();
    ready.wait_for(|r| *r).await.map_err(|e| e.to_string())?;
    let label = window.label().to_string();
    let packs = render.worker_packs(&label);
    let mut plan = render.plan.lock().unwrap();
    let Plan::Ready(schedule) = &mut *plan else {
        return Err("no schedule".into());
    };
    let mut workers = render.workers.lock().unwrap();
    let worker = workers.entry(label.clone()).or_default();
    // A chunk still in flight means the page reloaded under it: start it over.
    if let Some(k) = worker.chunk.take() {
        if let Some(mut child) = worker.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        worker.stdin = None;
        let chunk = &mut schedule.chunks[k];
        let _ = std::fs::remove_file(&chunk.part);
        chunk.state = ChunkState::Pending;
        eprintln!("\n{label}: reloaded; chunk {k} starts over");
    }
    let Some(k) = schedule
        .chunks
        .iter()
        .position(|c| c.state == ChunkState::Pending)
    else {
        return Ok(None);
    };
    let chunk = &mut schedule.chunks[k];
    chunk.state = ChunkState::Running;
    let mut child = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgba"])
        .args(["-s", &format!("{}x{}", schedule.width, schedule.height)])
        .args(["-r", &schedule.fps.to_string(), "-i", "-"])
        // veryfast, not medium: a quarter less render time with every core busy, for a
        // slightly lower-quality encode at crf 16, fine for video that is re-encoded on upload.
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
        ])
        .arg(&chunk.part)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    worker.stdin = child.stdin.take().map(|s| Arc::new(Mutex::new(s)));
    worker.child = Some(child);
    worker.chunk = Some(k);
    let songs = render.songs.lock().unwrap();
    let song = &songs[chunk.song];
    Ok(Some(Job {
        code: song.performance.code.clone(),
        bpm: song.performance.bpm,
        cues: song.cues.clone(),
        song: JobSong {
            passes: song.passes,
            fade: song.fade.clone(),
        },
        width: schedule.width,
        height: schedule.height,
        fps: schedule.fps,
        start_frame: chunk.start,
        count: chunk.count,
        sensitivity: song.sensitivity,
        packs,
        mix: chunk.song,
    }))
}

/// A song's mix, as WAV bytes.
#[tauri::command]
fn render_mix(index: usize, render: State<'_, Render>) -> Result<tauri::ipc::Response, String> {
    let songs = render.songs.lock().unwrap();
    let song = songs.get(index).ok_or("no such song")?;
    let path = song.dir.join(&song.performance.audio);
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// One frame, raw RGBA, to this window's chunk encoder.
#[tauri::command]
async fn render_frame(
    window: tauri::Window,
    request: tauri::ipc::Request<'_>,
    render: State<'_, Render>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("render_frame expects a raw RGBA body".into());
    };
    let bytes = bytes.clone();
    let stdin = {
        let workers = render.workers.lock().unwrap();
        workers
            .get(window.label())
            .and_then(|w| w.stdin.clone())
            .ok_or("no chunk is open for this window")?
    };
    tauri::async_runtime::spawn_blocking(move || {
        stdin
            .lock()
            .unwrap()
            .write_all(&bytes)
            .map_err(|e| format!("ffmpeg stdin: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    let done = render.frames_done.fetch_add(1, Ordering::Relaxed) + 1;
    let plan = render.plan.lock().unwrap();
    if let Plan::Ready(s) = &*plan
        && done.is_multiple_of(s.fps as u64)
    {
        let frames = s.last - s.first;
        eprint!(
            "\r{}: {}/{}s",
            s.label,
            done / s.fps as u64,
            (frames as f64 / s.fps as f64).round()
        );
    }
    Ok(())
}

/// The window's chunk is complete: close its encoder, and finish the video when it was the last.
#[tauri::command]
async fn render_chunk_done(
    window: tauri::Window,
    app: AppHandle,
    render: State<'_, Render>,
) -> Result<(), String> {
    let (child, k) = {
        let mut workers = render.workers.lock().unwrap();
        let worker = workers.get_mut(window.label()).ok_or("unknown window")?;
        worker.stdin = None;
        (worker.child.take(), worker.chunk.take())
    };
    let Some(mut child) = child else {
        return Err("no chunk is open for this window".into());
    };
    let status = tauri::async_runtime::spawn_blocking(move || child.wait())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if !status.success() {
        fail(&app, &format!("ffmpeg exited {status}"));
        return Ok(());
    }
    let all_done = {
        let mut plan = render.plan.lock().unwrap();
        let Plan::Ready(s) = &mut *plan else {
            return Err("no schedule".into());
        };
        if let Some(k) = k {
            s.chunks[k].state = ChunkState::Done;
            s.done += 1;
        }
        s.done == s.chunks.len()
    };
    if all_done {
        let mut finished = render.finished.lock().unwrap();
        if !*finished {
            *finished = true;
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let render = app.state::<Render>();
                match finish(&render) {
                    Ok(()) => app.exit(0),
                    Err(e) => fail(&app, &e),
                }
            });
        }
    }
    Ok(())
}

/// Concat the parts and lay each song's mix under its frames.
fn finish(render: &Render) -> Result<(), String> {
    let plan = render.plan.lock().unwrap();
    let Plan::Ready(s) = &*plan else {
        return Err("no schedule".into());
    };
    let songs = render.songs.lock().unwrap();
    let list = s.parts.join("parts.txt");
    let lines: String = s
        .chunks
        .iter()
        .map(|c| format!("file '{}'\n", c.part.display()))
        .collect();
    std::fs::write(&list, lines).map_err(|e| format!("write {}: {e}", list.display()))?;
    let mut playing: Vec<usize> = s.chunks.iter().map(|c| c.song).collect();
    playing.dedup();
    let fps = s.fps as f64;
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
    ])
    .arg(&list);
    let mut filters = Vec::new();
    for (i, &si) in playing.iter().enumerate() {
        let song = &songs[si];
        cmd.arg("-i").arg(song.dir.join(&song.performance.audio));
        let from = (s.first.max(song.start) - song.start) as f64 / fps;
        let to = (s.last.min(song.start + song.frames) - song.start) as f64 / fps;
        filters.push(format!(
            "[{}:a]atrim=start={from}:end={to},asetpts=PTS-STARTPTS,volume={}dB,aformat=sample_rates=48000:channel_layouts=stereo[a{i}]",
            i + 1,
            song.gain_db
        ));
    }
    let inputs: String = (0..playing.len()).map(|i| format!("[a{i}]")).collect();
    let filter = format!(
        "{};{inputs}concat=n={}:v=0:a=1[a]",
        filters.join(";"),
        playing.len()
    );
    if let Some(dir) = s.out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let status = cmd
        .args([
            "-filter_complex",
            &filter,
            "-map",
            "0:v",
            "-map",
            "[a]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
        ])
        .arg(&s.out)
        .status()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg (mux) exited {status}"));
    }
    let _ = std::fs::remove_dir_all(&s.parts);
    eprintln!(
        "\n{}: {} frames → {} in {:.1}s ({} jobs)",
        s.label,
        s.last - s.first,
        s.out.display(),
        render.started.elapsed().as_secs_f64(),
        render.flags.jobs
    );
    Ok(())
}

fn fail(app: &AppHandle, message: &str) {
    eprintln!("\ncycletron render: {message}");
    let render = app.state::<Render>();
    if let Plan::Ready(s) = &*render.plan.lock().unwrap() {
        let _ = std::fs::remove_dir_all(&s.parts);
    }
    app.exit(1);
}

/// The page hit an error. A page that reloads right after (vite, in a debug build) is let go.
#[tauri::command]
async fn render_failed(
    window: tauri::Window,
    app: AppHandle,
    message: String,
    render: State<'_, Render>,
) -> Result<(), String> {
    render.touch();
    let label = window.label().to_string();
    let epoch = render
        .epochs
        .lock()
        .unwrap()
        .get(&label)
        .copied()
        .unwrap_or(0);
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let now = render
        .epochs
        .lock()
        .unwrap()
        .get(&label)
        .copied()
        .unwrap_or(0);
    if now == epoch {
        fail(&app, &message);
    }
    Ok(())
}

/// The preview window went off screen (or came back): the render pauses with it.
#[tauri::command]
fn render_hidden(window: tauri::Window, hidden: bool) {
    if hidden {
        eprintln!(
            "\n{}: hidden; the render pauses until its preview windows are on screen",
            window.label()
        );
    } else {
        eprintln!("\n{}: visible again", window.label());
    }
}
