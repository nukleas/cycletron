//! Ship a solid starter library of demos into the user's library root.
//!
//! Called from [`crate::library::prepare_root`] whenever a library folder is
//! initialized — app startup for the configured root, and again if the user
//! picks a new root in the welcome wizard or Preferences.
//!
//! Content is embedded at compile time from:
//! - `ui/songs/**` — full tracks + Agency OST
//! - `corpus/{rhythm,melody,harmony,form,timbre,motion}/**` — curated techniques
//! - `corpus/genres/**/generated-*.strudel` — one playable sketch per genre
//!
//! Seeding is idempotent (marker file) and never overwrites files the user
//! already has, so re-running after an app upgrade only fills gaps.

use rust_embed::Embed;
use std::fs;
use std::path::Path;

const SEED_MARKER: &str = ".cycletron-demos-v1";
const DEMOS_DIR: &str = "Demos";

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../ui/songs"]
struct SongAssets;

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../corpus"]
struct CorpusAssets;

/// Ensure `library_root/Demos/` is populated. Safe to call on every launch.
pub fn seed_into_library(library_root: &Path) -> Result<SeedReport, String> {
    let demos = library_root.join(DEMOS_DIR);
    fs::create_dir_all(&demos).map_err(|e| format!("create Demos: {e}"))?;

    let marker = demos.join(SEED_MARKER);
    let first_seed = !marker.exists();

    let mut report = SeedReport::default();

    // Songs → Demos/Songs/… (preserve agency/ subfolder)
    for path in SongAssets::iter() {
        let rel = path.as_ref();
        if !rel.ends_with(".strudel") {
            continue;
        }
        // Skip nested README etc. already filtered by extension.
        let dest = demos.join("Songs").join(rel);
        if write_if_missing(
            &dest,
            SongAssets::get(rel).as_ref().map(|f| f.data.as_ref()),
        )? {
            report.written += 1;
        } else {
            report.skipped += 1;
        }
    }

    // Curated techniques → Demos/Techniques/{Category}/file.strudel
    const TECHNIQUE_DIRS: &[&str] = &["rhythm", "melody", "harmony", "form", "timbre", "motion"];
    for path in CorpusAssets::iter() {
        let rel = path.as_ref().replace('\\', "/");
        if !rel.ends_with(".strudel") {
            continue;
        }

        // Techniques: top-level category folders only.
        if let Some((cat, rest)) = rel.split_once('/')
            && TECHNIQUE_DIRS.contains(&cat)
            && !rest.contains('/')
        {
            let dest = demos
                .join("Techniques")
                .join(title_case_words(cat))
                .join(rest);
            if write_if_missing(
                &dest,
                CorpusAssets::get(path.as_ref())
                    .as_ref()
                    .map(|f| f.data.as_ref()),
            )? {
                report.written += 1;
            } else {
                report.skipped += 1;
            }
            continue;
        }

        // Genres: genres/<slug>/generated-*.strudel → Demos/Genres/<Title>.strudel
        if let Some(rest) = rel.strip_prefix("genres/") {
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() == 2
                && parts[1].starts_with("generated-")
                && parts[1].ends_with(".strudel")
            {
                let slug = parts[0];
                // Skip drafts / template dirs.
                if slug.starts_with('_') {
                    continue;
                }
                let dest = demos
                    .join("Genres")
                    .join(format!("{}.strudel", title_case_kebab(slug)));
                if write_if_missing(
                    &dest,
                    CorpusAssets::get(path.as_ref())
                        .as_ref()
                        .map(|f| f.data.as_ref()),
                )? {
                    report.written += 1;
                } else {
                    report.skipped += 1;
                }
            }
        }
    }

    // Friendly README once.
    let readme = demos.join("README.txt");
    if !readme.exists() {
        let text = "\
Cycletron demo library
======================

Songs/       Full tracks and covers (plus the Agency OST album).
Techniques/  Short curated patterns by musical idea (rhythm, melody, …).
Genres/      One playable sketch per genre recipe.

Open any file in the File Explorer, press Play (⌘↩), and remix.
These files were seeded for you — edit freely; Cycletron will not overwrite
existing files on upgrade (only fill missing ones).
";
        fs::write(&readme, text).map_err(|e| e.to_string())?;
        report.written += 1;
    }

    if first_seed || report.written > 0 {
        fs::write(&marker, b"v1\n").map_err(|e| e.to_string())?;
    }

    if report.written > 0 {
        tracing::info!(
            target: "cycletron::demos",
            written = report.written,
            skipped = report.skipped,
            path = %demos.display(),
            "seeded demo library"
        );
    }

    Ok(report)
}

#[derive(Debug, Default)]
pub struct SeedReport {
    pub written: usize,
    pub skipped: usize,
}

/// Materialize the embedded corpus into `dest`, mirroring the repo's `corpus/`
/// layout verbatim (category dirs, `genres/<slug>/…`, `lessons/`, …). The
/// on-disk corpus loader can then read it in a packaged build, where the
/// compile-time `corpus/` path isn't present on the user's machine.
///
/// Idempotent per app version: a `.corpus-version` marker skips the copy when
/// already current, and a version bump re-exports so the agent's knowledge
/// tracks the shipped release.
pub fn export_corpus_assets(dest: &Path) -> Result<(), String> {
    const VERSION: &str = env!("CARGO_PKG_VERSION");
    let marker = dest.join(".corpus-version");
    if fs::read_to_string(&marker).ok().as_deref() == Some(VERSION) {
        return Ok(());
    }
    for path in CorpusAssets::iter() {
        let rel = path.as_ref();
        let Some(file) = CorpusAssets::get(rel) else {
            continue;
        };
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&out, file.data.as_ref()).map_err(|e| format!("write {}: {e}", out.display()))?;
    }
    fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
    fs::write(&marker, VERSION).map_err(|e| format!("write {}: {e}", marker.display()))
}

fn write_if_missing(dest: &Path, data: Option<&[u8]>) -> Result<bool, String> {
    let Some(bytes) = data else {
        return Ok(false);
    };
    if dest.exists() {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(dest, bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(true)
}

fn title_case_kebab(s: &str) -> String {
    s.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_case_words(s: &str) -> String {
    title_case_kebab(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn title_case_kebab_basic() {
        assert_eq!(title_case_kebab("drum-and-bass"), "Drum And Bass");
        assert_eq!(title_case_kebab("rhythm"), "Rhythm");
    }

    #[test]
    fn export_corpus_writes_curated_tree() {
        let dir = env::temp_dir().join(format!("cycletron-corpus-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        export_corpus_assets(&dir).expect("export");
        // A migrated lesson + a curated technique category + a genre recipe.
        assert!(dir.join("lessons/01-first-steps.strudel").is_file());
        assert!(dir.join("rhythm").is_dir());
        assert!(dir.join(".corpus-version").is_file());
        // Second call is a no-op once the version marker is current.
        export_corpus_assets(&dir).expect("re-export noop");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_writes_demos_tree() {
        let dir = env::temp_dir().join(format!("cycletron-demos-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let report = seed_into_library(&dir).expect("seed");
        assert!(
            report.written > 50,
            "expected many demos, got {}",
            report.written
        );
        assert!(dir.join("Demos/Songs").is_dir());
        assert!(dir.join("Demos/Techniques").is_dir());
        assert!(dir.join("Demos/Genres").is_dir());
        assert!(dir.join("Demos").join(SEED_MARKER).is_file());
        // Second seed should not rewrite.
        let report2 = seed_into_library(&dir).expect("re-seed");
        assert_eq!(report2.written, 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
