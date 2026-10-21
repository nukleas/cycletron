//! Ship a solid starter library of demos into the user's library root.
//!
//! Called from [`crate::library::prepare_root`] whenever a library folder is
//! initialized — app startup for the configured root, and again if the user
//! picks a new root in the welcome wizard or Preferences.
//!
//! Content is embedded at compile time from:
//! - `ui/songs/**` — full tracks + Agency OST
//! - `ui/shows/*.show.toml` — show files playing those songs
//! - `corpus/{rhythm,melody,harmony,form,timbre,motion}/**` — curated techniques
//! - `corpus/genres/**/*.strudel` — generated skeletons + curated genre examples
//!
//! Each demo is written once (see [`Seeder`]) and never over a file the
//! user has, so an app upgrade only adds new demos.

use rust_embed::Embed;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// At the library root, beside `Demos/`, so it outlives that folder.
const SEED_LIST: &str = ".cycletron-demos";
const DEMOS_DIR: &str = "Demos";

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../ui/songs"]
struct SongAssets;

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../ui/shows"]
struct ShowAssets;

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../corpus"]
struct CorpusAssets;

/// Ensure `library_root/Demos/` is populated. Safe to call on every launch.
pub fn seed_into_library(library_root: &Path) -> Result<SeedReport, String> {
    let demos = library_root.join(DEMOS_DIR);
    let mut seeder = Seeder::new(library_root);

    // Songs → Demos/Songs/… (preserve agency/ subfolder)
    for path in SongAssets::iter() {
        let rel = path.as_ref();
        if !rel.ends_with(".strudel") {
            continue;
        }
        let dest = demos.join("Songs").join(rel);
        seeder.put(
            &dest,
            SongAssets::get(rel).as_ref().map(|f| f.data.as_ref()),
        )?;
    }

    // Shows → Demos/Shows/…; their `source` paths point into ../Songs.
    for path in ShowAssets::iter() {
        let rel = path.as_ref();
        if !rel.ends_with(".show.toml") {
            continue;
        }
        let dest = demos.join("Shows").join(rel);
        seeder.put(
            &dest,
            ShowAssets::get(rel).as_ref().map(|f| f.data.as_ref()),
        )?;
    }

    // Curated techniques → Demos/Techniques/{Category}/file.strudel
    const TECHNIQUE_DIRS: &[&str] = &["rhythm", "melody", "harmony", "form", "timbre", "motion"];
    for path in CorpusAssets::iter() {
        let rel = path.as_ref().replace('\\', "/");
        if !rel.ends_with(".strudel") {
            continue;
        }

        // Staging dirs stay out of the shipped library.
        if cycletron_corpus::layout::is_underscore_hidden(std::path::Path::new(&rel)) {
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
            seeder.put(
                &dest,
                CorpusAssets::get(path.as_ref())
                    .as_ref()
                    .map(|f| f.data.as_ref()),
            )?;
            continue;
        }

        // Genres: keep the original flat generated skeleton for compatibility,
        // then place additional curated examples in a per-genre folder.
        if let Some(rest) = rel.strip_prefix("genres/") {
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() == 2 && parts[1].ends_with(".strudel") {
                let slug = parts[0];
                // Skip drafts / template dirs.
                if slug.starts_with('_') {
                    continue;
                }
                let filename = parts[1];
                let dest = if filename.starts_with("generated-") {
                    demos
                        .join("Genres")
                        .join(format!("{}.strudel", title_case_kebab(slug)))
                } else {
                    let example = filename
                        .trim_end_matches(".strudel")
                        .strip_prefix("example-")
                        .unwrap_or_else(|| filename.trim_end_matches(".strudel"));
                    demos
                        .join("Genres")
                        .join(title_case_kebab(slug))
                        .join(format!("{}.strudel", title_case_kebab(example)))
                };
                seeder.put(
                    &dest,
                    CorpusAssets::get(path.as_ref())
                        .as_ref()
                        .map(|f| f.data.as_ref()),
                )?;
            }
        }
    }

    // Friendly README once.
    let text = "\
Cycletron demo library
======================

Songs/       Full tracks and covers (plus the Agency OST album).
Shows/       Show files: songs played as music videos. agency-ost plays the
             album, feature-tour uses every setting, cycletron-trailer is
             the trailer.
Techniques/  Short curated patterns by musical idea (rhythm, melody, …).
Genres/      Generated skeletons plus concise, curated genre examples.

Open any file in the File Explorer, press Play (⌘↩), and remix.
Edit them freely. Cycletron never overwrites your files, and a demo you
delete stays deleted; upgrades only add new demos.
";
    seeder.put(&demos.join("README.txt"), Some(text.as_bytes()))?;

    let report = seeder.finish()?;

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
        let rel_unix = rel.replace('\\', "/");
        if cycletron_corpus::layout::is_underscore_hidden(std::path::Path::new(&rel_unix)) {
            continue;
        }
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

/// Writes each demo once. The library root's seed list records what was
/// seeded, so a demo the user deletes, or the whole `Demos/` folder, stays
/// deleted; only demos new in a later version are added.
struct Seeder {
    root: PathBuf,
    list: PathBuf,
    seeded: BTreeSet<String>,
    added: bool,
    report: SeedReport,
}

impl Seeder {
    fn new(root: &Path) -> Self {
        let list = root.join(SEED_LIST);
        let seeded = fs::read_to_string(&list)
            .map(|text| text.lines().map(str::to_string).collect())
            .unwrap_or_default();
        Self {
            root: root.to_path_buf(),
            list,
            seeded,
            added: false,
            report: SeedReport::default(),
        }
    }

    /// Write `data` to `dest`, unless it was seeded before or a file is already there.
    fn put(&mut self, dest: &Path, data: Option<&[u8]>) -> Result<(), String> {
        let Some(bytes) = data else {
            return Ok(());
        };
        let key = dest
            .strip_prefix(&self.root)
            .unwrap_or(dest)
            .to_string_lossy()
            .replace('\\', "/");
        if self.seeded.contains(&key) || dest.exists() {
            self.report.skipped += 1;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            fs::write(dest, bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
            self.report.written += 1;
        }
        self.added |= self.seeded.insert(key);
        Ok(())
    }

    fn finish(self) -> Result<SeedReport, String> {
        if self.added {
            let mut text = self.seeded.into_iter().collect::<Vec<_>>().join("\n");
            text.push('\n');
            fs::write(&self.list, text)
                .map_err(|e| format!("write {}: {e}", self.list.display()))?;
        }
        Ok(self.report)
    }
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
        assert!(dir.join("Demos/Shows/agency-ost.show.toml").is_file());
        assert!(dir.join("Demos/Techniques").is_dir());
        assert!(dir.join("Demos/Genres").is_dir());
        assert!(
            dir.join("Demos/Genres/Acid House/Warehouse Squelch.strudel")
                .is_file()
        );
        assert!(dir.join(SEED_LIST).is_file());
        // Second seed should not rewrite.
        let report2 = seed_into_library(&dir).expect("re-seed");
        assert_eq!(report2.written, 0);
        // Deleted demos stay deleted.
        fs::remove_dir_all(dir.join("Demos")).unwrap();
        let report3 = seed_into_library(&dir).expect("seed after delete");
        assert_eq!(report3.written, 0);
        assert!(!dir.join("Demos").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
