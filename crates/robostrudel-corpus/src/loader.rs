use robostrudel_core::types::{CorpusEntry, CorpusPart, MusicalRole};
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
        // strudel-rs actually understands and the WASM REPL can run). We are a
        // strudel-rs-first app — drop everything that was written against the full
        // JS web-strudel runtime ("js-song", "tidal", "midi", etc.).
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

/// Load part excerpts from agent-part-excerpts.tsv.
///
/// The TSV has this shape (produced by the corpus build tooling):
///
/// `normalized_path  derived_path  title  author  file_type  part_role  …`
///
/// `derived_path` points at the extracted-part file on disk (e.g.
/// `derived/agent-parts/bassline/song--bass__hash.js`). We read that file
/// lazily when populating each `CorpusPart::code`. `corpus_path` is the
/// corpus root so we can resolve the relative `derived_path`.
pub fn load_parts(path: &Path, corpus_path: &Path) -> anyhow::Result<Vec<CorpusPart>> {
    let content = std::fs::read_to_string(path)?;
    let mut parts = Vec::new();
    let mut lines = content.lines();

    let header = lines.next().unwrap_or_default();
    let columns: Vec<&str> = header.split('\t').collect();

    let find = |names: &[&str]| -> Option<usize> {
        columns.iter().position(|c| names.contains(c))
    };

    let source_col = find(&["normalized_path", "source_id", "source_path", "file"]);
    let derived_col = find(&["derived_path", "part_path"]);
    let role_col = find(&["part_role", "role", "agent_role"]);
    let code_col = find(&["code", "excerpt"]);
    let label_col = find(&["label"]);

    for line in lines {
        let fields: Vec<&str> = line.split('\t').collect();
        let source_id = source_col
            .and_then(|i| fields.get(i))
            .unwrap_or(&"")
            .to_string();
        let role_str = role_col.and_then(|i| fields.get(i)).unwrap_or(&"");
        let label = label_col
            .and_then(|i| fields.get(i))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        let role = match *role_str {
            "drum-groove" | "drums" => MusicalRole::DrumGroove,
            "bassline" | "bass" => MusicalRole::Bassline,
            "melodic-hook" | "melody" => MusicalRole::MelodicHook,
            "harmony-loop" | "harmony" => MusicalRole::HarmonyLoop,
            "texture-bed" | "texture" => MusicalRole::TextureBed,
            "transition-seed" | "transition" => MusicalRole::TransitionSeed,
            "arrangement-seed" | "arrangement" => MusicalRole::ArrangementSeed,
            "remix-seed" | "remix" => MusicalRole::RemixSeed,
            _ => continue,
        };

        // Prefer an inline `code` column if present; otherwise resolve
        // `derived_path` against the corpus root and read the file.
        let code = if let Some(i) = code_col
            && let Some(v) = fields.get(i)
            && !v.is_empty()
        {
            (*v).to_string()
        } else if let Some(i) = derived_col
            && let Some(rel) = fields.get(i).filter(|s| !s.is_empty())
        {
            match std::fs::read_to_string(corpus_path.join(rel)) {
                Ok(s) => s,
                Err(_) => continue, // referenced file missing — skip silently
            }
        } else {
            continue;
        };

        if !code.trim().is_empty() {
            parts.push(CorpusPart {
                source_id,
                role,
                code,
                label,
            });
        }
    }

    debug!("loaded {} corpus parts", parts.len());
    Ok(parts)
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
        let tempo = first_tempo_directive(&code);

        entries.push(CorpusEntry {
            id: id.clone(),
            filename: id,
            file_type: Some("curated".to_string()),
            title,
            author: None,
            tempo,
            sounds: Vec::new(),
            effects: Vec::new(),
            scales: Vec::new(),
            tags: vec![category, "curated".to_string()],
            features: Vec::new(),
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
fn first_tempo_directive(code: &str) -> Option<f64> {
    for line in code.lines() {
        let trimmed = line.trim();
        if let Some(n) = parse_tempo(trimmed, "setbpm") {
            return Some(n);
        }
        if let Some(n) = parse_tempo(trimmed, "setcpm") {
            return Some(n * 4.0);
        }
        if let Some(n) = parse_tempo(trimmed, "setcps") {
            return Some(n * 240.0);
        }
    }
    None
}

fn parse_tempo(line: &str, prefix: &str) -> Option<f64> {
    let rest = line.strip_prefix(prefix)?.trim_start();
    let rest = rest.strip_prefix('(')?;
    let end = rest.find(')')?;
    rest[..end].trim().parse().ok()
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
    fn first_tempo_directive_reads_setbpm() {
        assert_eq!(first_tempo_directive("setbpm(124);\nrest"), Some(124.0));
    }

    #[test]
    fn first_tempo_directive_converts_setcpm() {
        // 30 cpm = 120 bpm at 4 beats/cycle.
        assert_eq!(first_tempo_directive("setcpm(30);"), Some(120.0));
    }

    #[test]
    fn first_tempo_directive_converts_setcps() {
        // 0.5 cps = 30 cpm = 120 bpm.
        assert_eq!(first_tempo_directive("setcps(0.5);"), Some(120.0));
    }

    #[test]
    fn load_curated_dir_finds_repo_corpus() {
        // CARGO_MANIFEST_DIR = crates/robostrudel-corpus.
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
