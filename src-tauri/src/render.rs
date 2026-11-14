//! `cycletron render <show.toml>`: a show file to a music video, in this
//! binary. The render page (`viz-render.html`, the same one the seam test
//! drives) runs in small preview windows, one per job; each pulls chunks of
//! frames from here and posts every frame's pixels back over IPC, and this
//! side owns the song exports, the chunk schedule, one ffmpeg per chunk, and
//! the final concat and audio mux. The page parses the show, since the show
//! parser and the director are shared with live playback.
//!
//! On macOS 14+ the windows are hidden unless `--preview` asks to watch: macOS
//! otherwise throttles a hidden page's whole task queue within seconds
//! (measured 2026-11-06), and the windows opt out with Tauri's
//! `background_throttling`. Elsewhere they are small, on top, and must stay on
//! screen (see `hidden_pages_run` for why Linux is not hidden).
//!
//! `--progress json` prints one JSON event per line on stdout instead of the
//! human progress on stderr; the app's Render Video drives the render that way.
//! SIGINT and SIGTERM stop the encoders and remove the parts before exiting.
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
//!   render_hidden      → the page is hidden or visible again (a notice, for visible windows; the render pauses meanwhile)
//!
//! In a debug build the page comes from vite, which reloads it once after its
//! first load (dependency optimization); a window that reloads mid-chunk gets
//! its chunk requeued, and an error from a page that is then reloaded is
//! dropped. Release builds serve the embedded frontend and never reload.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

const USAGE: &str = "usage: cycletron render <show.toml> [--out video.mp4] [--song n] [--section label] [--from s] [--to s] [--size WxH] [--fps n] [--quality standard|small|master] [--jobs n] [--fresh] [--preview] [--progress json]";
/// Rendering saturates the CPU at about eight jobs on a 14-core machine; more only contend.
const MAX_DEFAULT_JOBS: usize = 8;
/// Memory one job takes at 1080p: its WebKit page process (~700 MB) and its
/// x264 encoder (~350 MB), measured on eight jobs 2026-11-10.
const JOB_MEMORY: u64 = 1100 << 20;
/// Memory left to the rest of the machine when sizing the default job count.
const RESERVED_MEMORY: u64 = 2 << 30;
/// Disk kept free beyond a render's own estimate.
const DISK_MARGIN: u64 = 512 << 20;
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
    pub quality: Option<Quality>,
    pub jobs: usize,
    pub fresh: bool,
    /// Show the render windows even where they can render hidden.
    pub preview: bool,
    pub progress: Progress,
}

/// The encode, by file size. The show file's `quality` names the same three.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Quality {
    /// Capped at YouTube's recommended upload rate: about 90 MB a minute at 1080p60.
    Standard,
    /// Half that, for sharing: about 45 MB a minute at 1080p60.
    Small,
    /// Uncapped crf 16, to edit further: about 200 MB a minute at 1080p60.
    Master,
}

impl Quality {
    fn parse(v: &str) -> Option<Self> {
        match v {
            "standard" => Some(Self::Standard),
            "small" => Some(Self::Small),
            "master" => Some(Self::Master),
            _ => None,
        }
    }

    /// x264 rate control: the crf, and a bitrate cap in kbit/s, if any.
    /// The cap is set for 1080p60 and follows the pixel rate to the power
    /// 0.75, which tracks YouTube's table (1080p30 8, 720p60 7.5 Mbps).
    fn rate(self, width: u32, height: u32, fps: u32) -> (u32, Option<u32>) {
        let (crf, cap_1080p60) = match self {
            Self::Standard => (20, Some(12_000.0)),
            Self::Small => (23, Some(6_000.0)),
            Self::Master => (16, None),
        };
        (
            crf,
            cap_1080p60.map(|kbps| scaled(kbps, width, height, fps)),
        )
    }

    /// About how many kbit/s the video takes. Master is uncapped; busy 1080p60
    /// measured about 26 Mbps at crf 16 (2026-11-10).
    fn kbps(self, width: u32, height: u32, fps: u32) -> u32 {
        self.rate(width, height, fps)
            .1
            .unwrap_or_else(|| scaled(26_000.0, width, height, fps))
    }
}

/// Bytes as "340 MB" or "1.2 GB".
fn human_size(bytes: u64) -> String {
    const MB: f64 = (1u64 << 20) as f64;
    if bytes < 1 << 30 {
        format!("{} MB", (bytes as f64 / MB).ceil())
    } else {
        format!("{:.1} GB", bytes as f64 / (1024.0 * MB))
    }
}

/// A 1080p60 bitrate for another frame size and rate.
fn scaled(kbps_1080p60: f64, width: u32, height: u32, fps: u32) -> u32 {
    let scale = (width as f64 * height as f64 * fps as f64 / (1920.0 * 1080.0 * 60.0)).powf(0.75);
    (kbps_1080p60 * scale).max(1_000.0).round() as u32
}

/// Jobs to run by default: the cores less two, up to eight, and no more than
/// the free memory holds, so a small machine doesn't swap.
fn default_jobs() -> usize {
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let free = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing()
            .with_memory(sysinfo::MemoryRefreshKind::nothing().with_ram()),
    )
    .map(|s| s.available_memory())
    .ok()
    .filter(|&bytes| bytes > 0);
    jobs_for(cores, free)
}

/// `default_jobs` given the core count and the free memory, if known.
fn jobs_for(cores: usize, free_memory: Option<u64>) -> usize {
    let by_cores = cores.saturating_sub(2).clamp(1, MAX_DEFAULT_JOBS);
    match free_memory {
        Some(bytes) => {
            by_cores.min((bytes.saturating_sub(RESERVED_MEMORY) / JOB_MEMORY).max(1) as usize)
        }
        None => by_cores,
    }
}

/// How the render reports what it's doing.
#[derive(Clone, Copy, PartialEq)]
pub enum Progress {
    /// Lines on stderr, for a terminal.
    Text,
    /// One JSON [`Event`] per line on stdout, for the app.
    Json,
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
        quality: None,
        jobs: 0,
        fresh: false,
        preview: false,
        progress: Progress::Text,
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
            "--quality" => {
                flags.quality = Some(
                    Quality::parse(value(&mut it, "--quality")?)
                        .ok_or("--quality takes standard, small or master")?,
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
            "--preview" => flags.preview = true,
            "--progress" => {
                flags.progress = match value(&mut it, "--progress")?.as_str() {
                    "json" => Progress::Json,
                    "text" => Progress::Text,
                    _ => return Err("--progress takes json or text".into()),
                };
            }
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}\n{USAGE}")),
            _ => positional.push(arg),
        }
    }
    if flags.jobs == 0 {
        flags.jobs = default_jobs();
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
    let progress = flags.progress;
    let ffmpeg = match prepare(&flags, &context) {
        Ok(ffmpeg) => ffmpeg,
        Err(message) => {
            report(progress, &Event::Error { message });
            return 1;
        }
    };
    let unthrottled = hidden_pages_run();
    let hidden = !flags.preview && unthrottled;
    // Keeps App Nap off the process and the machine from idle sleep, for the
    // whole run (the activity ends with the process).
    #[cfg(target_os = "macos")]
    let _activity = objc2_foundation::NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        objc2_foundation::NSActivityOptions::UserInitiated,
        objc2_foundation::ns_string!("Rendering a video"),
    );
    // Visible windows pause when they go off screen, so keep the display awake too.
    #[cfg(target_os = "macos")]
    if !hidden {
        let _ = std::process::Command::new("caffeinate")
            .args(["-dimsu", "-w", &std::process::id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    let jobs = flags.jobs;
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            render_plan,
            render_songs,
            render_cues,
            render_next,
            render_mix,
            render_chunk_done,
            render_frame,
            render_failed,
            render_hidden,
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                let render = webview.state::<Render>();
                *render
                    .epochs
                    .lock()
                    .unwrap()
                    .entry(webview.label().to_string())
                    .or_insert(0) += 1;
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let render = Render::new(flags, ffmpeg, unthrottled, app.handle())?;
            let url = page_url(app.handle())?;
            app.manage(render);
            // Tiled from the top left, three a row, when they show.
            for k in 0..jobs {
                let window = WebviewWindowBuilder::new(
                    app,
                    format!("render-{k}"),
                    WebviewUrl::External(url.clone()),
                )
                .title(format!("Cycletron render {}", k + 1))
                .inner_size(PREVIEW_WIDTH, PREVIEW_HEIGHT)
                .position(
                    40.0 + (PREVIEW_WIDTH + 20.0) * (k % 3) as f64,
                    40.0 + (PREVIEW_HEIGHT + 40.0) * (k / 3) as f64,
                )
                .visible(!hidden)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .always_on_top(!hidden)
                // A visible preview shouldn't take focus. Wayland compositors decide
                // that themselves: Hyprland can focus new windows anyway, and only a
                // window rule (`no_initial_focus`, see docs/SHOW_FILES.md) stops it.
                .focusable(false)
                .skip_taskbar(true)
                .focused(false)
                .resizable(false)
                .build()?;
                #[cfg(target_os = "linux")]
                watch_page_process(app.handle(), &window);
                #[cfg(not(target_os = "linux"))]
                let _ = window;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(FIRST_CALL_TIMEOUT_SECS));
                let render = handle.state::<Render>();
                if render.first_call.lock().unwrap().is_none() {
                    fail(
                        &handle,
                        &format!(
                            "the render page did not start in {FIRST_CALL_TIMEOUT_SECS}s{}",
                            dev_hint()
                        ),
                    );
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                interrupted().await;
                if handle.state::<Render>().stop() {
                    report(
                        progress,
                        &Event::Error {
                            message: "interrupted".into(),
                        },
                    );
                    shut_down(&handle, 130);
                }
            });
            Ok(())
        })
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            report(
                progress,
                &Event::Error {
                    message: e.to_string(),
                },
            );
            return 1;
        }
    };
    let code = app.run_return(|_, _| {});
    // Closing the last window ends the loop with 0; a shutdown's code wins.
    match EXIT_CODE.load(Ordering::SeqCst) {
        0 => code,
        asked => asked,
    }
    .clamp(0, 255) as u8
}

fn dev_hint() -> &'static str {
    if cfg!(debug_assertions) {
        " (a debug build loads the page from vite: run `npm run dev` in ui/ first)"
    } else {
        ""
    }
}

/// Whether render windows keep running hidden: macOS 14+, where WebKit's
/// inactive scheduling policy (Tauri's `background_throttling`) stops the
/// throttling that otherwise stalls a hidden page within seconds.
///
/// Not Linux, measured 2026-11-10: a hidden WebKitGTK page renders 30% faster
/// and identically, but keeps each frame's canvas memory until a screen update
/// it never gets, growing ~130 MB/s until WebKit kills it ("Unable to shrink
/// memory footprint ... below the kill threshold (4096 MB)"). Visible pages
/// stay under 1 GB. Windows' WebView2 is untested.
fn hidden_pages_run() -> bool {
    #[cfg(target_os = "macos")]
    {
        objc2_foundation::NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 14
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Resolves on Ctrl-C, or on SIGTERM (what the app's Cancel sends).
async fn interrupted() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let Ok(mut term) = signal(SignalKind::terminate()) else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// What the render reports, in order: exports, the plan, frames, notices, then done or an error.
#[derive(Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event {
    Exporting {
        song: String,
    },
    #[serde(rename_all = "camelCase")]
    Plan {
        label: String,
        frames: u64,
        width: u32,
        height: u32,
        fps: u32,
        chunks: usize,
        jobs: usize,
        quality: String,
        out: String,
    },
    Frames {
        label: String,
        done: u64,
        total: u64,
        fps: u32,
    },
    Notice {
        message: String,
    },
    Done {
        label: String,
        frames: u64,
        out: String,
        seconds: f64,
        jobs: usize,
        /// Milliseconds per frame, within one job: updating the modes, drawing, reading
        /// back, sending (of which `encoder` is waiting for the encoder to take it).
        update: f64,
        draw: f64,
        readback: f64,
        send: f64,
        encoder: f64,
        /// Seconds the jobs spent setting up their chunks, summed.
        setup: f64,
        /// Modes stepped each frame.
        modes: u64,
    },
    Error {
        message: String,
    },
}

fn report(progress: Progress, event: &Event) {
    if progress == Progress::Json {
        let mut out = std::io::stdout().lock();
        if serde_json::to_writer(&mut out, event).is_ok() {
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
        return;
    }
    match event {
        Event::Exporting { song } => eprintln!("exporting {song}…"),
        Event::Plan {
            label,
            frames,
            width,
            height,
            fps,
            chunks,
            jobs,
            quality,
            ..
        } => {
            eprintln!(
                "{label}: {frames} frames at {width}x{height} {fps} fps ({quality}), {chunks} chunks on {jobs} jobs"
            )
        }
        Event::Frames {
            label,
            done,
            total,
            fps,
        } => eprint!(
            "\r{label}: {}/{}s",
            done / *fps as u64,
            (*total as f64 / *fps as f64).round()
        ),
        Event::Notice { message } => eprintln!("\n{message}"),
        Event::Done {
            label,
            frames,
            out,
            seconds,
            jobs,
            update,
            draw,
            readback,
            send,
            encoder,
            setup,
            modes,
        } => {
            eprintln!("\n{label}: {frames} frames → {out} in {seconds:.1}s ({jobs} jobs)");
            eprintln!(
                "per frame in a job: update {update} ms ({modes} modes), draw {draw} ms, readback {readback} ms, send {send} ms (encoder {encoder} ms); setup {setup} s over all jobs"
            );
        }
        Event::Error { message } => eprintln!("\ncycletron render: {message}"),
    }
}

/// Everything that can fail before a window exists; returns the ffmpeg to encode with.
fn prepare(flags: &Flags, context: &tauri::Context<tauri::Wry>) -> Result<PathBuf, String> {
    if !flags.show.is_file() {
        return Err(format!("{}: not a file", flags.show.display()));
    }
    let ffmpeg = crate::ffmpeg::require("Rendering a video")?;
    if !crate::ffmpeg::has_encoder(&ffmpeg, "libx264") {
        return Err(format!(
            "{} has no H.264 encoder (libx264), which the render needs. Some Linux builds leave it out: \
             on Fedora, install ffmpeg from RPM Fusion; elsewhere, a full ffmpeg build. Or set \
             FFMPEG_PATH to one that has it.",
            ffmpeg.display()
        ));
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
    Ok(ffmpeg)
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
    ffmpeg: PathBuf,
    /// Hidden pages keep running (macOS 14+), so visibility notices mean nothing.
    unthrottled: bool,
    show_text: String,
    show_dir: PathBuf,
    home: PathBuf,
    cache: PathBuf,
    /// The bundled sample set and the enabled packs' banks, for exports.
    samples: cycletron_render::SampleSetPaths,
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
    /// Nanoseconds spent waiting on the encoders to take frames, summed.
    encoder_wait: AtomicU64,
    finished: Mutex<bool>,
    /// The final concat-and-mux ffmpeg, while it runs.
    mux: Mutex<Option<Child>>,
    /// Every finished chunk's timings, summed.
    timings: Mutex<Timings>,
    /// Set by the first `stop`; later failures are fallout and go unreported.
    stopped: std::sync::atomic::AtomicBool,
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
    quality: Quality,
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

/// Where a job's time went, summed over its frames, in milliseconds.
#[derive(Default, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Timings {
    /// Song setup and warm-up before the chunk's first frame.
    setup: f64,
    /// Stepping every mode the show uses.
    update: f64,
    /// Drawing the shown mode and its layers (WebKit may defer the raster to the readback).
    draw: f64,
    /// Reading the canvas back.
    readback: f64,
    /// Sending the pixels to the encoder, including waiting on it.
    send: f64,
    frames: u64,
    /// Modes stepped each frame.
    modes: u64,
}

impl Timings {
    fn add(&mut self, t: Timings) {
        self.setup += t.setup;
        self.update += t.update;
        self.draw += t.draw;
        self.modes = self.modes.max(t.modes);
        self.readback += t.readback;
        self.send += t.send;
        self.frames += t.frames;
    }
}

#[derive(Default)]
struct Worker {
    chunk: Option<usize>,
    child: Option<Child>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    packs_sent: bool,
}

impl Render {
    fn new(
        flags: Flags,
        ffmpeg: PathBuf,
        unthrottled: bool,
        app: &AppHandle,
    ) -> Result<Self, String> {
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
        let samples = cycletron_render::SampleSetPaths::Cycletron {
            manifest: crate::cli::bundled_manifest(app.package_info())?,
            packs: banks_for(&flags.show, &library, &cache.with_file_name("pack-banks"))?,
        };
        let (ready, _) = tokio::sync::watch::channel(false);
        Ok(Self {
            flags,
            ffmpeg,
            unthrottled,
            show_text,
            show_dir,
            home,
            cache,
            samples,
            packs,
            plan: Mutex::new(Plan::Unclaimed),
            ready,
            songs: Mutex::new(Vec::new()),
            workers: Mutex::new(HashMap::new()),
            epochs: Mutex::new(HashMap::new()),
            first_call: Mutex::new(None),
            started: Instant::now(),
            frames_done: AtomicU64::new(0),
            encoder_wait: AtomicU64::new(0),
            finished: Mutex::new(false),
            mux: Mutex::new(None),
            timings: Mutex::new(Timings::default()),
            stopped: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn say(&self, event: Event) {
        report(self.flags.progress, &event);
    }

    /// Stop every encoder and remove what they wrote: the parts, and a half-muxed
    /// output. True for the call that stopped it, false once stopped.
    fn stop(&self) -> bool {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return false;
        }
        let children: Vec<Child> = self
            .workers
            .lock()
            .unwrap()
            .values_mut()
            .filter_map(|w| {
                w.stdin = None;
                w.child.take()
            })
            .collect();
        for mut child in children {
            let _ = child.kill();
            let _ = child.wait();
        }
        let muxing = self.mux.lock().unwrap().take();
        if let Plan::Ready(s) = &*self.plan.lock().unwrap() {
            if let Some(mut child) = muxing {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&s.out);
            }
            let _ = std::fs::remove_dir_all(&s.parts);
        }
        true
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

/// The pack the show sits in: the nearest `pack.json` above the show file.
fn show_pack(show: &Path) -> Result<Option<(PathBuf, crate::packs::PackManifest)>, String> {
    let mut dir = show.parent();
    while let Some(d) = dir {
        if d.join("pack.json").is_file() {
            return Ok(Some((d.to_path_buf(), crate::packs::parse_manifest(d)?)));
        }
        dir = d.parent();
    }
    Ok(None)
}

/// The sample banks a show renders with, as manifests under `dir`: its own
/// pack's, then the library's enabled packs', each pack once by id.
fn banks_for(show: &Path, library: &Path, dir: &Path) -> Result<Vec<PathBuf>, String> {
    let own = show_pack(show)?;
    let own_id = own.as_ref().map(|(_, m)| m.id.clone());
    let mut out: Vec<PathBuf> = own
        .and_then(|(d, m)| crate::packs::bank_manifest(&d, &m, &dir.join("show")))
        .into_iter()
        .collect();
    let root = crate::packs::packs_root(library);
    let enabled = crate::packs::read_enabled(&root).enabled;
    for (d, m) in crate::packs::scan_installed(&root) {
        if enabled.contains(&m.id) && own_id.as_ref() != Some(&m.id) {
            out.extend(crate::packs::bank_manifest(&d, &m, dir));
        }
    }
    Ok(out)
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
    if let Some((d, m)) = show_pack(show)? {
        add(&d, &m)?;
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
    let samples = render.samples.clone();
    let fresh = render.flags.fresh;
    let progress = render.flags.progress;
    let plans = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SongPlan>, String> {
        std::thread::scope(|scope| {
            let handles: Vec<_> = songs
                .iter()
                .map(|song| {
                    let cache = &cache;
                    let samples = &samples;
                    scope.spawn(move || -> Result<SongPlan, String> {
                        let source = PathBuf::from(&song.source);
                        let dir = match &song.performance {
                            Some(dir) => PathBuf::from(dir),
                            None => {
                                exported(&source, song.passes, cache, fresh, samples, progress)?
                            }
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
    samples: &cycletron_render::SampleSetPaths,
    progress: Progress,
) -> Result<PathBuf, String> {
    use sha2::Digest as _;
    let text = std::fs::read_to_string(source)
        .map_err(|e| format!("can't read {}: {e}", source.display()))?;
    let mut hasher = sha2::Sha256::new();
    hasher.update(text.as_bytes());
    hasher.update(format!("passes={passes}").as_bytes());
    // A pack's banks changing (a new sample, a sample removed) re-exports the song.
    if let cycletron_render::SampleSetPaths::Cycletron { packs, .. } = samples {
        for bank in packs {
            hasher.update(std::fs::read(bank).unwrap_or_default());
        }
    }
    let key = hex(&hasher.finalize()[..8]);
    let stem = source.file_stem().unwrap_or_default().to_string_lossy();
    let dir = cache.join(format!("{stem}-{key}"));
    if dir.join("performance.json").is_file() && !fresh {
        return Ok(dir);
    }
    report(
        progress,
        &Event::Exporting {
            song: source
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        },
    );
    let opts = cycletron_render::performance::Options {
        passes,
        seconds: None,
    };
    cycletron_render::performance::export(source, &dir, &opts, samples)?;
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
    quality: Option<String>,
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
    let quality = match (flags.quality, payload.quality.as_deref()) {
        (Some(q), _) => q,
        (None, Some(q)) => {
            Quality::parse(q).ok_or_else(|| format!("show.quality: no quality '{q}'"))?
        }
        (None, None) => Quality::Standard,
    };

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
    // The parts and the finished video sit side by side until the mux is done.
    let video = quality.kbps(width, height, fps) as u64 * 1000 / 8 * frames / fps as u64;
    let need = 2 * video + DISK_MARGIN;
    let free = fs4::available_space(&parts).unwrap_or(u64::MAX);
    if free < need {
        let _ = std::fs::remove_dir_all(&parts);
        return Err(format!(
            "not enough disk space beside {}: the render needs about {} while it works (a {} video at \
             this quality, its parts, and room for the system), and {} is free. Free some space, or \
             pick a smaller quality or size.",
            out.display(),
            human_size(need),
            human_size(video),
            human_size(free)
        ));
    }
    let mut chunks = Vec::new();
    for (i, song) in songs.iter().enumerate() {
        // Songs wholly outside what's rendered (a --to before them, a --from after) get no chunks.
        if song.start >= last || song.start + song.frames <= first {
            continue;
        }
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
    render.say(Event::Plan {
        label: label.clone(),
        frames,
        width,
        height,
        fps,
        chunks: chunks.len(),
        jobs: flags.jobs,
        quality: format!("{quality:?}").to_lowercase(),
        out: out.to_string_lossy().into_owned(),
    });
    *render.plan.lock().unwrap() = Plan::Ready(Schedule {
        width,
        height,
        fps,
        quality,
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
        render.say(Event::Notice {
            message: format!("{label}: reloaded; chunk {k} starts over"),
        });
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
    let (crf, cap) = schedule
        .quality
        .rate(schedule.width, schedule.height, schedule.fps);
    // x264 defaults to 1.5 threads a core per encoder, each with its own frame
    // buffers: eight of them took 4.5 GB. A window paints about 25 fps at 1080p,
    // and two threads encode 125, so a share of the cores costs no time.
    let cores = std::thread::available_parallelism().map_or(2, std::num::NonZero::get);
    let threads = (cores / render.flags.jobs).max(2);
    let mut rate = vec![
        "-threads".to_string(),
        threads.to_string(),
        "-crf".to_string(),
        crf.to_string(),
    ];
    if let Some(kbps) = cap {
        rate.extend([
            "-maxrate".into(),
            format!("{kbps}k"),
            "-bufsize".into(),
            format!("{kbps}k"),
        ]);
    }
    let mut child = crate::ffmpeg::command(&render.ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgba"])
        .args(["-s", &format!("{}x{}", schedule.width, schedule.height)])
        .args(["-r", &schedule.fps.to_string(), "-i", "-"])
        // veryfast, not medium: a quarter less render time with every core busy, and
        // measured no smaller on these busy frames (2026-11-10); the cap sets the size.
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        ])
        .args(&rate)
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

/// One frame, raw RGBA, to this window's chunk encoder. Tauri IPC beat a
/// loopback HTTP sink in release builds on both macOS (8 jobs: 11.0 s vs 13.8 s)
/// and Linux (4 jobs: 27.8 s vs 38.1 s), measured 2026-11-10.
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
    let label = window.label();
    let stdin = {
        let workers = render.workers.lock().unwrap();
        workers
            .get(label)
            .and_then(|w| w.stdin.clone())
            .ok_or("no chunk is open for this window")?
    };
    let waited = tauri::async_runtime::spawn_blocking(move || {
        let at = Instant::now();
        stdin
            .lock()
            .unwrap()
            .write_all(&bytes)
            .map_err(|e| format!("ffmpeg stdin: {e}"))?;
        Ok::<_, String>(at.elapsed())
    })
    .await
    .map_err(|e| e.to_string())??;
    render
        .encoder_wait
        .fetch_add(waited.as_nanos() as u64, Ordering::Relaxed);
    let done = render.frames_done.fetch_add(1, Ordering::Relaxed) + 1;
    let plan = render.plan.lock().unwrap();
    if let Plan::Ready(s) = &*plan
        && done.is_multiple_of(s.fps as u64)
    {
        render.say(Event::Frames {
            label: s.label.clone(),
            done,
            total: s.last - s.first,
            fps: s.fps,
        });
    }
    Ok(())
}

/// The window's chunk is complete: close its encoder, and finish the video when it was the last.
#[tauri::command]
async fn render_chunk_done(
    timings: Timings,
    window: tauri::Window,
    app: AppHandle,
    render: State<'_, Render>,
) -> Result<(), String> {
    render.timings.lock().unwrap().add(timings);
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
                    Ok(()) => shut_down(&app, 0),
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
    let mut cmd = crate::ffmpeg::command(&render.ffmpeg);
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
    cmd.args([
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
        // Small keeps the audio from outweighing its video.
        if s.quality == Quality::Small {
            "128k"
        } else {
            "256k"
        },
    ])
    .arg(&s.out);
    let child = cmd.spawn().map_err(|e| format!("ffmpeg: {e}"))?;
    let (out, parts, label, frames) = (
        s.out.clone(),
        s.parts.clone(),
        s.label.clone(),
        s.last - s.first,
    );
    *render.mux.lock().unwrap() = Some(child);
    // Released so an interrupt can stop the mux; it takes the child away when it does.
    drop(songs);
    drop(plan);
    let status = loop {
        {
            let mut mux = render.mux.lock().unwrap();
            let Some(child) = mux.as_mut() else {
                return Err("interrupted".into());
            };
            if let Some(status) = child.try_wait().map_err(|e| format!("ffmpeg: {e}"))? {
                mux.take();
                break status;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    if !status.success() {
        return Err(format!("ffmpeg (mux) exited {status}"));
    }
    let _ = std::fs::remove_dir_all(&parts);
    let t = *render.timings.lock().unwrap();
    let per = |ms: f64| (ms / t.frames.max(1) as f64 * 10.0).round() / 10.0;
    render.say(Event::Done {
        label,
        frames,
        out: out.to_string_lossy().into_owned(),
        seconds: render.started.elapsed().as_secs_f64(),
        jobs: render.flags.jobs,
        update: per(t.update),
        draw: per(t.draw),
        readback: per(t.readback),
        send: per(t.send),
        encoder: per(render.encoder_wait.load(Ordering::Relaxed) as f64 / 1e6),
        setup: (t.setup / 100.0).round() / 10.0,
        modes: t.modes,
    });
    Ok(())
}

/// A render page whose web process ends would leave its chunk waiting forever:
/// fail the render instead, saying why. Our own shutdown ends them by API.
#[cfg(target_os = "linux")]
fn watch_page_process(app: &AppHandle, window: &tauri::WebviewWindow) {
    let (app, label) = (app.clone(), window.label().to_string());
    let _ = window.with_webview(move |webview| {
        use webkit2gtk::{WebProcessTerminationReason as Reason, WebViewExt as _};
        webview
            .inner()
            .connect_web_process_terminated(move |_, reason| {
                let why = match reason {
                    Reason::TerminatedByApi => return,
                    Reason::ExceededMemoryLimit => "went over WebKit's memory limit",
                    Reason::Crashed => "crashed",
                    _ => "ended",
                };
                fail(&app, &format!("the render page in {label} {why}"));
            });
    });
}

/// The exit code a shutdown asked for, until the windows have closed.
static EXIT_CODE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// End the render pages, close their windows, and let the app exit once
/// they're gone, with `code`. On Linux a page still busy rendering when its
/// UI process goes misses the shutdown: WebKitGTK's web process aborts and
/// dumps core ("WebProcess didn't exit as expected", seen on Hyprland
/// 2026-11-10), so it is ended first.
fn shut_down(app: &AppHandle, code: i32) {
    EXIT_CODE.store(code, Ordering::SeqCst);
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(code);
        return;
    }
    for window in windows.values() {
        #[cfg(target_os = "linux")]
        let _ = window.with_webview(|webview| {
            use webkit2gtk::WebViewExt as _;
            webview.inner().terminate_web_process();
        });
        let _ = window.destroy();
    }
    // The last window closing ends the event loop; this is the backstop.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        app.exit(code);
    });
}

fn fail(app: &AppHandle, message: &str) {
    let render = app.state::<Render>();
    if render.stop() {
        render.say(Event::Error {
            message: message.to_string(),
        });
        shut_down(app, 1);
    }
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

/// A visible preview window went off screen (or came back): the render pauses with it.
#[tauri::command]
fn render_hidden(window: tauri::Window, hidden: bool, render: State<'_, Render>) {
    if render.unthrottled {
        return;
    }
    let message = if hidden {
        format!(
            "{}: hidden; the render pauses until its preview windows are on screen",
            window.label()
        )
    } else {
        format!("{}: visible again", window.label())
    };
    render.say(Event::Notice { message });
}

#[cfg(test)]
mod tests {
    use super::{Quality, jobs_for};

    #[test]
    fn default_jobs_fit_the_cores_and_the_free_memory() {
        const GB: u64 = 1 << 30;
        assert_eq!(jobs_for(14, Some(64 * GB)), 8);
        assert_eq!(jobs_for(14, None), 8);
        assert_eq!(jobs_for(4, Some(64 * GB)), 2);
        assert_eq!(jobs_for(8, Some(6 * GB)), 3);
        assert_eq!(jobs_for(8, Some(GB)), 1);
        assert_eq!(jobs_for(1, Some(64 * GB)), 1);
    }

    #[test]
    fn caps_follow_the_pixel_rate() {
        assert_eq!(Quality::Standard.rate(1920, 1080, 60), (20, Some(12_000)));
        assert_eq!(Quality::Small.rate(1920, 1080, 60), (23, Some(6_000)));
        assert_eq!(Quality::Master.rate(1920, 1080, 60), (16, None));
        let (_, Some(p30)) = Quality::Standard.rate(1920, 1080, 30) else {
            panic!()
        };
        let (_, Some(p720)) = Quality::Standard.rate(1280, 720, 60) else {
            panic!()
        };
        assert!((7_000..7_300).contains(&p30), "{p30}");
        assert!((6_000..6_800).contains(&p720), "{p720}");
        assert_eq!(Quality::Small.rate(320, 180, 24).1, Some(1_000));
    }
}
