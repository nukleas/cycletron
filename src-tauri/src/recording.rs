//! Streaming capture sink: incremental writes to disk, crash-safe.
//!
//! The recorder used to buffer a whole take in the webview and hand it over in
//! one `write_binary_file` call, with the bytes JSON-encoded as a number array
//! — roughly 5x inflation, on top of holding the entire recording in RAM. A
//! set is minutes to hours long, so both had to go.
//!
//! Here the frontend opens a sink, streams chunks as they are produced, and
//! commits at the end. Chunks arrive as raw binary IPC bodies rather than JSON.
//! Writes land in a `<final>.part` beside the destination so a commit is an
//! atomic same-filesystem rename, and a take interrupted by a crash or a quit
//! leaves a `.part` that is still a complete prefix of the audio.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::State;

/// Refuse to start a take with less headroom than this. 1080p30 video runs
/// ~90 MB/min and 48 kHz stereo float WAV ~23 MB/min, so this is minutes, not
/// hours — it exists to catch "disk was already full", not to guarantee a take.
const MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Reject absurd single chunks rather than letting a bad caller exhaust memory.
const MAX_CHUNK_BYTES: usize = 64 * 1024 * 1024;

// --- WAV header layout ------------------------------------------------------
// Mirrors the header written by `ui/src/wav-capture.ts`: 18-byte fmt plus a
// fact chunk, which is what the spec requires for non-PCM formats. The three
// length fields cannot be known when the header goes out, so they are written
// as zero and patched here once the take ends.
//
// Patching lives on this side rather than in the frontend because `written` is
// the only honest count of what reached the disk. A take ended by a quit, a
// crash or a failed chunk never gets to run frontend cleanup, and a WAV whose
// `data` size still reads zero opens as a zero-length file in every DAW even
// though all of its audio is present.
const WAV_HEADER_BYTES: u64 = 58;
const OFFSET_RIFF_SIZE: u64 = 4;
const OFFSET_FACT_FRAMES: u64 = 46;
const OFFSET_DATA_SIZE: u64 = 54;
/// 32-bit float, matching `wav-capture.ts`.
const WAV_BYTES_PER_SAMPLE: u64 = 4;

/// What a sink is capturing. Written to the `.part` sidecar so an interrupted
/// take can be identified without parsing the media itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecMeta {
    /// Container/extension, e.g. "wav".
    pub kind: String,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub channels: Option<u16>,
    /// Wall-clock ISO-8601 start, supplied by the frontend for post-sync.
    #[serde(default)]
    pub started_at: Option<String>,
}

struct Sink {
    file: BufWriter<File>,
    part: PathBuf,
    final_path: PathBuf,
    /// Bytes appended, excluding in-place header patches.
    written: u64,
    /// What is being captured, so a commit can finalize the container.
    meta: RecMeta,
}

#[derive(Default)]
pub struct RecordingState {
    sinks: Mutex<HashMap<u32, Sink>>,
    next_id: AtomicU32,
}

impl RecordingState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Flush and commit every open sink. Called on app exit so a normal quit
    /// mid-take still yields a playable file.
    pub fn commit_all(&self) {
        let mut sinks = self.sinks.lock();
        let ids: Vec<u32> = sinks.keys().copied().collect();
        for id in ids {
            if let Some(sink) = sinks.remove(&id)
                && let Err(e) = finish(sink, true)
            {
                tracing::warn!("recording {id}: commit on exit failed: {e}");
            }
        }
    }
}

#[derive(Serialize)]
pub struct OpenResult {
    pub id: u32,
    /// Free space on the destination volume, for the UI's remaining-time readout.
    pub free_bytes: u64,
}

#[derive(Serialize)]
pub struct CloseResult {
    pub path: String,
    pub bytes: u64,
}

fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    final_path.with_file_name(name)
}

fn sidecar_path(part: &Path) -> PathBuf {
    let mut name = part.file_name().unwrap_or_default().to_os_string();
    name.push(".json");
    part.with_file_name(name)
}

fn free_bytes(dir: &Path) -> u64 {
    fs4::available_space(dir).unwrap_or(u64::MAX)
}

/// Narrow a length to the `u32` a RIFF field can hold.
///
/// A float WAV passes 4 GiB after about 3 h 06 min at 48 kHz stereo, and the
/// field simply cannot describe that. Saturating leaves a file whose header
/// understates a long take; wrapping — which is what a plain `as u32` does —
/// leaves one that is unreadable. Neither is good, so say so out loud. RF64 is
/// the real fix if takes are ever expected to run that long.
fn riff_u32(value: u64, what: &str) -> u32 {
    u32::try_from(value).unwrap_or_else(|_| {
        tracing::warn!(
            "recording: {what} is {value} bytes, past the 4 GiB RIFF limit — \
             the header will understate the file's length"
        );
        u32::MAX
    })
}

/// Fill in the three RIFF length fields, given the total bytes on disk.
///
/// Idempotent, and derived purely from the file's own size, so it is equally
/// correct at a normal close, at a commit-on-exit, and on a `.part` recovered
/// from a previous run.
fn patch_wav_sizes<F: Write + Seek>(
    file: &mut F,
    meta: &RecMeta,
    total_bytes: u64,
) -> std::io::Result<()> {
    let data_bytes = total_bytes.saturating_sub(WAV_HEADER_BYTES);
    let mut put = |offset: u64, value: u32| -> std::io::Result<()> {
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(&value.to_le_bytes())
    };

    put(
        OFFSET_RIFF_SIZE,
        riff_u32(total_bytes - 8, "the RIFF chunk"),
    )?;
    put(OFFSET_DATA_SIZE, riff_u32(data_bytes, "the data chunk"))?;

    // The frame count needs the channel layout; without it the other two fields
    // are still worth writing, and players fall back to the data size anyway.
    if let Some(channels) = meta.channels.filter(|c| *c > 0) {
        let frames = data_bytes / (u64::from(channels) * WAV_BYTES_PER_SAMPLE);
        put(OFFSET_FACT_FRAMES, riff_u32(frames, "the frame count"))?;
    }

    Ok(())
}

/// True for a take whose container needs a length written before it is playable.
fn is_wav(meta: &RecMeta) -> bool {
    meta.kind.eq_ignore_ascii_case("wav")
}

/// Flush, commit or discard, and clean up the sidecar.
///
/// Committing finalizes the container first, so the file is playable at
/// whatever length it actually reached — the caller does not have to have run
/// any cleanup of its own.
fn finish(sink: Sink, commit: bool) -> Result<CloseResult, String> {
    let Sink {
        mut file,
        part,
        final_path,
        written,
        meta,
    } = sink;

    // A WAV holding nothing but its header is not a recording; committing one
    // would leave a file that opens as silence. Treat it as an empty take.
    let commit = commit && !(is_wav(&meta) && written <= WAV_HEADER_BYTES);

    if commit && is_wav(&meta) {
        patch_wav_sizes(&mut file, &meta, written).map_err(|e| format!("patch wav header: {e}"))?;
    }

    file.flush().map_err(|e| format!("flush: {e}"))?;
    // fsync before the rename: a rename that lands before the data would leave
    // a file that looks complete and isn't.
    file.get_ref()
        .sync_all()
        .map_err(|e| format!("sync: {e}"))?;
    drop(file);

    let _ = std::fs::remove_file(sidecar_path(&part));

    if !commit {
        let _ = std::fs::remove_file(&part);
        return Ok(CloseResult {
            path: String::new(),
            bytes: written,
        });
    }

    std::fs::rename(&part, &final_path)
        .map_err(|e| format!("rename {} -> {}: {e}", part.display(), final_path.display()))?;

    Ok(CloseResult {
        path: final_path.to_string_lossy().into_owned(),
        bytes: written,
    })
}

/// Open a sink for `path`. Writes go to `<path>.part` until committed.
#[tauri::command]
pub fn recording_open(
    path: String,
    meta: RecMeta,
    state: State<'_, RecordingState>,
) -> Result<OpenResult, String> {
    let final_path = PathBuf::from(&path);
    let parent = final_path
        .parent()
        .ok_or_else(|| format!("no parent directory for {path}"))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;

    let free = free_bytes(parent);
    if free < MIN_FREE_BYTES {
        return Err(format!(
            "only {} MB free on this volume — need at least {} GB to start recording",
            free / (1024 * 1024),
            MIN_FREE_BYTES / (1024 * 1024 * 1024)
        ));
    }

    let part = part_path(&final_path);
    let file = File::create(&part).map_err(|e| format!("create {}: {e}", part.display()))?;

    // Best-effort: the sidecar only aids recovery, so never fail the take for it.
    if let Ok(json) = serde_json::to_vec_pretty(&meta) {
        let _ = std::fs::write(sidecar_path(&part), json);
    }

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sinks.lock().insert(
        id,
        Sink {
            file: BufWriter::with_capacity(1 << 20, file),
            part,
            final_path,
            written: 0,
            meta,
        },
    );

    Ok(OpenResult {
        id,
        free_bytes: free,
    })
}

/// Append a chunk to an open sink.
///
/// The payload is the raw request body — a top-level `ArrayBuffer` from the
/// frontend, which Tauri delivers as [`tauri::ipc::InvokeBody::Raw`]. Passing a
/// buffer nested inside an args object would instead JSON-encode it as a number
/// array, which is exactly the cost this module exists to avoid.
#[tauri::command]
pub fn recording_write(
    request: tauri::ipc::Request<'_>,
    state: State<'_, RecordingState>,
) -> Result<u64, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("recording_write expects a raw binary body".into());
    };
    if bytes.len() > MAX_CHUNK_BYTES {
        return Err(format!("chunk of {} bytes is too large", bytes.len()));
    }

    let id: u32 = request
        .headers()
        .get("x-rec-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or("missing or invalid x-rec-id header")?;

    let mut sinks = state.sinks.lock();
    let sink = sinks
        .get_mut(&id)
        .ok_or_else(|| format!("unknown recording id {id}"))?;

    sink.file
        .write_all(bytes)
        .map_err(|e| format!("write: {e}"))?;
    sink.written += bytes.len() as u64;

    Ok(sink.written)
}

/// Flush and either commit the `.part` to its final name or discard it.
#[tauri::command]
pub fn recording_close(
    id: u32,
    commit: bool,
    state: State<'_, RecordingState>,
) -> Result<CloseResult, String> {
    let sink = state
        .sinks
        .lock()
        .remove(&id)
        .ok_or_else(|| format!("unknown recording id {id}"))?;
    finish(sink, commit)
}

/// An interrupted take found on disk.
#[derive(Debug, Serialize)]
pub struct Orphan {
    /// The `.part` file itself.
    pub part_path: String,
    /// Where it would land if recovered.
    pub final_path: String,
    pub bytes: u64,
    /// Sidecar metadata, when it survived.
    pub meta: Option<RecMeta>,
}

/// List `.part` files left in `dir` by a previous run, so the UI can offer to
/// recover them. Empty ones are swept rather than reported.
#[tauri::command]
pub fn recording_orphans(dir: String) -> Result<Vec<Orphan>, String> {
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut found = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))?;

    for entry in entries.flatten() {
        let part = entry.path();
        if part.extension().and_then(|e| e.to_str()) != Some("part") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() == 0 {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(sidecar_path(&part));
            continue;
        }

        let sidecar = std::fs::read(sidecar_path(&part))
            .ok()
            .and_then(|b| serde_json::from_slice::<RecMeta>(&b).ok());

        found.push(Orphan {
            final_path: part.with_extension("").to_string_lossy().into_owned(),
            part_path: part.to_string_lossy().into_owned(),
            bytes: meta.len(),
            meta: sidecar,
        });
    }

    Ok(found)
}

/// Promote a recovered `.part` to its final name, or delete it.
///
/// A `.part` left by a hard crash never had its container finalized, so this
/// patches the header from the file's own size before promoting it — otherwise
/// the recovered take reports zero length despite holding all of its audio.
#[tauri::command]
pub fn recording_recover(part_path: String, keep: bool) -> Result<Option<String>, String> {
    let part = PathBuf::from(&part_path);
    if part.extension().and_then(|e| e.to_str()) != Some("part") {
        return Err(format!("not a partial recording: {part_path}"));
    }

    // Read before unlinking: the sidecar carries the channel layout the header
    // patch needs.
    let meta = std::fs::read(sidecar_path(&part))
        .ok()
        .and_then(|b| serde_json::from_slice::<RecMeta>(&b).ok());
    let _ = std::fs::remove_file(sidecar_path(&part));

    if !keep {
        std::fs::remove_file(&part).map_err(|e| format!("remove {part_path}: {e}"))?;
        return Ok(None);
    }

    if let Some(meta) = meta.filter(is_wav) {
        let total = std::fs::metadata(&part)
            .map_err(|e| format!("stat {part_path}: {e}"))?
            .len();
        if total > WAV_HEADER_BYTES {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(&part)
                .map_err(|e| format!("open {part_path}: {e}"))?;
            patch_wav_sizes(&mut file, &meta, total)
                .map_err(|e| format!("patch wav header: {e}"))?;
            file.sync_all().map_err(|e| format!("sync: {e}"))?;
        }
    }

    let final_path = part.with_extension("");
    std::fs::rename(&part, &final_path).map_err(|e| format!("rename {part_path}: {e}"))?;
    Ok(Some(final_path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stereo 32-bit float, matching what `wav-capture.ts` writes.
    const FRAME_BYTES: u64 = 2 * WAV_BYTES_PER_SAMPLE;

    fn meta() -> RecMeta {
        RecMeta {
            kind: "wav".into(),
            sample_rate: Some(48_000),
            channels: Some(2),
            started_at: None,
        }
    }

    /// A header with its length fields still zero, plus `frames` of silence —
    /// exactly the state the frontend leaves a `.part` in mid-take.
    fn unfinished_wav(frames: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; WAV_HEADER_BYTES as usize];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WAVE");
        bytes[50..54].copy_from_slice(b"data");
        bytes.resize(bytes.len() + (frames * FRAME_BYTES) as usize, 0);
        bytes
    }

    fn field(bytes: &[u8], at: u64) -> u32 {
        let at = at as usize;
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    fn sink_holding(part: &Path, target: &Path, body: &[u8]) -> Sink {
        let mut file = BufWriter::new(File::create(part).unwrap());
        file.write_all(body).unwrap();
        Sink {
            file,
            part: part.to_path_buf(),
            final_path: target.to_path_buf(),
            written: body.len() as u64,
            meta: meta(),
        }
    }

    /// Bytes only appear at the destination once committed.
    #[test]
    fn commit_renames_part_to_final() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("take.wav");
        let state = RecordingState::new();

        let part = part_path(&target);
        let sink = sink_holding(&part, &target, &unfinished_wav(64));
        state.sinks.lock().insert(0, sink);

        assert!(part.exists());
        assert!(!target.exists());

        let sink = state.sinks.lock().remove(&0).unwrap();
        let result = finish(sink, true).unwrap();

        assert!(target.exists());
        assert!(!part.exists());
        assert_eq!(result.path, target.to_string_lossy());
    }

    /// A discarded take leaves nothing behind — neither part nor sidecar.
    #[test]
    fn discard_removes_part_and_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("take.wav");
        let part = part_path(&target);
        std::fs::write(sidecar_path(&part), b"{}").unwrap();

        let sink = sink_holding(&part, &target, &unfinished_wav(64));
        finish(sink, false).unwrap();

        assert!(!part.exists());
        assert!(!sidecar_path(&part).exists());
        assert!(!target.exists());
    }

    /// Committing finalizes the container, so the file states its real length
    /// even though the frontend never patched anything. This is what a quit or
    /// a crash mid-take relies on.
    #[test]
    fn commit_patches_the_wav_length_fields() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("take.wav");
        let part = part_path(&target);

        let frames = 1_000;
        let sink = sink_holding(&part, &target, &unfinished_wav(frames));
        finish(sink, true).unwrap();

        let out = std::fs::read(&target).unwrap();
        let data_bytes = frames * FRAME_BYTES;
        assert_eq!(field(&out, OFFSET_DATA_SIZE) as u64, data_bytes);
        assert_eq!(field(&out, OFFSET_FACT_FRAMES) as u64, frames);
        assert_eq!(
            field(&out, OFFSET_RIFF_SIZE) as u64,
            WAV_HEADER_BYTES + data_bytes - 8
        );
        // The audio itself is untouched.
        assert_eq!(out.len() as u64, WAV_HEADER_BYTES + data_bytes);
    }

    /// A take that captured no audio is not worth committing: a header-only WAV
    /// opens as silence, which reads as a successful empty recording.
    #[test]
    fn commit_discards_a_header_only_take() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("take.wav");
        let part = part_path(&target);

        let sink = sink_holding(&part, &target, &unfinished_wav(0));
        let result = finish(sink, true).unwrap();

        assert!(!target.exists());
        assert!(!part.exists());
        assert_eq!(result.path, "");
    }

    /// Empty leftovers are swept, non-empty ones reported with their metadata.
    #[test]
    fn orphan_scan_sweeps_empty_and_reports_the_rest() {
        let dir = tempfile::tempdir().unwrap();

        let empty = dir.path().join("empty.wav.part");
        std::fs::write(&empty, b"").unwrap();

        let real = dir.path().join("real.wav.part");
        std::fs::write(&real, b"audio").unwrap();
        std::fs::write(sidecar_path(&real), serde_json::to_vec(&meta()).unwrap()).unwrap();

        std::fs::write(dir.path().join("unrelated.wav"), b"x").unwrap();

        let mut found = recording_orphans(dir.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(found.len(), 1);

        let orphan = found.pop().unwrap();
        assert_eq!(orphan.bytes, 5);
        assert!(orphan.final_path.ends_with("real.wav"));
        assert_eq!(orphan.meta.unwrap().sample_rate, Some(48_000));
        assert!(!empty.exists());
    }

    /// Recovery promotes the partial file to the name it was headed for.
    #[test]
    fn recover_promotes_part_to_final() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("take.wav.part");
        std::fs::write(&part, b"audio").unwrap();

        let recovered = recording_recover(part.to_string_lossy().into_owned(), true).unwrap();

        assert_eq!(
            recovered.unwrap(),
            dir.path().join("take.wav").to_string_lossy()
        );
        assert!(!part.exists());
    }

    /// A `.part` from a hard crash was never finalized, so recovery has to fill
    /// in the length fields from the file's own size — otherwise the salvaged
    /// take opens as zero seconds.
    #[test]
    fn recover_patches_the_wav_length_fields() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("take.wav.part");
        let frames = 500;
        std::fs::write(&part, unfinished_wav(frames)).unwrap();
        std::fs::write(sidecar_path(&part), serde_json::to_vec(&meta()).unwrap()).unwrap();

        let recovered = recording_recover(part.to_string_lossy().into_owned(), true).unwrap();

        let out = std::fs::read(recovered.unwrap()).unwrap();
        let data_bytes = frames * FRAME_BYTES;
        assert_eq!(field(&out, OFFSET_DATA_SIZE) as u64, data_bytes);
        assert_eq!(field(&out, OFFSET_FACT_FRAMES) as u64, frames);
        assert!(!sidecar_path(&part).exists());
    }
}
