use cycletron_core::types::CorpusEntry;
use serde::Deserialize;
use std::io::BufRead;
use std::path::Path;
use tracing::{debug, warn};

/// Raw JSONL row — mirrors the nested structure in normalized-metadata.jsonl.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMetadataRow {
    normalized_path: String,
    #[serde(default)]
    file_type: Option<String>,
    #[serde(default)]
    analysis: Option<RawAnalysis>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAnalysis {
    #[serde(default)]
    content_kind: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    tempo: Option<f64>,
    #[serde(default)]
    sounds: Vec<String>,
    #[serde(default)]
    effects: Vec<String>,
    #[serde(default)]
    scales: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    features: Vec<String>,
    #[serde(default)]
    complexity: Option<String>,
}

impl RawMetadataRow {
    fn into_entry(self) -> Option<CorpusEntry> {
        let analysis = self.analysis?;
        // Skip non-code entries (notes, conversion-notes)
        if analysis.content_kind.as_deref() != Some("code") {
            return None;
        }

        // Only keep entries whose source is native strudel mini-notation (the format
        // strudel-rs understands and the WASM REPL can run) — drop anything written
        // against the full JS web-strudel runtime ("js-song", "tidal", "midi", etc.).
        if let Some(ft) = &self.file_type {
            let f = ft.to_ascii_lowercase();
            if f != "strudel" {
                return None;
            }
        }
        let filename = self
            .normalized_path
            .strip_prefix("normalized/")
            .unwrap_or(&self.normalized_path)
            .to_string();
        // Use the filename stem (before __hash) as id
        let id = filename.rsplit('/').next().unwrap_or(&filename).to_string();
        Some(CorpusEntry {
            id,
            filename,
            file_type: self.file_type,
            title: analysis.title,
            author: analysis.author,
            tempo: analysis.tempo,
            sounds: analysis.sounds,
            effects: analysis.effects,
            scales: analysis.scales,
            tags: analysis.tags,
            features: analysis.features,
            complexity: analysis.complexity,
            source_code: None,
        })
    }
}

/// Load corpus entries from normalized-metadata.jsonl.
pub fn load_metadata(path: &Path) -> anyhow::Result<Vec<CorpusEntry>> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(file);
    let mut entries = Vec::new();

    for (i, line) in reader.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<RawMetadataRow>(&line) {
            Ok(row) => {
                if let Some(entry) = row.into_entry() {
                    entries.push(entry);
                }
            }
            Err(e) => {
                warn!("failed to parse metadata line {}: {e}", i + 1);
            }
        }
    }

    debug!(
        "loaded {} strudel-rs compatible corpus entries from metadata (js-song / tidal / midi / notes entries were filtered out)",
        entries.len()
    );
    Ok(entries)
}

/// Load the source code for a corpus entry from the normalized/ directory.
pub fn load_source(corpus_path: &Path, filename: &str) -> anyhow::Result<String> {
    let source_path = corpus_path.join("normalized").join(filename);
    Ok(std::fs::read_to_string(source_path)?)
}

/// Load the hand-curated corpus from `corpus/{category}/*.strudel`.
///
/// One `CorpusEntry` per `.strudel` file. Metadata is derived directly from
/// the file:
/// - `id` = `category/filename.strudel` (stable, unique).
/// - `title` = first non-empty `//` comment line (without the slashes).
/// - `tempo` = number argument to the first `setbpm(...)`, `setcpm(...)`, or
///   `setcps(...)` directive (converted to BPM if needed).
/// - `tags` = `[category, "curated"]`.
/// - `source_code` = full file contents, pre-loaded.
pub fn load_curated_dir(curated_root: &Path) -> anyhow::Result<Vec<CorpusEntry>> {
    let mut entries = Vec::new();

    for entry in walkdir::WalkDir::new(curated_root)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("strudel") {
            continue;
        }
        let rel = match path.strip_prefix(curated_root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let category = rel
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .unwrap_or_else(|| "misc".to_string());

        let code = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                warn!("curated: failed to read {}: {e}", path.display());
                continue;
            }
        };

        let id = rel.display().to_string();
        let title = first_comment_line(&code);
        let tempo = cycletron_core::text::tempo::scan_bpm(&code);
        let (sounds, effects, features) = extract_labels(&code);
        let mut tags = vec![category, "curated".to_string()];
        tags.extend(filename_genre_tags(&id));

        entries.push(CorpusEntry {
            id: id.clone(),
            filename: id,
            file_type: Some("curated".to_string()),
            title,
            author: None,
            tempo,
            sounds,
            effects,
            scales: Vec::new(),
            tags,
            features,
            complexity: None,
            source_code: Some(code),
        });
    }

    entries.sort_by(|a, b| a.id.cmp(&b.id));
    debug!(
        "loaded {} curated entries from {}",
        entries.len(),
        curated_root.display()
    );
    Ok(entries)
}

/// Pull the first `//` comment line out of a `.strudel` source, stripping
/// the slashes and surrounding whitespace. Returns `None` if the file has
/// no leading comment.
fn first_comment_line(code: &str) -> Option<String> {
    for line in code.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("//") {
            let s = rest.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        } else if !trimmed.is_empty() {
            // Bail at the first non-comment, non-blank line.
            return None;
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq)]
enum LabelCat {
    Sound,
    Effect,
    Feature,
}

/// Every needle the curated-metadata extractor looks for, with its category
/// and canonical label. Order within a category is the output order.
const LABEL_NEEDLES: &[(&str, LabelCat, &str)] = &[
    // Sounds: drum-machine family prefixes (presence anywhere in the file).
    ("RolandTR808_", LabelCat::Sound, "tr808"),
    ("RolandTR909_", LabelCat::Sound, "tr909"),
    ("RolandTR707_", LabelCat::Sound, "tr707"),
    ("LinnDrum_", LabelCat::Sound, "linndrum"),
    ("BossDR55_", LabelCat::Sound, "dr55"),
    ("gm_", LabelCat::Sound, "gm"),
    ("wt_", LabelCat::Sound, "wavetable"),
    // Sounds: named synth voices as quoted string arguments.
    ("\"sawtooth\"", LabelCat::Sound, "sawtooth"),
    ("\"supersaw\"", LabelCat::Sound, "supersaw"),
    ("\"supersquare\"", LabelCat::Sound, "supersquare"),
    ("\"superpwm\"", LabelCat::Sound, "superpwm"),
    ("\"sine\"", LabelCat::Sound, "sine"),
    ("\"triangle\"", LabelCat::Sound, "triangle"),
    ("\"square\"", LabelCat::Sound, "square"),
    ("\"fm\"", LabelCat::Sound, "fm"),
    ("\"pulse\"", LabelCat::Sound, "pulse"),
    ("\"white\"", LabelCat::Sound, "noise"),
    ("\"pink\"", LabelCat::Sound, "noise"),
    ("\"brown\"", LabelCat::Sound, "noise"),
    ("\"crackle\"", LabelCat::Sound, "crackle"),
    ("\"sbd\"", LabelCat::Sound, "sbd"),
    // Sounds: standard Dirt-Samples drum names -> one "drums" label.
    ("\"bd", LabelCat::Sound, "drums"),
    ("\"sd", LabelCat::Sound, "drums"),
    ("\"sn", LabelCat::Sound, "drums"),
    ("\"hh", LabelCat::Sound, "drums"),
    ("\"oh", LabelCat::Sound, "drums"),
    ("\"cp", LabelCat::Sound, "drums"),
    ("\"rs\"", LabelCat::Sound, "drums"),
    ("\"cr", LabelCat::Sound, "drums"),
    ("\"lt", LabelCat::Sound, "drums"),
    ("\"mt", LabelCat::Sound, "drums"),
    ("\"ht", LabelCat::Sound, "drums"),
    ("\"cb", LabelCat::Sound, "drums"),
    // Effects.
    (".room(", LabelCat::Effect, "reverb"),
    (".roomsize(", LabelCat::Effect, "reverb"),
    (".delay(", LabelCat::Effect, "delay"),
    (".delayfeedback(", LabelCat::Effect, "delay"),
    (".dist(", LabelCat::Effect, "distortion"),
    (".distort(", LabelCat::Effect, "distortion"),
    (".crush(", LabelCat::Effect, "bitcrush"),
    (".shape(", LabelCat::Effect, "waveshaper"),
    (".coarse(", LabelCat::Effect, "decimator"),
    (".chorus(", LabelCat::Effect, "chorus"),
    (".vowel(", LabelCat::Effect, "vowel"),
    (".grainsize(", LabelCat::Effect, "granular"),
    (".ir(", LabelCat::Effect, "convolution"),
    (".cutoff(", LabelCat::Effect, "filter"),
    (".lpf(", LabelCat::Effect, "filter"),
    (".hpf(", LabelCat::Effect, "filter"),
    (".bpf(", LabelCat::Effect, "filter"),
    (".resonance(", LabelCat::Effect, "resonance"),
    // DSL features.
    ("chord(", LabelCat::Feature, "chord"),
    (".voicing(", LabelCat::Feature, "voicing"),
    ("pickRestart", LabelCat::Feature, "pickRestart"),
    ("pickmod", LabelCat::Feature, "pick"),
    (".scale(", LabelCat::Feature, "scale"),
    (".every(", LabelCat::Feature, "every"),
    ("euclid(", LabelCat::Feature, "euclid"),
    (".mask(", LabelCat::Feature, "mask"),
    ("slowcat(", LabelCat::Feature, "slowcat"),
    ("fastcat(", LabelCat::Feature, "fastcat"),
    (".superimpose(", LabelCat::Feature, "superimpose"),
    (".jux(", LabelCat::Feature, "jux"),
    (".off(", LabelCat::Feature, "off"),
    (".fmindex(", LabelCat::Feature, "fm-synthesis"),
    (".fmratio(", LabelCat::Feature, "fm-synthesis"),
    ("stack(", LabelCat::Feature, "stack"),
    (".slow(", LabelCat::Feature, "slow"),
    (".fast(", LabelCat::Feature, "fast"),
    (".rev", LabelCat::Feature, "reverse"),
    (".stut(", LabelCat::Feature, "stutter"),
    (".echo(", LabelCat::Feature, "echo"),
    (".degrade", LabelCat::Feature, "degrade"),
    ("sine.range(", LabelCat::Feature, "lfo"),
    ("sine.slow(", LabelCat::Feature, "lfo"),
    ("saw.range(", LabelCat::Feature, "lfo"),
    ("tri.range(", LabelCat::Feature, "lfo"),
    (".attack(", LabelCat::Feature, "envelope"),
    (".release(", LabelCat::Feature, "envelope"),
];

/// Extract sound / effect / feature labels for curated metadata in ONE pass
/// over the file (previously ~79 independent `contains` scans per file, on
/// every app start and corpus reload). Output order matches the table.
fn extract_labels(code: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    use std::sync::LazyLock;
    static AC: LazyLock<aho_corasick::AhoCorasick> = LazyLock::new(|| {
        aho_corasick::AhoCorasick::new(LABEL_NEEDLES.iter().map(|(n, _, _)| n))
            .expect("static needle table builds")
    });

    let mut hit = vec![false; LABEL_NEEDLES.len()];
    for m in AC.find_overlapping_iter(code) {
        hit[m.pattern().as_usize()] = true;
    }

    let mut sounds: Vec<String> = Vec::new();
    let mut effects: Vec<String> = Vec::new();
    let mut features: Vec<String> = Vec::new();
    for (i, (_, cat, label)) in LABEL_NEEDLES.iter().enumerate() {
        if !hit[i] {
            continue;
        }
        let dst = match cat {
            LabelCat::Sound => &mut sounds,
            LabelCat::Effect => &mut effects,
            LabelCat::Feature => &mut features,
        };
        if !dst.iter().any(|s| s == label) {
            dst.push((*label).to_string());
        }
    }
    (sounds, effects, features)
}

/// Extract genre/technique keywords from a curated entry id like
/// `rhythm/techno-tr909.strudel` → `["techno", "tr909"]`.
/// Skips tokens that are already implied by the category or too generic.
fn filename_genre_tags(id: &str) -> Vec<String> {
    let skip = ["strudel", "and", "with", "the"];
    let stem = std::path::Path::new(id)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    stem.split('-')
        .filter(|t| t.len() > 1 && !skip.contains(t))
        .map(str::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_comment_line_strips_slashes() {
        let code = "// hello world\nsetbpm(120);";
        assert_eq!(first_comment_line(code).as_deref(), Some("hello world"));
    }

    #[test]
    fn first_comment_line_skips_blank_lines() {
        let code = "\n\n// first real comment\n";
        assert_eq!(
            first_comment_line(code).as_deref(),
            Some("first real comment")
        );
    }

    #[test]
    fn first_comment_line_stops_at_non_comment() {
        let code = "setbpm(120);\n// comment after code\n";
        assert_eq!(first_comment_line(code), None);
    }

    #[test]
    fn load_curated_dir_finds_repo_corpus() {
        // CARGO_MANIFEST_DIR = crates/cycletron-corpus.
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let corpus = here
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("corpus"))
            .expect("workspace root");
        if !corpus.exists() {
            eprintln!("skipping — corpus dir not present at {}", corpus.display());
            return;
        }
        let entries = load_curated_dir(&corpus).expect("load curated");
        assert!(
            entries.len() >= 20,
            "expected ≥20 curated entries, got {}",
            entries.len()
        );
        for e in &entries {
            assert!(
                e.source_code.as_ref().is_some_and(|s| !s.is_empty()),
                "missing source_code for {}",
                e.id
            );
            assert!(
                e.tags.iter().any(|t| t == "curated"),
                "missing 'curated' tag on {}",
                e.id
            );
        }
        let categories: std::collections::BTreeSet<&str> = entries
            .iter()
            .filter_map(|e| e.tags.first().map(String::as_str))
            .collect();
        for required in ["rhythm", "melody", "harmony", "form", "timbre", "motion"] {
            assert!(
                categories.contains(required),
                "missing category {required} (got {categories:?})"
            );
        }
        assert!(
            entries.iter().any(|e| e.tempo.is_some()),
            "expected at least one entry with a parsed tempo"
        );
    }
}
