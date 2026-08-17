//! Generate a `genre_recipe` for every `GenreSpec` that lacks a hand-written
//! one, so the agent's `genre_recipe` tool covers the whole genre map (65 specs)
//! instead of only the ~12 curated markdown recipes.
//!
//! Each generated recipe is `corpus/genres/<name>.md`: frontmatter derived
//! directly from the spec (bpm, swing, scale, aliases, defining sounds) plus a
//! single `## Full skeleton` ` ```strudel ` fragment = `compose_from_spec(...)`
//! output — the same round-trip-verified stack already saved as each genre's
//! `generated-<name>.strudel`. Because `corpus-check` extracts and validates
//! recipe fragments, these flow through the existing gate unchanged.
//!
//! Hand-written recipes are NEVER overwritten: a spec whose `<name>.md` already
//! exists is skipped. Run with `cargo run -p gen-recipes`, then gate with
//! `cargo run -p corpus-check`.

use cycletron_gen::compose::compose_from_spec;
use cycletron_gen::spec::{self, GenreSpec, MelodySpec};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Fixed seed → deterministic output, so regenerating produces no spurious diff.
const SEED: u64 = 0;

fn main() {
    let genres_dir = corpus_genres_dir();
    if !genres_dir.is_dir() {
        eprintln!("gen-recipes: {} not found", genres_dir.display());
        std::process::exit(2);
    }

    let mut written = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    for spec in spec::registry() {
        let path = genres_dir.join(format!("{}.md", spec.name));
        if path.exists() {
            // Regenerate OUR own output (carries the generated banner) so recipe
            // skeletons track the generator; never clobber a hand-written recipe.
            let existing = fs::read_to_string(&path).unwrap_or_default();
            if !existing.contains("Generated from a GenreSpec") {
                skipped += 1;
                continue;
            }
        }
        match render_recipe(&spec) {
            Ok(md) => match fs::write(&path, md) {
                Ok(()) => {
                    written += 1;
                    println!("  wrote {}", path.display());
                }
                Err(e) => {
                    eprintln!("  FAILED writing {}: {e}", path.display());
                    failed += 1;
                }
            },
            Err(e) => {
                eprintln!("  SKIP {} — compose failed: {e}", spec.name);
                failed += 1;
            }
        }
    }

    update_map_ledger(&genres_dir);

    println!("gen-recipes: {written} written, {skipped} kept, {failed} failed");
    if failed > 0 {
        std::process::exit(1);
    }
}

/// Render one spec into recipe markdown.
fn render_recipe(spec: &GenreSpec) -> Result<String, String> {
    let piece = compose_from_spec(spec, SEED)?;
    let skeleton = piece.to_strudel();

    let (lo, hi) = spec.bpm;
    let mut fm = String::from("---\n");
    fm.push_str(&format!("genre: {}\n", spec.name));
    if !spec.aliases.is_empty() {
        fm.push_str(&format!("aliases: [{}]\n", spec.aliases.join(", ")));
    }
    fm.push_str(&format!("bpm: [{lo}, {hi}]\n"));
    fm.push_str(&format!("swing: {}\n", spec.swing));
    fm.push_str(&format!("scales: [{}]\n", spec.scale));
    let sounds = key_sounds(spec);
    if !sounds.is_empty() {
        fm.push_str(&format!("key_sounds: [{}]\n", sounds.join(", ")));
    }
    fm.push_str(&format!("signature: {}\n", one_line(&spec.desc)));
    fm.push_str("---\n\n");

    let mut body = String::new();
    body.push_str(
        "<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — \
         change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written \
         recipe of the same name overrides this one. -->\n\n",
    );
    body.push_str(&format!(
        "{} — {}. Tempo {lo}–{hi} BPM in {}. This skeleton is composed straight from the \
         genre spec (aligned drum grid, in-key bass{}{}), round-trip verified so it always \
         parses and plays. Use it as a seed: lift the parts you want, then layer and edit.\n\n",
        title_case(&spec.display),
        one_line(&spec.desc),
        spec.scale,
        if spec.harmony.is_some() {
            ", diatonic chords"
        } else {
            ""
        },
        if matches!(spec.melody, MelodySpec::None) {
            ""
        } else {
            ", a generated lead"
        },
    ));
    body.push_str("## Full skeleton\n\n");
    body.push_str("```strudel\n");
    body.push_str(skeleton.trim_end());
    body.push_str("\n```\n");

    Ok(format!("{fm}{body}"))
}

/// The defining timbres of a spec (bass / harmony / melody sounds) plus the
/// staple drum voices — a hint list for the agent, not exhaustive.
fn key_sounds(spec: &GenreSpec) -> Vec<String> {
    let mut set: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        let s = s.trim();
        if !s.is_empty() && !set.iter().any(|e| e == s) {
            set.push(s.to_string());
        }
    };
    for d in ["bd", "sd", "hh"] {
        push(d);
    }
    if let Some(b) = &spec.bass {
        push(&b.sound);
    }
    if let Some(h) = &spec.harmony {
        push(&h.sound);
    }
    if let Some(s) = melody_sound(&spec.melody) {
        push(s);
    }
    set
}

fn melody_sound(m: &MelodySpec) -> Option<&str> {
    match m {
        MelodySpec::None => None,
        MelodySpec::Walk { sound, .. } => Some(sound),
        MelodySpec::Arpeggio { sound, .. } => Some(sound),
    }
}

/// Collapse whitespace/newlines so a multi-word desc stays on one frontmatter line.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Capitalise the first letter for the prose title; specs store display names
/// lowercased ("deep house").
fn title_case(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Update `_map.json`'s per-genre `recipe` fields and `totals.recipe` to reflect
/// the recipe files now on disk. Line-oriented string edits so the hand-tuned
/// one-line-per-genre formatting is preserved exactly (a serde round-trip would
/// reflow the whole file).
fn update_map_ledger(genres_dir: &Path) {
    let map_path = genres_dir.join("_map.json");
    let Ok(text) = fs::read_to_string(&map_path) else {
        return;
    };

    // Every recipe stem currently on disk (excludes _drafts, _template, README).
    let recipes: BTreeSet<String> = fs::read_dir(genres_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            if cycletron_corpus::layout::is_doc_file(&p) {
                return None;
            }
            Some(p.file_stem()?.to_str()?.to_string())
        })
        .collect();

    let mut changed = 0usize;
    let out: Vec<String> = text
        .lines()
        .map(|line| {
            // Only genre entries carry a `"recipe":` field.
            if let Some(name) = json_field(line, "name") {
                if recipes.contains(&name) && line.contains("\"recipe\": null") {
                    changed += 1;
                    return line.replace("\"recipe\": null", &format!("\"recipe\": \"{name}.md\""));
                }
            }
            line.to_string()
        })
        .collect();

    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    // Refresh the recipe total (find `"recipe": N` inside the totals object).
    if let Some(replaced) = replace_totals_recipe(&joined, recipes.len()) {
        joined = replaced;
    }

    if joined != text {
        let _ = fs::write(&map_path, joined);
        println!(
            "  updated _map.json ({changed} recipe links, total {})",
            recipes.len()
        );
    }
}

/// Pull a string value for `"<key>": "<value>"` out of a JSON line.
fn json_field(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\": \"");
    let start = line.find(&pat)? + pat.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Replace the `"recipe": N` count inside the `"totals"` object.
fn replace_totals_recipe(text: &str, n: usize) -> Option<String> {
    let totals = text.find("\"totals\"")?;
    let head = &text[..totals];
    let tail = &text[totals..];
    let key = "\"recipe\": ";
    let rel = tail.find(key)? + key.len();
    let after = &tail[rel..];
    let digits_end = after
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after.len());
    let new_tail = format!("{}{}{}", &tail[..rel], n, &after[digits_end..]);
    Some(format!("{head}{new_tail}"))
}

/// `corpus/genres` relative to the repo root (this bin lives at
/// `tools/gen-recipes`, two levels down).
fn corpus_genres_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or(&manifest);
    root.join("corpus").join("genres")
}
