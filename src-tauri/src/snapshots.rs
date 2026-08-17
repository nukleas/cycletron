//! Per-file version snapshots. Every save produces a snapshot — a small
//! local "Git lite" so the user can roll back without leaving the app.
//!
//! Layout:
//!   {app_data_dir}/snapshots/{path_id}/{timestamp_ms}.strudel
//!
//! `path_id` is a stable non-cryptographic hash of the absolute file path.
//! `timestamp_ms` is the moment the snapshot was written.

use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};

const MAX_SNAPSHOTS_PER_FILE: usize = 50;

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    /// Filename (without extension) — also the timestamp in millis.
    pub id: String,
    pub created_at_ms: i64,
    pub size: u64,
}

fn snapshots_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("snapshots")
}

fn path_id(file_path: &Path) -> String {
    let mut h = DefaultHasher::new();
    file_path.to_string_lossy().hash(&mut h);
    format!("{:016x}", h.finish())
}

fn dir_for(app_data_dir: &Path, file_path: &Path) -> PathBuf {
    snapshots_root(app_data_dir).join(path_id(file_path))
}

/// Write a snapshot of `code` for `file_path`. Trims to `MAX_SNAPSHOTS_PER_FILE`
/// by deleting the oldest entries on overflow. Errors are logged, not
/// propagated — save should not fail just because the snapshot did.
pub fn record(app_data_dir: &Path, file_path: &Path, code: &str) {
    if code.is_empty() {
        return;
    }
    let dir = dir_for(app_data_dir, file_path);
    if let Err(e) = fs::create_dir_all(&dir) {
        tracing::warn!("snapshot create_dir_all: {e}");
        return;
    }
    let ts = Utc::now().timestamp_millis();
    let target = dir.join(format!("{ts}.strudel"));
    if let Err(e) = fs::write(&target, code) {
        tracing::warn!("snapshot write: {e}");
        return;
    }
    prune_oldest(&dir, MAX_SNAPSHOTS_PER_FILE);
}

pub fn list(app_data_dir: &Path, file_path: &Path) -> Vec<Snapshot> {
    let dir = dir_for(app_data_dir, file_path);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(ts) = stem.parse::<i64>() else {
            continue;
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(Snapshot {
            id: stem.to_string(),
            created_at_ms: ts,
            size,
        });
    }
    // Newest first.
    out.sort_by_key(|s| std::cmp::Reverse(s.created_at_ms));
    out
}

pub fn read(app_data_dir: &Path, file_path: &Path, id: &str) -> std::io::Result<String> {
    let dir = dir_for(app_data_dir, file_path);
    let target = dir.join(format!("{id}.strudel"));
    fs::read_to_string(target)
}

fn prune_oldest(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(i64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let ts = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<i64>().ok())?;
            Some((ts, p))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|(ts, _)| *ts);
    let drop_count = files.len() - keep;
    for (_, path) in files.into_iter().take(drop_count) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_roundtrip() {
        let tmp = std::env::temp_dir().join("cycletron_snap_test");
        let _ = fs::remove_dir_all(&tmp);
        let file = PathBuf::from("/virtual/song.strudel");

        record(&tmp, &file, "first");
        std::thread::sleep(std::time::Duration::from_millis(5));
        record(&tmp, &file, "second");

        let snaps = list(&tmp, &file);
        assert_eq!(snaps.len(), 2);
        let latest = &snaps[0];
        let body = read(&tmp, &file, &latest.id).unwrap();
        assert_eq!(body, "second");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn snapshots_prune_to_keep() {
        let tmp = std::env::temp_dir().join("cycletron_snap_prune_test");
        let _ = fs::remove_dir_all(&tmp);
        let file = PathBuf::from("/virtual/song-prune.strudel");
        let dir = dir_for(&tmp, &file);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..55 {
            fs::write(dir.join(format!("{i}.strudel")), format!("snap-{i}")).unwrap();
        }
        prune_oldest(&dir, 50);
        let remaining = list(&tmp, &file);
        assert_eq!(remaining.len(), 50);
        // Newest 50 (ids 5..=54) survived.
        assert_eq!(remaining[0].id, "54");
        let _ = fs::remove_dir_all(&tmp);
    }
}
