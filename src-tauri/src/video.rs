//! Render Video, from the app. Runs this binary's `render` command
//! (`render.rs`) on a show file with `--progress json` and forwards its events
//! to the main window as `render-video`. Its own events pass through as they
//! come: exporting, plan, frames, notice. Then exactly one ending: `done`,
//! `error` or `cancelled`. One render at a time. Cancel sends SIGTERM, and the
//! render answers by stopping its encoders and removing its parts.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager as _, State};

/// stderr lines kept, for a render that dies without saying why.
const STDERR_TAIL: usize = 12;

#[derive(Default)]
pub struct VideoState {
    running: Mutex<Option<Running>>,
}

struct Running {
    pid: u32,
    out: PathBuf,
    cancelled: Arc<AtomicBool>,
}

impl VideoState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stop the running render, if any. The ending event follows when it exits.
    pub fn cancel(&self) {
        let running = self.running.lock().unwrap();
        let Some(r) = running.as_ref() else { return };
        r.cancelled.store(true, Ordering::SeqCst);
        terminate(r.pid, &r.out);
    }
}

#[cfg(unix)]
fn terminate(pid: u32, _out: &Path) {
    // SAFETY: kill(2) on a child of this process that is not yet reaped: the
    // caller holds the `running` lock, which is cleared before the child is waited on.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

/// No signals to catch on Windows: end the tree, then remove its parts as the render would.
#[cfg(not(unix))]
fn terminate(pid: u32, out: &Path) {
    let _ = crate::ffmpeg::command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if let Some(dir) = out.parent() {
        let _ = std::fs::remove_dir_all(dir.join(format!(".render-{pid}")));
    }
}

/// Start rendering `show` to `out`, at `quality` and `size` ("WIDTHxHEIGHT")
/// when given, else the show's. Progress arrives as `render-video` events.
#[tauri::command]
pub fn render_video(
    app: AppHandle,
    show: String,
    out: String,
    quality: Option<String>,
    size: Option<String>,
    state: State<'_, VideoState>,
) -> Result<(), String> {
    let mut running = state.running.lock().unwrap();
    if running.is_some() {
        return Err("a video is already rendering".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut args = vec![
        "render".to_string(),
        show,
        "--out".into(),
        out.clone(),
        "--progress".into(),
        "json".into(),
    ];
    if let Some(q) = quality {
        args.extend(["--quality".into(), q]);
    }
    if let Some(s) = size {
        args.extend(["--size".into(), s]);
    }
    let mut child = crate::ffmpeg::command(exe)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("start the render: {e}"))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    *running = Some(Running {
        pid: child.id(),
        out: PathBuf::from(&out),
        cancelled: cancelled.clone(),
    });
    drop(running);

    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let (tail_tx, tail_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut tail = std::collections::VecDeque::with_capacity(STDERR_TAIL);
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tail.len() == STDERR_TAIL {
                tail.pop_front();
            }
            tail.push_back(line);
        }
        let _ = tail_tx.send(Vec::from(tail).join("\n"));
    });
    std::thread::spawn(move || {
        // The render's own ending, held back until the process is gone.
        let mut ending: Option<Value> = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match event["event"].as_str() {
                Some("done" | "error") => ending = Some(event),
                _ => {
                    let _ = app.emit_to("main", "render-video", event);
                }
            }
        }
        // Cleared before the child is reaped, so Cancel never signals a reused pid.
        app.state::<VideoState>().running.lock().unwrap().take();
        let status = child.wait();
        let stderr = tail_rx.recv().unwrap_or_default();
        let ending = if cancelled.load(Ordering::SeqCst) {
            json!({"event": "cancelled"})
        } else {
            match (ending, status) {
                (Some(e), Ok(s)) if e["event"] == "done" && s.success() => e,
                (Some(e), _) if e["event"] == "error" => e,
                (_, Ok(s)) => {
                    json!({"event": "error", "message": failure(&format!("the render exited {s}"), &stderr)})
                }
                (_, Err(e)) => {
                    json!({"event": "error", "message": failure(&e.to_string(), &stderr)})
                }
            }
        };
        let _ = app.emit_to("main", "render-video", ending);
    });
    Ok(())
}

fn failure(what: &str, stderr: &str) -> String {
    if stderr.trim().is_empty() {
        what.to_string()
    } else {
        format!("{what}:\n{stderr}")
    }
}

/// Stop the running render; a `cancelled` event follows.
#[tauri::command]
pub fn cancel_render_video(state: State<'_, VideoState>) {
    state.cancel();
}
