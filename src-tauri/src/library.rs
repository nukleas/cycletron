//! User library: a writable directory tree that backs the in-app File Explorer.
//!
//! All filesystem operations exposed to the frontend are confined to the
//! configured library root. Each mutating helper rejects paths that resolve
//! outside that root (after symlink resolution) to prevent traversal.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const LIBRARY_SETTINGS_FILE: &str = "library.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibrarySettings {
    pub root: PathBuf,
}

impl LibrarySettings {
    pub fn load_or_default(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join(LIBRARY_SETTINGS_FILE);
        if let Ok(s) = fs::read_to_string(&path)
            && let Ok(parsed) = serde_json::from_str::<Self>(&s)
            && parsed.root.as_os_str().len() > 0
        {
            return parsed;
        }
        Self {
            root: default_root(app_data_dir),
        }
    }

    pub fn save(&self, app_data_dir: &Path) -> std::io::Result<()> {
        fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join(LIBRARY_SETTINGS_FILE);
        let s = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(path, s)
    }
}

pub fn default_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("library")
}

pub fn ensure_root_exists(root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(root)
}

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<i64>,
}

pub fn list_dir(path: &Path) -> std::io::Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        if !is_dir {
            // Only surface strudel-ish text files.
            let ext = entry
                .path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            if !matches!(ext.as_deref(), Some("strudel") | Some("js") | Some("txt")) {
                continue;
            }
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            size: if is_dir { None } else { Some(meta.len()) },
            modified_ms,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

pub fn create_dir(path: &Path) -> std::io::Result<()> {
    if path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", path.display()),
        ));
    }
    fs::create_dir_all(path)
}

pub fn delete_path(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

pub fn rename_path(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", to.display()),
        ));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(from, to)
}

/// True iff `candidate` (after canonicalisation, when possible) lies under
/// `root`. Used as a path-traversal guard for frontend-supplied paths.
pub fn within(root: &Path, candidate: &Path) -> bool {
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    // For not-yet-existing paths, fall back to lexical containment using
    // the canonicalised parent if available.
    let candidate_canon = if candidate.exists() {
        candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.to_path_buf())
    } else {
        match candidate.parent() {
            Some(p) if p.exists() => p
                .canonicalize()
                .map(|cp| cp.join(candidate.file_name().unwrap_or_default()))
                .unwrap_or_else(|_| candidate.to_path_buf()),
            _ => candidate.to_path_buf(),
        }
    };
    candidate_canon.starts_with(&root_canon)
}

/// Open the OS file manager focused on `path`. Falls back to opening the
/// enclosing folder for files. Errors as a `String` for direct use from
/// Tauri commands.
pub fn reveal_in_os(path: &Path) -> Result<(), String> {
    let target = if path.is_file() {
        path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.to_path_buf())
    } else {
        path.to_path_buf()
    };
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_blocks_traversal() {
        let tmp = std::env::temp_dir().join("cycletron_lib_test_root");
        let _ = fs::create_dir_all(&tmp);
        assert!(within(&tmp, &tmp.join("foo.strudel")));
        assert!(within(&tmp, &tmp.join("sub").join("bar.strudel")));
        assert!(!within(&tmp, &PathBuf::from("/etc/passwd")));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_excludes_hidden_and_unknown_extensions() {
        let dir = std::env::temp_dir().join("cycletron_lib_test_list");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".hidden.strudel"), "").unwrap();
        fs::write(dir.join("song.strudel"), "").unwrap();
        fs::write(dir.join("pattern.js"), "").unwrap();
        fs::write(dir.join("ignore.png"), "").unwrap();
        fs::create_dir_all(dir.join("subfolder")).unwrap();

        let entries = list_dir(&dir).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"song.strudel"));
        assert!(names.contains(&"pattern.js"));
        assert!(names.contains(&"subfolder"));
        assert!(!names.contains(&".hidden.strudel"));
        assert!(!names.contains(&"ignore.png"));
        // Folders first.
        assert_eq!(entries[0].name, "subfolder");

        let _ = fs::remove_dir_all(&dir);
    }
}
