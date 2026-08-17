//! Genre recipes: a living, version-controlled knowledge base of how to make a
//! given style in *strudel-rs terms*. Each recipe is a markdown file under
//! `corpus/genres/` with YAML-ish frontmatter (constraints + sources) and a
//! body of prose sections, each carrying complete, playable ```strudel
//! fragments.
//!
//! The fragments are the trust anchor: `corpus-check` extracts and validates
//! every one through the real engine, so a recipe can never claim a pattern
//! that doesn't actually parse and emit on strudel-rs.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// A parsed genre recipe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    /// Canonical genre name (kebab-case), from the filename if absent in frontmatter.
    pub genre: String,
    /// Alternate names this recipe answers to (for lookup).
    pub aliases: Vec<String>,
    /// Tempo range in BPM, if given.
    pub bpm: Option<(f64, f64)>,
    /// Typical swing amount (0..1), if given.
    pub swing: Option<f64>,
    /// Scales / modes idiomatic to the genre.
    pub scales: Vec<String>,
    /// Defining sounds / instruments.
    pub key_sounds: Vec<String>,
    /// One-line description of the sound.
    pub signature: Option<String>,
    /// Reference artists / tracks.
    pub artists: Vec<String>,
    /// Source URLs the recipe was researched from (provenance).
    pub sources: Vec<String>,
    /// Prose sections, each with any playable fragments under it.
    pub sections: Vec<RecipeSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeSection {
    pub title: String,
    pub prose: String,
    pub fragments: Vec<Fragment>,
}

/// A complete, playable strudel-rs snippet. `label` is the section it lives
/// under (plus an index when a section has several).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fragment {
    pub label: String,
    pub code: String,
}

impl Recipe {
    /// Does this recipe answer to `query` (match on genre or an alias, exact or
    /// substring)? Normalizes spaces/underscores to hyphens on both sides so a
    /// natural-language query ("drum and bass") finds a kebab genre
    /// (`drum-and-bass`) — matching how `spec::find` routes for generation.
    pub fn matches(&self, query: &str) -> bool {
        let q = normalize_genre(query);
        if q.is_empty() {
            return false;
        }
        let names = std::iter::once(&self.genre).chain(self.aliases.iter());
        names.into_iter().any(|n| {
            let n = normalize_genre(n);
            n == q || n.contains(&q) || q.contains(&n)
        })
    }

    /// Every fragment across all sections, in order.
    pub fn fragments(&self) -> impl Iterator<Item = &Fragment> {
        self.sections.iter().flat_map(|s| s.fragments.iter())
    }
}

/// Parse a recipe from markdown text. `name` is the fallback genre (the file
/// stem). Returns an error only for structurally unusable input.
pub fn parse_recipe(name: &str, text: &str) -> Result<Recipe, String> {
    let (frontmatter, body) = cycletron_core::text::frontmatter::split(text);
    let fm = cycletron_core::text::frontmatter::parse(frontmatter.unwrap_or(""));

    let genre = fm.scalar("genre").unwrap_or_else(|| name.to_string());
    let bpm = fm.array("bpm").and_then(|v| {
        let nums: Vec<f64> = v.iter().filter_map(|s| s.parse().ok()).collect();
        match nums.as_slice() {
            [lo, hi, ..] => Some((*lo, *hi)),
            [only] => Some((*only, *only)),
            _ => None,
        }
    });

    let sections = parse_sections(body);

    Ok(Recipe {
        genre,
        aliases: fm.array("aliases").unwrap_or_default(),
        bpm,
        swing: fm.scalar("swing").and_then(|s| s.parse().ok()),
        scales: fm.array("scales").unwrap_or_default(),
        key_sounds: fm.array("key_sounds").unwrap_or_default(),
        signature: fm.scalar("signature"),
        artists: fm.array("artists").unwrap_or_default(),
        sources: fm.array("sources").unwrap_or_default(),
        sections,
    })
}

/// Normalize a genre string for matching: lowercase, trim, spaces/underscores
/// → hyphens (mirrors `cycletron_gen::spec::normalize`).
fn normalize_genre(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace([' ', '_'], "-")
}

/// Load every `*.md` recipe under `dir`. Missing dir → empty (not an error).
pub fn load_recipes(dir: &Path) -> Vec<Recipe> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut paths: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
        .filter(|p| !crate::layout::is_doc_file(p))
        .collect();
    paths.sort();
    for path in paths {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("recipe");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(recipe) = parse_recipe(stem, &text) {
                out.push(recipe);
            }
        }
    }
    out
}

/// Extract every ```strudel fenced code block from markdown, paired with the
/// nearest preceding `##` heading as a label. Used by the validation gate.
pub fn extract_strudel_blocks(text: &str) -> Vec<Fragment> {
    let mut out = Vec::new();
    let mut current_heading = String::from("(intro)");
    let mut in_block = false;
    let mut buf: Vec<&str> = Vec::new();
    let mut seen_in_section = 0usize;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if in_block {
            if trimmed.starts_with("```") {
                seen_in_section += 1;
                let label = if seen_in_section > 1 {
                    format!("{current_heading} #{seen_in_section}")
                } else {
                    current_heading.clone()
                };
                out.push(Fragment {
                    label,
                    code: buf.join("\n"),
                });
                buf.clear();
                in_block = false;
            } else {
                buf.push(line);
            }
        } else if trimmed.starts_with("```strudel") {
            in_block = true;
        } else if let Some(h) = trimmed.strip_prefix("## ") {
            current_heading = h.trim().to_string();
            seen_in_section = 0;
        }
    }
    out
}

/// Parse the markdown body into sections by `##` headings, pulling ```strudel
/// fragments into the section they sit under.
fn parse_sections(body: &str) -> Vec<RecipeSection> {
    let mut sections: Vec<RecipeSection> = Vec::new();
    let mut title = String::from("Overview");
    let mut prose: Vec<String> = Vec::new();
    let mut frags: Vec<Fragment> = Vec::new();
    let mut in_block = false;
    let mut buf: Vec<&str> = Vec::new();
    let mut frag_idx = 0usize;

    let flush = |title: &str,
                 prose: &mut Vec<String>,
                 frags: &mut Vec<Fragment>,
                 sections: &mut Vec<RecipeSection>| {
        let text = prose.join("\n").trim().to_string();
        if !text.is_empty() || !frags.is_empty() {
            sections.push(RecipeSection {
                title: title.to_string(),
                prose: text,
                fragments: std::mem::take(frags),
            });
        }
        prose.clear();
    };

    for line in body.lines() {
        let trimmed = line.trim_start();
        if in_block {
            if trimmed.starts_with("```") {
                frag_idx += 1;
                let label = if frag_idx > 1 {
                    format!("{title} #{frag_idx}")
                } else {
                    title.clone()
                };
                frags.push(Fragment {
                    label,
                    code: buf.join("\n"),
                });
                buf.clear();
                in_block = false;
            } else {
                buf.push(line);
            }
        } else if trimmed.starts_with("```strudel") {
            in_block = true;
        } else if trimmed.starts_with("```") {
            // Non-strudel fenced block: skip its contents but keep as prose marker.
            in_block = false;
        } else if let Some(h) = trimmed.strip_prefix("## ") {
            flush(&title, &mut prose, &mut frags, &mut sections);
            title = h.trim().to_string();
            frag_idx = 0;
        } else {
            prose.push(line.to_string());
        }
    }
    flush(&title, &mut prose, &mut frags, &mut sections);
    sections
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"---
genre: acid-techno
aliases: [acid, acid house]
bpm: [130, 150]
swing: 0.1
scales: [phrygian, minor]
key_sounds: [sawtooth, bd]
signature: Squelchy 303 over a relentless four-on-the-floor
artists: [Hardfloor, Plastikman]
sources:
  - https://example.com/acid
  - "https://example.com/303, the box"
---

Intro prose.

## Drum core

Four on the floor.

```strudel
s("bd*4")
```

## 303 bassline

```strudel
note("c2 c2").s("sawtooth").lpf(400)
```
"#;

    #[test]
    fn parses_frontmatter_and_sections() {
        let r = parse_recipe("fallback", SAMPLE).unwrap();
        assert_eq!(r.genre, "acid-techno");
        assert_eq!(r.aliases, vec!["acid", "acid house"]);
        assert_eq!(r.bpm, Some((130.0, 150.0)));
        assert_eq!(r.swing, Some(0.1));
        assert_eq!(r.scales, vec!["phrygian", "minor"]);
        // Quoted source with an embedded comma stays one item.
        assert_eq!(r.sources.len(), 2);
        assert!(r.sources[1].contains("the box"));
        // Sections: Overview (intro prose) + Drum core + 303 bassline.
        let titles: Vec<&str> = r.sections.iter().map(|s| s.title.as_str()).collect();
        assert!(titles.contains(&"Drum core"));
        assert!(titles.contains(&"303 bassline"));
        // Two fragments total.
        assert_eq!(r.fragments().count(), 2);
    }

    #[test]
    fn matches_genre_and_aliases() {
        let r = parse_recipe("x", SAMPLE).unwrap();
        assert!(r.matches("acid-techno"));
        assert!(r.matches("acid techno")); // space form normalizes to hyphen
        assert!(r.matches("acid_techno")); // underscore form too
        assert!(r.matches("ACID"));
        assert!(r.matches("house")); // substring of "acid house"
        assert!(!r.matches("jazz"));
    }

    #[test]
    fn extract_blocks_labels_by_heading() {
        let frags = extract_strudel_blocks(SAMPLE);
        assert_eq!(frags.len(), 2);
        assert_eq!(frags[0].label, "Drum core");
        assert_eq!(frags[0].code, r#"s("bd*4")"#);
        assert_eq!(frags[1].label, "303 bassline");
    }
}
