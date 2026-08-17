//! AST-backed discovery + span-preserving splices for top-level bindings.
//!
//! `sections.rs` handles named sections inside `pickRestart`/`arrange`; this
//! module handles the *bindings* those sections often live in (`const sections
//! = {…}`) and standalone helper consts (shared gain buses, synth/kit defs).
//!
//! Discovery uses the real strudel-rs file parser (`parse_strudel_file`), which
//! yields each binding's name plus the byte offset of its expression — so we get
//! an exact span instead of guessing with a hand-rolled `const NAME = {` scan.
//! Unlike a scan, this also spans non-object bindings (`const lead = note(…)`).
//!
//! Edits are pure byte splices: only the target binding's expression range
//! changes; every other byte stays identical (same philosophy as `tracks.rs` /
//! `sections.rs`). Correctness of the *result* is still enforced by the caller
//! re-validating the whole buffer through the real evaluator before it plays.

use strudel_dsl::parse_strudel_file;

/// Public view of one top-level binding.
#[derive(Debug, Clone)]
pub struct BindingInfo {
    pub name: String,
    /// Byte range of the binding's expression body (the RHS of `=`); end
    /// exclusive.
    pub expr_start: usize,
    pub expr_end: usize,
}

/// Enumerate top-level `const`/`let`/`var` bindings via the real file parser.
///
/// Returns empty when the document does not parse — callers fall back to a
/// brace-scan so a mid-edit malformed buffer never loses functionality. The
/// expression span is `source_offset .. source_offset + expr_str.len()`.
pub fn list_bindings(code: &str) -> Vec<BindingInfo> {
    let Ok(file) = parse_strudel_file(code) else {
        return Vec::new();
    };
    file.bindings
        .iter()
        .filter_map(|b| {
            let start = b.source_offset;
            let end = start + b.expr_str.len();
            // Defensive: offsets must stay in-bounds and on char boundaries.
            if end > code.len() || !code.is_char_boundary(start) || !code.is_char_boundary(end) {
                return None;
            }
            Some(BindingInfo {
                name: b.name.to_string(),
                expr_start: start,
                expr_end: end,
            })
        })
        .collect()
}

/// Find a binding by name — exact match first, then case-insensitive.
pub fn find_binding(code: &str, name: &str) -> Option<BindingInfo> {
    let want = name.trim();
    let bindings = list_bindings(code);
    bindings
        .iter()
        .find(|b| b.name == want)
        .or_else(|| bindings.iter().find(|b| b.name.eq_ignore_ascii_case(want)))
        .cloned()
}

/// Pure byte splice of `[start, end)` with `new`. Bounds-checked: an
/// out-of-range or non-char-boundary span returns the input unchanged. An
/// identity replace (`new == &code[start..end]`) is byte-identical.
pub fn replace_span(code: &str, start: usize, end: usize, new: &str) -> String {
    if start > end
        || end > code.len()
        || !code.is_char_boundary(start)
        || !code.is_char_boundary(end)
    {
        return code.to_string();
    }
    let mut out = String::with_capacity(code.len() - (end - start) + new.len());
    out.push_str(&code[..start]);
    out.push_str(new);
    out.push_str(&code[end..]);
    out
}

/// Replace one binding's whole expression body. `expr` is the new RHS only
/// (e.g. `{ … }`, or `note("c").s("sine")`), NOT `const name =`. Everything
/// else stays byte-identical. Returns the new document and the binding name.
pub fn upsert_binding(code: &str, name: &str, expr: &str) -> Result<(String, String), String> {
    let expr = expr.trim();
    if expr.is_empty() {
        return Err("upsert_binding: 'code' is empty".to_string());
    }
    let Some(b) = find_binding(code, name) else {
        let names: Vec<_> = list_bindings(code).into_iter().map(|b| b.name).collect();
        if names.is_empty() {
            return Err(
                "upsert_binding: no top-level const/let bindings found (or the document \
                 does not parse). To edit a track use upsert_track; a section, upsert_section."
                    .to_string(),
            );
        }
        return Err(format!(
            "no binding matches '{}'. Bindings: {}.",
            name.trim(),
            names.join(", ")
        ));
    };
    let out = replace_span(code, b.expr_start, b.expr_end, expr);
    Ok((out, b.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"setbpm(128);
const sections = {
  intro: stack(s("bd*4")),
  drop1: stack(s("bd*4"), s("sd*2"))
};
const lead = note("c e g").s("sawtooth").gain(0.6);
$: "<intro drop1>".pickRestart({
  intro: sections.intro,
  drop1: sections.drop1
})
"#;

    #[test]
    fn lists_both_bindings() {
        let bs = list_bindings(DOC);
        let names: Vec<_> = bs.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["sections", "lead"]);
        // Spans point at the RHS body.
        assert!(DOC[bs[0].expr_start..bs[0].expr_end].starts_with('{'));
        assert!(DOC[bs[1].expr_start..bs[1].expr_end].starts_with("note("));
    }

    #[test]
    fn find_binding_matches_name() {
        let b = find_binding(DOC, "lead").expect("lead binding");
        assert_eq!(b.name, "lead");
        assert_eq!(
            &DOC[b.expr_start..b.expr_end],
            r#"note("c e g").s("sawtooth").gain(0.6)"#
        );
    }

    #[test]
    fn upsert_replaces_only_that_binding() {
        let (out, name) = upsert_binding(DOC, "lead", r#"note("a").s("sine")"#).unwrap();
        assert_eq!(name, "lead");
        assert!(out.contains(r#"const lead = note("a").s("sine");"#));
        // The object binding and the pickRestart aliases are untouched.
        assert!(out.contains("const sections = {"));
        assert!(out.contains("intro: sections.intro"));
        // Old lead body gone.
        assert!(!out.contains(r#"c e g"#));
    }

    #[test]
    fn upsert_object_binding_body() {
        let (out, _) = upsert_binding(DOC, "sections", "{ intro: stack(s(\"hh*8\")) }").unwrap();
        assert!(out.contains("const sections = { intro: stack(s(\"hh*8\")) };"));
        assert!(!out.contains("drop1: stack("));
        // lead untouched.
        assert!(out.contains(r#"const lead = note("c e g")"#));
    }

    #[test]
    fn identity_replace_is_byte_identical() {
        let b = find_binding(DOC, "sections").unwrap();
        let same = replace_span(
            DOC,
            b.expr_start,
            b.expr_end,
            &DOC[b.expr_start..b.expr_end],
        );
        assert_eq!(same, DOC);
    }

    #[test]
    fn missing_binding_errors_with_names() {
        let err = upsert_binding(DOC, "bass", "x").unwrap_err();
        assert!(err.contains("sections"));
        assert!(err.contains("lead"));
    }

    #[test]
    fn spans_are_always_sliceable() {
        // Whatever the (tolerant) parser returns on odd/partial input, every
        // reported span must be in-bounds and on char boundaries so callers can
        // slice/splice without panicking — the safety contract behind the
        // brace-scan fallback in sections.rs.
        for src in [
            "const x = { intro: stack(", // never closes
            "!!! not strudel @@@",
            "const a = s(\"bd\"); const b = ",
            "🎵 const emoji = note(\"c\");",
        ] {
            for b in list_bindings(src) {
                assert!(b.expr_end <= src.len());
                assert!(src.is_char_boundary(b.expr_start));
                assert!(src.is_char_boundary(b.expr_end));
                let _ = &src[b.expr_start..b.expr_end]; // must not panic
            }
        }
    }

    #[test]
    fn replace_span_out_of_range_is_noop() {
        assert_eq!(replace_span("abc", 2, 99, "Z"), "abc");
        assert_eq!(replace_span("abc", 5, 6, "Z"), "abc");
    }
}
