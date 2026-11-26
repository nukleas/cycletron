//! `cycletron parts index` and `cycletron parts apply`: review saved parts in
//! bulk.
//!
//! `index` writes the parts that have no rating yet as JSON lines, in shards a
//! reviewer can take one at a time. `apply` reads verdicts back (a title, tags
//! and a rating from 1 to 5 for each part) and writes them into the part
//! headers. A part rated 1 is moved out of the shelf to `_parts-rejected/`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::library_index::PARTS_DIR;
use cycletron_core::text::frontmatter;

/// Folder next to `Parts/` that takes the parts rated 1.
pub const REJECTED_DIR: &str = "_parts-rejected";
const DEFAULT_SHARD: usize = 150;
const MAX_TITLE: usize = 40;
const MAX_TAGS: usize = 4;
/// Header lines `apply` writes itself.
const OWNED: [&str; 5] = ["name", "song", "tags", "rating", "rated_by"];

pub enum Job {
    Index {
        out: PathBuf,
        per_shard: usize,
        collections: Vec<String>,
        /// Include parts that already have a rating.
        all: bool,
    },
    Apply {
        verdicts: Vec<PathBuf>,
        /// Who gave the verdicts, recorded in each header.
        by: String,
    },
}

pub struct Flags {
    pub job: Job,
    /// Library root. Defaults to the app's library.
    pub library: Option<PathBuf>,
}

/// `args` starts after `index` or `apply`.
pub fn parse(verb: &str, args: &[String]) -> Result<Flags, String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut library = None;
    let mut per_shard = DEFAULT_SHARD;
    let mut collections = Vec::new();
    let mut all = false;
    let mut by = String::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--library" => library = Some(it.next().ok_or("--library needs a folder")?.into()),
            "--per" if verb == "index" => {
                per_shard = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n: &usize| *n > 0)
                    .ok_or("--per needs a positive whole number")?;
            }
            "--collection" if verb == "index" => {
                collections.push(it.next().ok_or("--collection needs a name")?.clone());
            }
            "--all" if verb == "index" => all = true,
            "--by" if verb == "apply" => by = it.next().ok_or("--by needs a name")?.clone(),
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}")),
            _ => paths.push(arg.into()),
        }
    }
    let job = if verb == "index" {
        let [out] = paths.as_slice() else {
            return Err("parts index needs one output folder".into());
        };
        Job::Index {
            out: out.clone(),
            per_shard,
            collections,
            all,
        }
    } else {
        if paths.is_empty() {
            return Err("parts apply needs a verdicts file".into());
        }
        if by.trim().is_empty() {
            return Err("parts apply needs --by <who gave the verdicts>".into());
        }
        Job::Apply {
            verdicts: paths,
            by,
        }
    };
    Ok(Flags { job, library })
}

pub fn run(flags: &Flags, library_root: &Path) -> Result<(), String> {
    let root = flags.library.as_deref().unwrap_or(library_root);
    match &flags.job {
        Job::Index {
            out,
            per_shard,
            collections,
            all,
        } => index(root, out, *per_shard, collections, *all),
        Job::Apply { verdicts, by } => apply(root, verdicts, by),
    }
}

/// One part as a reviewer sees it. `id` is the path under `Parts/`.
#[derive(Serialize)]
struct Entry {
    id: String,
    role: String,
    name: String,
    bpm: Option<f64>,
    bars: Option<usize>,
    key: Option<String>,
    code: String,
}

fn index(
    root: &Path,
    out: &Path,
    per_shard: usize,
    collections: &[String],
    all: bool,
) -> Result<(), String> {
    let parts_dir = root.join(PARTS_DIR);
    let mut entries: Vec<Entry> = crate::parts_import::list_saved(root)
        .into_iter()
        .filter(|p| all || p.rating.is_none())
        .filter(|p| {
            collections.is_empty()
                || p.collection
                    .as_ref()
                    .is_some_and(|c| collections.contains(c))
        })
        .filter_map(|p| {
            let id = Path::new(&p.path).strip_prefix(&parts_dir).ok()?;
            Some(Entry {
                id: id.to_string_lossy().replace('\\', "/"),
                role: p.role,
                name: p.name,
                bpm: p.bpm,
                bars: p.bars,
                key: p.key,
                code: p.code.trim().to_string(),
            })
        })
        .collect();
    entries.sort_by(|a, b| (&a.role, &a.id).cmp(&(&b.role, &b.id)));

    std::fs::create_dir_all(out).map_err(|e| format!("mkdir {}: {e}", out.display()))?;
    let shards = entries.chunks(per_shard);
    let count = shards.len();
    for (n, shard) in shards.enumerate() {
        let path = out.join(format!("shard-{:03}.jsonl", n + 1));
        let mut file =
            std::fs::File::create(&path).map_err(|e| format!("write {}: {e}", path.display()))?;
        for entry in shard {
            let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
            writeln!(file, "{line}").map_err(|e| format!("write {}: {e}", path.display()))?;
        }
    }
    println!(
        "{} part(s) in {count} shard(s) written to {}",
        entries.len(),
        out.display()
    );
    Ok(())
}

#[derive(Deserialize)]
struct Verdict {
    id: String,
    title: String,
    #[serde(default)]
    tags: Vec<String>,
    rating: u8,
}

fn apply(root: &Path, files: &[PathBuf], by: &str) -> Result<(), String> {
    let parts_dir = root.join(PARTS_DIR);
    let canon_parts_dir = parts_dir.canonicalize().ok();
    let (mut written, mut rejected, mut skipped) = (0, 0, 0);
    for file in files {
        let text =
            std::fs::read_to_string(file).map_err(|e| format!("read {}: {e}", file.display()))?;
        for (n, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let verdict = serde_json::from_str::<Verdict>(line).ok().and_then(checked);
            let Some(verdict) = verdict else {
                eprintln!("skip {}:{}: not a usable verdict", file.display(), n + 1);
                skipped += 1;
                continue;
            };
            let path = parts_dir.join(&verdict.id);
            // The id comes from a file someone else wrote: stay inside Parts/ and
            // derive the relative path from the canonicalized file so rejected moves
            // always land inside REJECTED_DIR.
            let rel_inside = canon_parts_dir
                .as_ref()
                .zip(path.canonicalize().ok())
                .and_then(|(dir, p)| {
                    let rel = p.strip_prefix(dir).ok()?.to_path_buf();
                    (!rel.as_os_str().is_empty()).then_some((p, rel))
                });
            let Some((canon_path, rel)) = rel_inside else {
                eprintln!("skip {}: no such part", verdict.id);
                skipped += 1;
                continue;
            };
            let Ok(raw) = std::fs::read_to_string(&canon_path) else {
                eprintln!("skip {}: no such part", verdict.id);
                skipped += 1;
                continue;
            };
            let text = rewrite(&raw, &verdict, by);
            crate::files::write_text(&canon_path, &text)
                .map_err(|e| format!("write {}: {e}", canon_path.display()))?;
            written += 1;
            if verdict.rating == 1 {
                let dest = root.join(REJECTED_DIR).join(&rel);
                if let Some(dir) = dest.parent() {
                    std::fs::create_dir_all(dir)
                        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
                }
                std::fs::rename(&canon_path, &dest)
                    .map_err(|e| format!("move {}: {e}", canon_path.display()))?;
                rejected += 1;
            }
        }
    }
    println!(
        "{written} part(s) updated, {rejected} of them moved to {REJECTED_DIR}, {skipped} verdict(s) skipped"
    );
    Ok(())
}

/// A verdict with a sane title, rating and tags, or nothing.
fn checked(mut verdict: Verdict) -> Option<Verdict> {
    verdict.title = verdict.title.trim().to_string();
    let title_ok = !verdict.title.is_empty() && verdict.title.chars().count() <= MAX_TITLE;
    if !title_ok || !(1..=5).contains(&verdict.rating) {
        return None;
    }
    verdict.tags.retain(|t| {
        !t.is_empty()
            && t.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    });
    verdict.tags.truncate(MAX_TAGS);
    Some(verdict)
}

/// The part file with the verdict in its header. The name it had before its
/// first review is kept as `song`.
fn rewrite(raw: &str, verdict: &Verdict, by: &str) -> String {
    let (yaml, code) = frontmatter::split(raw);
    let fm = yaml.map(frontmatter::parse).unwrap_or_default();
    let song = fm.scalar("song").or_else(|| fm.scalar("name"));
    // What the file says it is, without the tags an earlier review added.
    let base: Vec<String> = ["role", "collection"]
        .iter()
        .filter_map(|key| fm.scalar(key))
        .collect();

    let mut head = vec![format!("name: {}", quote(&verdict.title))];
    if let Some(song) = song {
        head.push(format!("song: {}", quote(&song)));
    }
    let tags: Vec<&str> = std::iter::once("part")
        .chain(base.iter().map(String::as_str))
        .chain(verdict.tags.iter().map(String::as_str))
        .collect();
    head.push(format!("tags: [{}]", tags.join(", ")));
    head.push(format!("rating: {}", verdict.rating));
    head.push(format!("rated_by: {}", quote(by)));
    let kept = yaml.unwrap_or_default().lines().filter(|line| {
        let key = line.split(':').next().unwrap_or_default();
        !OWNED.contains(&key) && !line.trim().is_empty()
    });
    head.extend(kept.map(str::to_string));
    format!("---\n{}\n---\n{code}", head.join("\n"))
}

fn quote(s: &str) -> String {
    crate::parts_import::quote(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PART: &str = "---\nname: \"arena rock · 30\"\nbpm: 120\ntags: [part, lead, demo]\nrole: lead\nbars: 2\ncollection: \"demo\"\nlicense: \"CC0-1.0\"\n---\nnote(\"c4 e4 g4\")\n";

    fn library() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Parts/lead/demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.strudel"), PART).unwrap();
        std::fs::write(dir.join("b.strudel"), PART).unwrap();
        tmp
    }

    fn verdicts(tmp: &tempfile::TempDir, lines: &str) -> PathBuf {
        let path = tmp.path().join("verdicts.jsonl");
        std::fs::write(&path, lines).unwrap();
        path
    }

    #[test]
    fn index_lists_unrated_parts_in_shards() {
        let tmp = library();
        let out = tmp.path().join("shards");
        index(tmp.path(), &out, 1, &[], false).unwrap();
        let first = std::fs::read_to_string(out.join("shard-001.jsonl")).unwrap();
        assert!(first.contains(r#""id":"lead/demo/a.strudel""#), "{first}");
        assert!(first.contains(r#""code":"note(\"c4 e4 g4\")""#), "{first}");
        assert!(out.join("shard-002.jsonl").exists());
    }

    #[test]
    fn a_verdict_lands_in_the_header_and_keeps_the_old_name() {
        let tmp = library();
        let file = verdicts(
            &tmp,
            r#"{"id":"lead/demo/a.strudel","title":"Rising triad","tags":["arp","Not A Tag"],"rating":4}"#,
        );
        apply(tmp.path(), &[file], "ear").unwrap();
        let text = std::fs::read_to_string(tmp.path().join("Parts/lead/demo/a.strudel")).unwrap();
        assert!(text.starts_with(
            "---\nname: \"Rising triad\"\nsong: \"arena rock · 30\"\ntags: [part, lead, demo, arp]\nrating: 4\nrated_by: \"ear\"\nbpm: 120\nrole: lead\n"
        ), "{text}");
        assert!(text.ends_with("---\nnote(\"c4 e4 g4\")\n"));

        // A second review keeps the first name as the song.
        let again = verdicts(
            &tmp,
            r#"{"id":"lead/demo/a.strudel","title":"Up the chord","rating":3}"#,
        );
        apply(tmp.path(), &[again], "ear").unwrap();
        let text = std::fs::read_to_string(tmp.path().join("Parts/lead/demo/a.strudel")).unwrap();
        assert!(text.contains("song: \"arena rock · 30\""), "{text}");
        assert!(text.contains("tags: [part, lead, demo]"), "{text}");
        // Rated parts drop out of the next index.
        let out = tmp.path().join("shards");
        index(tmp.path(), &out, 10, &[], false).unwrap();
        let listed = std::fs::read_to_string(out.join("shard-001.jsonl")).unwrap();
        assert!(!listed.contains("a.strudel") && listed.contains("b.strudel"));
    }

    #[test]
    fn a_part_rated_one_leaves_the_shelf_and_bad_verdicts_are_skipped() {
        let tmp = library();
        let file = verdicts(
            &tmp,
            concat!(
                r#"{"id":"lead/demo/b.strudel","title":"Two notes","rating":1}"#,
                "\n",
                r#"{"id":"../../outside.strudel","title":"Escape","rating":3}"#,
                "\n",
                r#"{"id":"lead/demo/a.strudel","title":"","rating":9}"#,
                "\n",
            ),
        );
        apply(tmp.path(), &[file], "ear").unwrap();
        assert!(!tmp.path().join("Parts/lead/demo/b.strudel").exists());
        assert!(
            tmp.path()
                .join("_parts-rejected/lead/demo/b.strudel")
                .exists()
        );
        let untouched =
            std::fs::read_to_string(tmp.path().join("Parts/lead/demo/a.strudel")).unwrap();
        assert_eq!(untouched, PART);
    }

    #[test]
    fn reject_with_dotdot_id_stays_inside_rejected_dir_and_sanitizes_newlines() {
        let tmp = library();
        let file = verdicts(
            &tmp,
            r#"{"id":"lead/../../Parts/lead/demo/b.strudel","title":"Line1\ninjected: true","rating":1}"#,
        );
        apply(tmp.path(), &[file], "ear").unwrap();
        let dest = tmp.path().join("_parts-rejected/lead/demo/b.strudel");
        assert!(dest.exists());
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.contains("name: \"Line1 injected: true\""), "{text}");
    }
}
