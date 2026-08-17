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
        let id = filename
            .rsplit('/')
            .next()
            .unwrap_or(&filename)
            .to_string();
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
        let sounds = extract_sounds(&code);
        let effects = extract_effects(&code);
        let features = extract_features(&code);
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
    debug!("loaded {} curated entries from {}", entries.len(), curated_root.display());
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

/// Extract tempo (BPM) from the first `setbpm(N)` / `setcpm(N)` / `setcps(N)`
/// directive. Returns `None` if none of those appear. Conversion mirrors
/// strudel-rs: setbpm → N, setcpm → N*4, setcps → N*240.
/// Extract sound family / synth labels from curated source code.
/// Checks for known sound prefixes and quoted synth names; returns short
/// canonical labels suitable for tag-matching (e.g. "tr808", "gm", "fm").
fn extract_sounds(code: &str) -> Vec<String> {
    let mut out: Vec<&str> = Vec::new();

    // Drum-machine family prefixes — just check presence in the whole file
    let families: &[(&str, &str)] = &[
        ("RolandTR808_", "tr808"),
        ("RolandTR909_", "tr909"),
        ("RolandTR707_", "tr707"),
        ("LinnDrum_", "linndrum"),
        ("BossDR55_", "dr55"),
        ("gm_", "gm"),
        ("wt_", "wavetable"),
    ];
    for (prefix, label) in families {
        if code.contains(prefix) {
            out.push(label);
        }
    }

    // Named synth voices — look for them as quoted string arguments
    let synths: &[(&str, &str)] = &[
        ("\"sawtooth\"", "sawtooth"),
        ("\"supersaw\"", "supersaw"),
        ("\"supersquare\"", "supersquare"),
        ("\"superpwm\"", "superpwm"),
        ("\"sine\"", "sine"),
        ("\"triangle\"", "triangle"),
        ("\"square\"", "square"),
        ("\"fm\"", "fm"),
        ("\"pulse\"", "pulse"),
        ("\"white\"", "noise"),
        ("\"pink\"", "noise"),
        ("\"brown\"", "noise"),
        ("\"crackle\"", "crackle"),
        ("\"sbd\"", "sbd"),
    ];
    for (pattern, label) in synths {
        if code.contains(pattern) && !out.contains(label) {
            out.push(label);
        }
    }

    // Standard Dirt-Samples drum names — flag as "drums" if any appear
    let drum_names = ["\"bd", "\"sd", "\"sn", "\"hh", "\"oh", "\"cp",
                       "\"rs\"", "\"cr", "\"lt", "\"mt", "\"ht", "\"cb"];
    if drum_names.iter().any(|d| code.contains(d)) && !out.contains(&"drums") {
        out.push("drums");
    }

    out.iter().map(|s| s.to_string()).collect()
}

/// Extract effect labels from curated source code.
fn extract_effects(code: &str) -> Vec<String> {
    let checks: &[(&str, &str)] = &[
        (".room(", "reverb"),
        (".roomsize(", "reverb"),
        (".delay(", "delay"),
        (".delayfeedback(", "delay"),
        (".dist(", "distortion"),
        (".distort(", "distortion"),
        (".crush(", "bitcrush"),
        (".shape(", "waveshaper"),
        (".coarse(", "decimator"),
        (".chorus(", "chorus"),
        (".vowel(", "vowel"),
        (".grainsize(", "granular"),
        (".ir(", "convolution"),
        (".cutoff(", "filter"),
        (".lpf(", "filter"),
        (".hpf(", "filter"),
        (".bpf(", "filter"),
        (".resonance(", "resonance"),
    ];
    let mut out: Vec<&str> = Vec::new();
    for (pattern, label) in checks {
        if code.contains(pattern) && !out.contains(label) {
            out.push(label);
        }
    }
    out.iter().map(|s| s.to_string()).collect()
}

/// Extract DSL feature labels from curated source code.
fn extract_features(code: &str) -> Vec<String> {
    let checks: &[(&str, &str)] = &[
        ("chord(", "chord"),
        (".voicing(", "voicing"),
        ("pickRestart", "pickRestart"),
        ("pickmod", "pick"),
        (".scale(", "scale"),
        (".every(", "every"),
        ("euclid(", "euclid"),
        (".mask(", "mask"),
        ("slowcat(", "slowcat"),
        ("fastcat(", "fastcat"),
        (".superimpose(", "superimpose"),
        (".jux(", "jux"),
        (".off(", "off"),
        (".fmindex(", "fm-synthesis"),
        (".fmratio(", "fm-synthesis"),
        ("stack(", "stack"),
        (".slow(", "slow"),
        (".fast(", "fast"),
        (".rev", "reverse"),
        (".stut(", "stutter"),
        (".echo(", "echo"),
        (".degrade", "degrade"),
        ("sine.range(", "lfo"),
        ("sine.slow(", "lfo"),
        ("saw.range(", "lfo"),
        ("tri.range(", "lfo"),
        (".attack(", "envelope"),
        (".release(", "envelope"),
    ];
    let mut out: Vec<&str> = Vec::new();
    for (pattern, label) in checks {
        if code.contains(pattern) && !out.contains(label) {
            out.push(label);
        }
    }
    out.iter().map(|s| s.to_string()).collect()
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
        .map(|t| t.to_lowercase())
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
