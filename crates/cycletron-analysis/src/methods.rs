//! The strudel-rs DSL *method/function surface* as structured data the agent can
//! query — the twin of [`sounds`](crate::sounds), which covers the *sound* names.
//!
//! Source of truth is `docs/STRUDEL_RS_SUPPORTED.md`, parsed at build time by
//! `ui/scripts/gen-dsl-surface.mjs` into `ui/src/generated/dsl-surface.json`
//! (the same data the editor's autocomplete reads from `dsl-surface.ts`). We
//! `include_str!` that JSON so the `list_methods` agent tool can never drift
//! from what the validator actually accepts — regenerate both with
//! `npm run gen:dsl`.

use serde::Deserialize;

/// One DSL symbol: a free function, a chainable pattern method, a file-level
/// keyword, or a sound name. Mirrors the `DslSymbol` interface in
/// `ui/src/generated/dsl-surface.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct DslSymbol {
    /// Identifier, e.g. `every`.
    pub label: String,
    /// Signature, e.g. `every(n, fn)`; equals `label` when it takes no args.
    pub detail: String,
    /// One-line description / section name, e.g. `Conditionals`, `Delay`.
    pub info: String,
    /// `function` | `method` | `keyword` | `sound`.
    pub kind: String,
}

/// The generated surface, embedded at compile time. Relative path from this
/// file (`crates/cycletron-analysis/src/`) up to the repo root, then into `ui/`.
const DSL_SURFACE_JSON: &str = include_str!("../../../ui/src/generated/dsl-surface.json");

/// Parse the embedded surface. The JSON is generated and checked in, so this
/// only fails if the generator schema changed without updating [`DslSymbol`].
pub fn dsl_symbols() -> Vec<DslSymbol> {
    serde_json::from_str(DSL_SURFACE_JSON)
        .expect("generated dsl-surface.json is malformed — regenerate with `npm run gen:dsl`")
}

/// Render the method/function/keyword surface as a compact, agent-readable
/// listing grouped by `info` (the doc section, e.g. `Filters`, `Delay`).
/// Sounds are intentionally excluded — the agent has `list_sounds` for those.
///
/// `kind_filter` (optional) keeps only `function` / `method` / `keyword`.
/// `category` (optional) keeps only symbols whose `info` contains it
/// (case-insensitive substring), e.g. `"filter"` → all filter methods.
pub fn methods_listing(kind_filter: Option<&str>, category: Option<&str>) -> String {
    let want_kind = kind_filter.map(|k| k.trim().to_ascii_lowercase());
    let want_cat = category.map(|c| c.trim().to_ascii_lowercase());

    let mut syms: Vec<DslSymbol> = dsl_symbols()
        .into_iter()
        // Sounds live in `list_sounds`; this tool is the verb surface.
        .filter(|s| s.kind != "sound")
        .filter(|s| match &want_kind {
            Some(k) => &s.kind == k,
            None => true,
        })
        .filter(|s| match &want_cat {
            Some(c) => s.info.to_ascii_lowercase().contains(c.as_str()),
            None => true,
        })
        .collect();

    if syms.is_empty() {
        return "No DSL methods match that filter. Try no filter, or kind = \
                function | method | keyword."
            .to_string();
    }

    // Stable, readable order: by section, then by name within a section.
    syms.sort_by(|a, b| a.info.cmp(&b.info).then_with(|| a.label.cmp(&b.label)));

    let mut out = String::new();
    out.push_str(
        "strudel-rs DSL surface (ground truth — every entry is accepted by the \
         validator). Signatures show the arg shape; `x => …` arrow params take NO \
         parentheses.\n",
    );
    let mut current = "";
    for s in &syms {
        if s.info != current {
            current = &s.info;
            out.push_str(&format!("\n## {} ({})\n", section_label(current), s.kind));
        }
        out.push_str(&format!("  {}\n", s.detail));
    }
    out
}

/// A blank `info` (symbols the doc didn't file under a heading) reads better as
/// "misc" than as an empty heading.
fn section_label(info: &str) -> &str {
    if info.trim().is_empty() { "misc" } else { info }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_parses_and_is_nonempty() {
        let syms = dsl_symbols();
        assert!(
            syms.len() > 100,
            "expected the full surface, got {}",
            syms.len()
        );
    }

    #[test]
    fn known_methods_present() {
        let syms = dsl_symbols();
        for name in ["every", "jux", "lpf", "room", "chop", "scale"] {
            assert!(
                syms.iter().any(|s| s.label == name),
                "missing expected method `{name}`"
            );
        }
    }

    #[test]
    fn listing_excludes_sounds_and_groups() {
        let all = methods_listing(None, None);
        // A sound name should not appear as its own listed verb.
        assert!(!all.contains("\n  supersaw\n"));
        // Section headers render.
        assert!(all.contains("## "));
    }

    #[test]
    fn category_filter_narrows() {
        let filters = methods_listing(None, Some("filter"));
        assert!(filters.contains("lpf") || filters.contains("cutoff"));
        // A delay method shouldn't show up under a filter-only query.
        assert!(!filters.contains("delayfeedback"));
    }

    #[test]
    fn kind_filter_functions_only() {
        let funcs = methods_listing(Some("function"), None);
        // `stack` is a free function; `jux` is a method.
        assert!(funcs.contains("stack"));
        assert!(!funcs.contains("\n  jux("));
    }
}
