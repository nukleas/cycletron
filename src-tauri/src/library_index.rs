//! Read-only index of the user's own saved songs — the "know my catalog" layer
//! behind the agent's `list_library` / `search_library` / `read_song` tools.
//!
//! It scans the library root (recursively, `.strudel`/`.js` only), reads each
//! file's frontmatter (`name`/`bpm`/`tags`/`created`) plus a light scan for the
//! sounds it uses and its tempo, and exposes a small searchable list. Built fresh
//! on every call rather than cached in `AppState`: the library changes out from
//! under us (the user saves files, external editors touch them), and a
//! read-once-at-startup cache is exactly the staleness trap the recipe loader
//! fell into. A few dozen small text files scan in microseconds — no cache needed.
//!
//! Everything here is READ-ONLY and confined to the library root: [`read_song`]
//! rejects any path that resolves outside it (after symlink canonicalisation),
//! reusing [`crate::library::within`]. The agent cannot write, move, or delete.

use crate::files;
use serde::Serialize;
use std::path::Path;

/// A song is text; refuse to index or read anything larger. Guards against a
/// library root pointed at a code repo (soundfont `.js` blobs run into MBs and
/// would blow the agent's context if `read_song` returned one).
const MAX_SONG_BYTES: u64 = 256 * 1024;

/// Directories that are never a song library — skipped during the walk so a root
/// that happens to be a code checkout doesn't drown the index in engine sources,
/// vendored samples, and build output. (Dotdirs like `.git` are skipped anyway.)
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "pkg",
    "build",
    "coverage",
    "_reference",
    "dirt-samples",
    "samples",
    "soundfonts",
    "webaudiofontdata",
];

/// Backstop on total files indexed, so a pathological tree can't hang a call.
const MAX_INDEXED: usize = 3000;

/// Per-turn egress ceiling: at most this many `read_song` calls and this many
/// bytes of library content may be sent to the model in one user turn, so a
/// broad library root can't be quietly dumped to a cloud provider.
pub const MAX_READ_FILES_PER_TURN: usize = 8;
pub const MAX_READ_BYTES_PER_TURN: usize = 256 * 1024;

/// Does this text look like a strudel pattern (vs arbitrary JS / config / notes)?
/// `.js` is a generic extension, so we require pattern markers before treating a
/// `.js` file as a song — that keeps non-song code and secrets out of the index
/// and off the wire. `.strudel` is a deliberate extension and is trusted.
fn looks_like_pattern(code: &str) -> bool {
    let head = &code[..code.len().min(4096)];
    [
        "s(", "note(", "n(", "stack(", "setbpm", "setcpm", "$:", "sound(", ".s(", "chord(",
    ]
    .iter()
    .any(|m| head.contains(m))
}

fn is_js(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("js"))
        .unwrap_or(false)
}

/// If the library root looks like a code project or an over-broad directory,
/// return a one-line caution for the agent to relay. `None` = looks fine.
pub fn root_warning(root: &Path) -> Option<String> {
    for marker in ["Cargo.toml", "package.json", ".git", "node_modules"] {
        if root.join(marker).exists() {
            return Some(format!(
                "⚠ Your library root ({}) looks like a code project (found {marker}), not a music \
                 folder — the agent can read files here. Consider pointing the library at just your \
                 songs (File Explorer root).",
                root.display()
            ));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        if root == Path::new(&home) {
            return Some(
                "⚠ Your library root is your home directory — that's very broad. Point it at a \
                 songs folder so the agent only sees your music."
                    .to_string(),
            );
        }
    }
    None
}

/// One saved song, as the agent sees it.
#[derive(Debug, Clone, Serialize)]
pub struct LibrarySong {
    /// Path relative to the library root — the stable handle for `read_song`.
    pub rel_path: String,
    /// Frontmatter name, else the file stem.
    pub name: String,
    /// Tempo: frontmatter `bpm`, else the first `setbpm/setcpm` in the code.
    pub bpm: Option<f64>,
    pub tags: Vec<String>,
    pub created: Option<String>,
    /// Distinct sound/sample names the song plays (light source scan).
    pub sounds: Vec<String>,
    /// First code line, for a glanceable preview.
    pub preview: String,
    pub modified_ms: Option<i64>,
}

/// Filters for [`LibraryIndex::search`]. All are optional and AND together
/// (except `keyword`, which is a broad substring across name/tags/path/sounds).
#[derive(Debug, Default)]
pub struct LibraryQuery {
    pub keyword: Option<String>,
    pub tag: Option<String>,
    pub sound: Option<String>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    pub limit: Option<usize>,
}

pub struct LibraryIndex {
    pub songs: Vec<LibrarySong>,
}

impl LibraryIndex {
    /// Scan the library root into an index (newest song first).
    pub fn build(root: &Path) -> Self {
        let mut songs = Vec::new();
        if root.is_dir() {
            walk(root, root, 0, &mut songs);
        }
        songs.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        LibraryIndex { songs }
    }

    /// Filter the index. Curated-corpus-style substring matching (no ranking) —
    /// the catalog is small, so first-N-that-match in newest-first order is fine.
    pub fn search(&self, q: &LibraryQuery) -> Vec<&LibrarySong> {
        let kw = q.keyword.as_ref().map(|s| s.to_ascii_lowercase());
        let tag = q.tag.as_ref().map(|s| s.to_ascii_lowercase());
        let snd = q.sound.as_ref().map(|s| s.to_ascii_lowercase());
        self.songs
            .iter()
            .filter(|s| {
                kw.as_ref().is_none_or(|k| song_matches_keyword(s, k))
                    && tag
                        .as_ref()
                        .is_none_or(|t| s.tags.iter().any(|x| x.to_ascii_lowercase().contains(t)))
                    && snd.as_ref().is_none_or(|sn| {
                        s.sounds.iter().any(|x| x.to_ascii_lowercase().contains(sn))
                    })
                    && q.bpm_min.is_none_or(|lo| s.bpm.is_some_and(|b| b >= lo))
                    && q.bpm_max.is_none_or(|hi| s.bpm.is_some_and(|b| b <= hi))
            })
            .take(q.limit.unwrap_or(usize::MAX))
            .collect()
    }
}

fn song_matches_keyword(s: &LibrarySong, k: &str) -> bool {
    s.name.to_ascii_lowercase().contains(k)
        || s.rel_path.to_ascii_lowercase().contains(k)
        || s.tags.iter().any(|t| t.to_ascii_lowercase().contains(k))
        || s.sounds.iter().any(|x| x.to_ascii_lowercase().contains(k))
}

/// Recursively collect songs, capping depth so a symlink loop can't run away and
/// skipping code/asset directories + oversized files so a code-repo root doesn't
/// flood the index (or hand the agent a multi-MB soundfont as a "song").
fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<LibrarySong>) {
    if depth > 8 || out.len() >= MAX_INDEXED {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_INDEXED {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // dotfiles / .tmp / hidden + VCS dirs
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d)) {
                continue;
            }
            walk(root, &path, depth + 1, out);
        } else if is_song(&path) && meta.len() <= MAX_SONG_BYTES {
            if let Some(song) = read_song_meta(root, &path, &meta) {
                out.push(song);
            }
        }
    }
}

fn is_song(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("strudel") | Some("js")
    )
}

fn read_song_meta(root: &Path, path: &Path, meta: &std::fs::Metadata) -> Option<LibrarySong> {
    let doc = files::read_file(path).ok()?;
    // A `.js` file must look like a strudel pattern to count as a song — keeps
    // arbitrary JavaScript (and anything sensitive in it) out of the index.
    if is_js(path) && !looks_like_pattern(&doc.code) {
        return None;
    }
    let fm = doc.frontmatter.unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let rel_path = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);

    Some(LibrarySong {
        name: fm.name.filter(|n| !n.trim().is_empty()).unwrap_or(stem),
        bpm: fm.bpm.or_else(|| scan_bpm(&doc.code)),
        tags: fm.tags,
        created: fm.created,
        sounds: scan_sounds(&doc.code),
        preview: first_code_line(&doc.code),
        modified_ms,
        rel_path,
    })
}

/// First non-comment, non-blank line of the code (mute sentinel stripped), clipped.
fn first_code_line(code: &str) -> String {
    for line in code.lines() {
        let t = line.trim().trim_start_matches("//@mute ").trim();
        if t.is_empty() || t.starts_with("//") || t.starts_with("setbpm") || t.starts_with("setcpm")
        {
            continue;
        }
        return t.chars().take(100).collect();
    }
    String::new()
}

/// Best-effort tempo from `setbpm(N)` / `setcpm(N)` when frontmatter has none.
use cycletron_core::text::tempo::scan_bpm;

/// Distinct sound names used, from `s("…")` / `.s("…")` / `.sound("…")`. Strips
/// mini-notation ornaments (`*4`, `:2`, `(3,8)`, `~`) down to bare names.
fn scan_sounds(code: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = code.as_bytes();
    for pat in [".s(\"", " s(\"", "\ns(\"", ".sound(\"", "(s(\""] {
        let mut from = 0;
        while let Some(rel) = code[from..].find(pat) {
            let start = from + rel + pat.len();
            if let Some(len) = code[start..].find('"') {
                for tok in code[start..start + len].split_whitespace() {
                    let bare: String = tok
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                        .collect();
                    if !bare.is_empty() && !out.iter().any(|e| e == &bare) {
                        out.push(bare);
                    }
                }
                from = start + len;
            } else {
                break;
            }
        }
    }
    let _ = bytes;
    out.sort();
    out
}

/// Resolve a caller-supplied path (relative to the library root, or absolute)
/// and READ it — but only if it stays inside the root. Returns the file's code.
/// This is the single choke point for `read_song`; it never writes.
pub fn read_song(root: &Path, requested: &str) -> Result<files::FileDoc, String> {
    let candidate = {
        let p = Path::new(requested);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    };
    if !crate::library::within(root, &candidate) {
        return Err(format!(
            "'{requested}' is outside the library — read_song only reaches songs in your library."
        ));
    }
    if !is_song(&candidate) {
        return Err(format!("'{requested}' is not a .strudel/.js song file."));
    }
    // Refuse oversized files: a real song is small; anything this large is a data
    // blob (a soundfont, a bundle) and would blow the agent's context if returned.
    if let Ok(meta) = std::fs::metadata(&candidate) {
        if meta.len() > MAX_SONG_BYTES {
            return Err(format!(
                "'{requested}' is {} KB — too large to be a song (limit {} KB). Skipping.",
                meta.len() / 1024,
                MAX_SONG_BYTES / 1024
            ));
        }
    }
    let doc =
        files::read_file(&candidate).map_err(|e| format!("could not read '{requested}': {e}"))?;
    if is_js(&candidate) && !looks_like_pattern(&doc.code) {
        return Err(format!(
            "'{requested}' is a .js file but doesn't look like a strudel pattern — skipping."
        ));
    }
    Ok(doc)
}

// --- Writes (Tier B) ---------------------------------------------------------
// Optimistic + reversible: every write is confined to the library root, and
// every overwrite snapshots the prior content first (the same "Git lite" the
// normal save uses), so nothing the agent does is unrecoverable. No delete.

/// Resolve a caller path (relative to root, or absolute) and confirm it stays
/// inside the library. The single guard every write goes through.
fn resolve_in_root(root: &Path, requested: &str) -> Result<std::path::PathBuf, String> {
    let requested = requested.trim().trim_start_matches('@');
    if requested.is_empty() {
        return Err("empty path".to_string());
    }
    let p = Path::new(requested);
    let candidate = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    };
    if !crate::library::within(root, &candidate) {
        return Err(format!(
            "'{requested}' is outside your library — writes stay inside it."
        ));
    }
    Ok(candidate)
}

fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

/// Filename-safe slug: lowercase, non-alphanumerics collapsed to `-`, trimmed.
use cycletron_core::text::slug::slugify;

/// Frontmatter for a named save (created today), preserving a detected tempo.
fn with_frontmatter(name: &str, code: &str) -> String {
    // If the code already carries frontmatter, don't double it.
    if code.trim_start().starts_with("---") {
        return code.to_string();
    }
    let bpm_line = scan_bpm(code)
        .map(|b| format!("bpm: {b:.0}\n"))
        .unwrap_or_default();
    let date = chrono::Utc::now().format("%Y-%m-%d");
    format!(
        "---\nname: \"{}\"\n{bpm_line}created: {date}\ntags: [cycletron]\n---\n{code}",
        name.replace('"', "'")
    )
}

/// Save `code` as a named song in the library (optionally in `folder`). Overwrite
/// is allowed but snapshots the prior content first. Returns the saved rel_path.
pub fn save_song(
    root: &Path,
    app_data_dir: Option<&Path>,
    name: &str,
    code: &str,
    folder: Option<&str>,
) -> Result<String, String> {
    if code.trim().is_empty() {
        return Err("nothing to save — the code is empty".to_string());
    }
    let dir = match folder {
        Some(f) if !f.trim().is_empty() => resolve_in_root(root, f)?,
        _ => root.to_path_buf(),
    };
    let target = dir.join(format!("{}.strudel", slugify(name)));
    if !crate::library::within(root, &target) {
        return Err("resolved path escapes the library".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;

    // Snapshot the existing content before overwriting, so it's recoverable.
    if let (Some(app_dir), Ok(existing)) = (app_data_dir, std::fs::read_to_string(&target)) {
        crate::snapshots::record(app_dir, &target, &existing);
    }
    std::fs::write(&target, with_frontmatter(name, code)).map_err(|e| format!("write: {e}"))?;
    if let Some(app_dir) = app_data_dir {
        crate::snapshots::record(app_dir, &target, code);
    }
    Ok(rel_of(root, &target))
}

/// Rename a song in place (keeps its folder + `.strudel` extension). Won't clobber.
pub fn rename_song(root: &Path, from: &str, new_name: &str) -> Result<String, String> {
    let src = resolve_in_root(root, from)?;
    if !src.is_file() {
        return Err(format!("no song at '{from}'"));
    }
    let dst = src.with_file_name(format!("{}.strudel", slugify(new_name)));
    if !crate::library::within(root, &dst) {
        return Err("destination escapes the library".to_string());
    }
    if dst.exists() {
        return Err(format!(
            "'{}' already exists — pick another name",
            rel_of(root, &dst)
        ));
    }
    crate::library::rename_path(&src, &dst).map_err(|e| format!("rename: {e}"))?;
    Ok(rel_of(root, &dst))
}

/// Move a song into `dest_folder` (created if needed). Won't clobber.
pub fn move_song(root: &Path, from: &str, dest_folder: &str) -> Result<String, String> {
    let src = resolve_in_root(root, from)?;
    if !src.is_file() {
        return Err(format!("no song at '{from}'"));
    }
    let dir = resolve_in_root(root, dest_folder)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let name = src.file_name().ok_or("bad source name")?;
    let dst = dir.join(name);
    if !crate::library::within(root, &dst) {
        return Err("destination escapes the library".to_string());
    }
    if dst.exists() {
        return Err(format!("'{}' already exists there", rel_of(root, &dst)));
    }
    crate::library::rename_path(&src, &dst).map_err(|e| format!("move: {e}"))?;
    Ok(rel_of(root, &dst))
}

/// Create a folder in the library.
pub fn create_folder(root: &Path, rel: &str) -> Result<String, String> {
    let dir = resolve_in_root(root, rel)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(rel_of(root, &dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_sounds_and_bpm() {
        let code =
            "setbpm(128)\nstack(\n  s(\"bd*4 hh*8\").gain(0.9),\n  note(\"a2\").s(\"sawtooth\")\n)";
        assert_eq!(scan_bpm(code), Some(128.0));
        let s = scan_sounds(code);
        assert!(s.contains(&"bd".to_string()) && s.contains(&"hh".to_string()));
        assert!(s.contains(&"sawtooth".to_string()));
    }

    #[test]
    fn setcpm_converts_to_bpm() {
        assert_eq!(scan_bpm("setcpm(30)\ns(\"bd\")"), Some(120.0));
    }

    #[test]
    fn search_filters_by_bpm_and_keyword() {
        let idx = LibraryIndex {
            songs: vec![
                LibrarySong {
                    rel_path: "acid.strudel".into(),
                    name: "Acid Trip".into(),
                    bpm: Some(130.0),
                    tags: vec!["acid".into()],
                    created: None,
                    sounds: vec!["303".into()],
                    preview: String::new(),
                    modified_ms: Some(2),
                },
                LibrarySong {
                    rel_path: "dub.strudel".into(),
                    name: "Deep Dub".into(),
                    bpm: Some(70.0),
                    tags: vec!["dub".into()],
                    created: None,
                    sounds: vec!["bd".into()],
                    preview: String::new(),
                    modified_ms: Some(1),
                },
            ],
        };
        let fast = idx.search(&LibraryQuery {
            bpm_min: Some(120.0),
            ..Default::default()
        });
        assert_eq!(fast.len(), 1);
        assert_eq!(fast[0].name, "Acid Trip");
        let kw = idx.search(&LibraryQuery {
            keyword: Some("dub".into()),
            ..Default::default()
        });
        assert_eq!(kw.len(), 1);
        assert_eq!(kw[0].name, "Deep Dub");
    }

    #[test]
    fn build_walks_subdirs_and_read_song_is_sandboxed() {
        // A temp library with a top-level song and one in a subfolder.
        let root = std::env::temp_dir().join("cycletron-libidx-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Demos")).unwrap();
        std::fs::write(
            root.join("acid.strudel"),
            "---\nname: \"Acid\"\nbpm: 130\ntags: [acid]\n---\ns(\"bd*4\").gain(0.9)",
        )
        .unwrap();
        std::fs::write(
            root.join("Demos/dub.strudel"),
            "setbpm(70)\nnote(\"c2\").s(\"sine\")",
        )
        .unwrap();

        let idx = LibraryIndex::build(&root);
        assert_eq!(idx.songs.len(), 2, "should find songs in root and subdir");
        assert!(idx.songs.iter().any(|s| s.rel_path == "Demos/dub.strudel"));

        // In-library read works…
        assert!(read_song(&root, "acid.strudel").is_ok());
        assert!(read_song(&root, "Demos/dub.strudel").is_ok());
        // …but traversal outside the root is rejected.
        assert!(read_song(&root, "../../../etc/passwd").is_err());
        assert!(read_song(&root, "/etc/passwd").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_skips_code_dirs_and_oversized_files() {
        let root = std::env::temp_dir().join("cycletron-libidx-noise-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("_reference/sound")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("songs")).unwrap();
        // a real song, an engine source under _reference, a vendored .js, and a huge blob
        std::fs::write(root.join("songs/real.strudel"), "s(\"bd*4\")").unwrap();
        std::fs::write(root.join("_reference/sound/font.js"), "export const x = 1").unwrap();
        std::fs::write(root.join("node_modules/lib.js"), "module.exports={}").unwrap();
        std::fs::write(
            root.join("huge.strudel"),
            "x".repeat((MAX_SONG_BYTES + 1) as usize),
        )
        .unwrap();

        let idx = LibraryIndex::build(&root);
        let paths: Vec<&str> = idx.songs.iter().map(|s| s.rel_path.as_str()).collect();
        assert_eq!(idx.songs.len(), 1, "only the real song, got: {paths:?}");
        assert_eq!(paths[0], "songs/real.strudel");

        // read_song refuses the oversized file even if addressed directly.
        assert!(read_song(&root, "huge.strudel").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn js_must_look_like_a_pattern_and_root_warns_on_code_repos() {
        let root = std::env::temp_dir().join("cycletron-libidx-sniff-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("groove.js"), "stack(s(\"bd*4\"), note(\"c2\"))").unwrap();
        std::fs::write(
            root.join("config.js"),
            "export default { apiKey: 'secret' }",
        )
        .unwrap();
        std::fs::write(root.join("real.strudel"), "s(\"hh*8\")").unwrap();

        let idx = LibraryIndex::build(&root);
        let paths: Vec<&str> = idx.songs.iter().map(|s| s.rel_path.as_str()).collect();
        assert!(
            paths.contains(&"groove.js"),
            "pattern-like .js is a song: {paths:?}"
        );
        assert!(
            !paths.contains(&"config.js"),
            "arbitrary .js is NOT a song: {paths:?}"
        );
        assert!(paths.contains(&"real.strudel"));
        // read_song refuses the non-pattern .js even if addressed directly.
        assert!(read_song(&root, "config.js").is_err());
        assert!(read_song(&root, "groove.js").is_ok());

        // no code markers → clean root, no warning.
        assert!(root_warning(&root).is_none());
        // a code marker → warning.
        std::fs::write(root.join("Cargo.toml"), "[package]").unwrap();
        assert!(root_warning(&root).is_some());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn writes_are_named_sandboxed_and_non_clobbering() {
        let root = std::env::temp_dir().join("cycletron-libidx-write-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // save round-trips with a slugified filename + frontmatter name.
        let rel = save_song(
            &root,
            None,
            "Midnight Dub!",
            "setbpm(70)\ns(\"bd*4\")",
            None,
        )
        .unwrap();
        assert_eq!(rel, "midnight-dub.strudel");
        let doc = read_song(&root, &rel).unwrap();
        assert_eq!(
            doc.frontmatter.unwrap().name.as_deref(),
            Some("Midnight Dub!")
        );
        assert!(doc.code.contains("bd*4"));

        // save into a folder.
        let rel2 = save_song(&root, None, "Sketch", "s(\"hh*8\")", Some("ideas")).unwrap();
        assert_eq!(rel2, "ideas/sketch.strudel");

        // rename won't clobber an existing name.
        save_song(&root, None, "taken", "s(\"cp\")", None).unwrap();
        assert!(rename_song(&root, "midnight-dub.strudel", "taken").is_err());
        let renamed = rename_song(&root, "midnight-dub.strudel", "Night Dub").unwrap();
        assert_eq!(renamed, "night-dub.strudel");

        // move into a folder.
        let moved = move_song(&root, "night-dub.strudel", "archive").unwrap();
        assert_eq!(moved, "archive/night-dub.strudel");

        // every write refuses to escape the root.
        assert!(save_song(&root, None, "x", "s(\"bd\")", Some("../../tmp")).is_err());
        assert!(rename_song(&root, "../../secret", "x").is_err());
        assert!(create_folder(&root, "../escape").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
