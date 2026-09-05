//! Section-aware edits for `pickRestart({ … })` / `arrange({ … })` songs.
//!
//! Multi-section arrangements are usually one big object of named section
//! expressions, not `$:` tracks — so `upsert_track` can't touch "drop1". This
//! module maps section ids to source spans so the agent can rewrite one section
//! without re-emitting the whole song (the #1 latency win for iterative form
//! edits on Agency-style documents).

use crate::DocError;

/// Public view of one named section for `list_sections`.
#[derive(Debug, Clone)]
pub struct SectionInfo {
    pub id: String,
    /// 1-based order among sections in the object.
    pub index: usize,
    /// Inclusive start line, exclusive end line (0-based line indices).
    pub start_line: usize,
    pub end_line: usize,
    /// Byte range of the section's expression only (after `id:`).
    pub expr_start: usize,
    pub expr_end: usize,
    pub preview: String,
}

/// One section with full span metadata for splicing.
#[derive(Debug, Clone)]
struct Section {
    id: String,
    index: usize,
    /// Byte span of the entire `id: expr` entry (no trailing comma).
    entry_start: usize,
    entry_end: usize,
    expr_start: usize,
    expr_end: usize,
}

/// List named sections in the first top-level `pickRestart({…})` or
/// `arrange({…})` object. Empty if the document has no such form.
pub fn list_sections(code: &str) -> Vec<SectionInfo> {
    parse_sections(code)
        .into_iter()
        .map(|s| {
            let expr = &code[s.expr_start..s.expr_end];
            let preview = one_line_preview(expr, 80);
            let start_line = byte_to_line(code, s.entry_start);
            let end_line = byte_to_line(code, s.entry_end.saturating_sub(1)) + 1;
            SectionInfo {
                id: s.id,
                index: s.index,
                start_line,
                end_line,
                expr_start: s.expr_start,
                expr_end: s.expr_end,
                preview,
            }
        })
        .collect()
}

/// Replace one section's expression body. `expr` is only the section body
/// (e.g. `stack(s("bd*4"), …)`), not `drop1: …`. Returns the new document
/// and the section id written.
pub fn upsert_section(code: &str, handle: &str, expr: &str) -> Result<(String, String), DocError> {
    let expr = expr.trim();
    if expr.is_empty() {
        return Err(DocError::BadArgument(
            "upsert_section: 'code' is empty".to_string(),
        ));
    }
    let sections = parse_sections(code);
    if sections.is_empty() {
        return Err(DocError::NoStructure(
            "upsert_section: no section object found (const sections = {…} or \
             pickRestart/arrange). For `$:` tracks use upsert_track instead."
                .to_string(),
        ));
    }
    let key = clean_id(handle);
    let Some(sec) = sections
        .iter()
        .find(|s| clean_id(&s.id) == key || s.index.to_string() == handle.trim())
    else {
        let names: Vec<_> = sections.iter().map(|s| s.id.as_str()).collect();
        return Err(DocError::NotFound(format!(
            "no section matches '{handle}'. Sections: {}. Address by name or 1-based index.",
            names.join(", ")
        )));
    };

    // Keep surrounding whitespace style: replace only the expression span.
    let mut out = String::with_capacity(code.len() + expr.len());
    out.push_str(&code[..sec.expr_start]);
    out.push_str(expr);
    out.push_str(&code[sec.expr_end..]);
    Ok((out, sec.id.clone()))
}

/// Apply several section replacements left-to-right on byte offsets that are
/// re-resolved each time (safe when earlier patches change length).
pub fn upsert_sections(
    code: &str,
    patches: &[(String, String)],
) -> Result<(String, Vec<String>), DocError> {
    let mut doc = code.to_string();
    let mut wrote = Vec::with_capacity(patches.len());
    for (id, expr) in patches {
        let (next, w) = upsert_section(&doc, id, expr)?;
        doc = next;
        wrote.push(w);
    }
    Ok((doc, wrote))
}

fn clean_id(id: &str) -> String {
    id.trim()
        .trim_start_matches('@')
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn byte_to_line(code: &str, byte: usize) -> usize {
    code[..byte.min(code.len())]
        .bytes()
        .filter(|&b| b == b'\n')
        .count()
}

fn one_line_preview(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let t: String = flat.chars().take(max.saturating_sub(1)).collect();
        format!("{t}…")
    }
}

/// Locate editable section bodies.
///
/// Prefer fat definitions in `const sections = { intro: stack(...), … }` (the
/// MIDI-dump / composed-song shape) when `pickRestart` only holds thin aliases
/// like `intro: sections.intro`. Falling back to inline `pickRestart({…})`
/// bodies keeps Agency-style single-object songs working.
fn parse_sections(code: &str) -> Vec<Section> {
    let form = find_form_object(code)
        .map(|(a, b)| parse_object_entries(code, a, b))
        .unwrap_or_default();
    let binding_name = infer_sections_binding_name(code, &form);
    let binding = binding_name
        .as_deref()
        .and_then(|name| find_binding_object(code, name))
        .map(|(a, b)| parse_object_entries(code, a, b))
        .unwrap_or_default();

    if !binding.is_empty() {
        // Prefer binding when form is missing, empty, or only thin aliases.
        if form.is_empty() || form.iter().all(|s| is_thin_alias(code, s)) {
            return binding;
        }
        // Mixed: form has real bodies — keep form (inline pickRestart style).
        return form;
    }
    form
}

/// True when the section expr is only a dotted ref (`sections.intro`), not a
/// real stack/pattern body.
fn is_thin_alias(code: &str, s: &Section) -> bool {
    if s.expr_end <= s.expr_start || s.expr_end > code.len() {
        return true;
    }
    let e = code[s.expr_start..s.expr_end].trim();
    if e.is_empty() || !e.contains('.') {
        return false;
    }
    // `sections.intro` / `sec.drop1` — no calls, no operators.
    e.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
        && e.matches('.').count() == 1
}

/// Infer the binding that holds fat section bodies (`sections` in
/// `sections.intro` aliases, or a literal `const sections =`).
fn infer_sections_binding_name(code: &str, form: &[Section]) -> Option<String> {
    // From thin aliases in pickRestart.
    for s in form {
        if !is_thin_alias(code, s) {
            continue;
        }
        let e = code[s.expr_start..s.expr_end].trim();
        if let Some((prefix, field)) = e.split_once('.') {
            if clean_id(prefix) == clean_id(&s.id) || clean_id(field) == clean_id(&s.id) {
                return Some(prefix.to_string());
            }
            // intro: sections.intro → prefix sections
            if clean_id(field) == clean_id(&s.id) || s.id == *field {
                return Some(prefix.to_string());
            }
            return Some(prefix.to_string());
        }
    }
    // Common literal names even without pickRestart aliases.
    for name in ["sections", "section", "parts", "song", "form"] {
        if find_binding_object(code, name).is_some() {
            return Some(name.to_string());
        }
    }
    None
}

/// Return the interior byte range (exclusive of braces) of the object bound to
/// `name`. Prefers the real file parser (exact span for any binding name /
/// formatting); falls back to a hand-rolled `const NAME = {` scan when the
/// document doesn't parse or the binding isn't an object literal.
fn find_binding_object(code: &str, name: &str) -> Option<(usize, usize)> {
    if let Some(b) = crate::structure::find_binding(code, name)
        && let Some(range) = object_interior(code, b.expr_start, b.expr_end)
    {
        return Some(range);
    }
    find_binding_object_scan(code, name)
}

/// If the binding span `[expr_start, expr_end)` is an object literal, return the
/// interior byte range (after `{`, before the matching `}`).
fn object_interior(code: &str, expr_start: usize, expr_end: usize) -> Option<(usize, usize)> {
    let bytes = code.as_bytes();
    let mut i = expr_start;
    while i < expr_end && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= expr_end || bytes[i] != b'{' {
        return None;
    }
    let close = find_matching(code, i, b'{', b'}')?;
    if close >= expr_end {
        return None;
    }
    Some((i + 1, close))
}

/// Hand-rolled fallback: find `const name = {` / `let …` / `var …` and return
/// the object's interior byte range (exclusive of braces).
fn find_binding_object_scan(code: &str, name: &str) -> Option<(usize, usize)> {
    let bytes = code.as_bytes();
    let mut search_from = 0;
    while search_from < code.len() {
        let rest = &code[search_from..];
        let Some(rel) = rest.find(name) else {
            break;
        };
        let name_at = search_from + rel;
        let after = name_at + name.len();
        // Word boundaries around `name`.
        let before_ok = name_at == 0
            || (!bytes[name_at - 1].is_ascii_alphanumeric() && bytes[name_at - 1] != b'_');
        let after_ok =
            after >= bytes.len() || (!bytes[after].is_ascii_alphanumeric() && bytes[after] != b'_');
        if !before_ok || !after_ok {
            search_from = after;
            continue;
        }
        // Keyword immediately before (const/let/var), skipping whitespace.
        let mut j = name_at;
        while j > 0 && bytes[j - 1].is_ascii_whitespace() {
            j -= 1;
        }
        let kw_start = code[..j]
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map(|p| p + 1)
            .unwrap_or(0);
        let kw = &code[kw_start..j];
        if !matches!(kw, "const" | "let" | "var") {
            search_from = after;
            continue;
        }
        // After name: `= {`.
        let mut i = after;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            search_from = after;
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'{' {
            let body_start = i + 1;
            if let Some(close) = find_matching(code, i, b'{', b'}') {
                return Some((body_start, close));
            }
        }
        search_from = after;
    }
    None
}

/// Returns inclusive-exclusive byte range of the `{…}` body (inside braces).
fn find_form_object(code: &str) -> Option<(usize, usize)> {
    // Prefer pickRestart, then arrange.
    for needle in [".pickRestart(", "pickRestart(", ".arrange(", "arrange("] {
        let mut search_from = 0;
        while let Some(rel) = code[search_from..].find(needle) {
            let call = search_from + rel;
            let after_paren = call + needle.len();
            // Skip whitespace to the opening `{`.
            let mut i = after_paren;
            let bytes = code.as_bytes();
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'{' {
                let body_start = i + 1;
                if let Some(close) = find_matching(code, i, b'{', b'}') {
                    return Some((body_start, close));
                }
            }
            search_from = after_paren;
        }
    }
    None
}

/// Parse `id: expr` entries at the top level of `code[body_start..body_end]`.
fn parse_object_entries(code: &str, body_start: usize, body_end: usize) -> Vec<Section> {
    let mut out = Vec::new();
    let mut i = body_start;
    let bytes = code.as_bytes();
    let mut index = 0usize;

    while i < body_end {
        // Skip whitespace and commas.
        while i < body_end && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        if i >= body_end {
            break;
        }
        // Skip line comments.
        if bytes[i] == b'/' && i + 1 < body_end && bytes[i + 1] == b'/' {
            while i < body_end && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        // Identifier.
        let id_start = i;
        if !(bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
            // Can't parse — advance one to avoid infinite loop.
            i += 1;
            continue;
        }
        i += 1;
        while i < body_end && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
            i += 1;
        }
        let id = code[id_start..i].to_string();

        // Whitespace then `:`.
        while i < body_end && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= body_end || bytes[i] != b':' {
            continue;
        }
        i += 1; // skip ':'
        while i < body_end && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let expr_start = i;
        let expr_end = scan_expr_end(code, i, body_end);
        let entry_start = id_start;
        let entry_end = expr_end;
        index += 1;
        out.push(Section {
            id,
            index,
            entry_start,
            entry_end,
            expr_start,
            expr_end,
        });
        i = expr_end;
    }
    out
}

/// Scan one expression until a top-level comma or end of object body.
fn scan_expr_end(code: &str, start: usize, limit: usize) -> usize {
    let bytes = code.as_bytes();
    let mut i = start;
    let mut paren = 0i32;
    let mut bracket = 0i32;
    let mut brace = 0i32;
    let mut in_str: Option<u8> = None;
    let mut escape = false;

    while i < limit {
        let b = bytes[i];
        if let Some(q) = in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == q {
                in_str = None;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' | b'\'' | b'`' => in_str = Some(b),
            b'(' => paren += 1,
            b')' => paren -= 1,
            b'[' => bracket += 1,
            b']' => bracket -= 1,
            b'{' => brace += 1,
            b'}' => {
                if brace == 0 {
                    // End of the pickRestart object (shouldn't usually hit here
                    // because limit is before the closing brace).
                    return i;
                }
                brace -= 1;
            }
            b',' if paren == 0 && bracket == 0 && brace == 0 => return i,
            b'/' if i + 1 < limit
                && bytes[i + 1] == b'/'
                && paren == 0
                && bracket == 0
                && brace == 0 =>
            {
                // Line comment at top level of expr (rare) — skip to EOL.
                while i < limit && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    // Trim trailing whitespace from the expression span.
    let mut end = i;
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    end
}

/// Find the index of the matching closer for `open` at `open_idx`.
fn find_matching(code: &str, open_idx: usize, open: u8, close: u8) -> Option<usize> {
    let bytes = code.as_bytes();
    if open_idx >= bytes.len() || bytes[open_idx] != open {
        return None;
    }
    let mut depth = 0i32;
    let mut in_str: Option<u8> = None;
    let mut escape = false;
    #[expect(
        clippy::needless_range_loop,
        reason = "i is also the returned span position, not just an index"
    )]
    for i in open_idx..bytes.len() {
        let b = bytes[i];
        if let Some(q) = in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == q {
                in_str = None;
            }
            continue;
        }
        match b {
            b'"' | b'\'' | b'`' => in_str = Some(b),
            c if c == open => depth += 1,
            c if c == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"setbpm(132);
"<intro@1 drop1@2 outro@1>".slow(4).pickRestart({
  intro: stack(
    s("bd*4").gain(0.8),
    note("g#1").s("sine")
  ),
  drop1: stack(
    s("bd*4").gain(1.2),
    s("sd*2")
  ),
  outro: note("g#1").s("sine").gain(0.3)
})
"#;

    #[test]
    fn lists_three_sections() {
        let secs = list_sections(SAMPLE);
        assert_eq!(secs.len(), 3);
        assert_eq!(secs[0].id, "intro");
        assert_eq!(secs[1].id, "drop1");
        assert_eq!(secs[2].id, "outro");
        assert!(secs[1].preview.contains("stack"));
    }

    #[test]
    fn upsert_replaces_only_one_section() {
        let (new_code, id) = upsert_section(SAMPLE, "drop1", r#"s("bd*8").gain(2.0)"#).unwrap();
        assert_eq!(id, "drop1");
        assert!(new_code.contains(r#"drop1: s("bd*8").gain(2.0)"#));
        // Other sections untouched.
        assert!(new_code.contains("intro: stack("));
        assert!(new_code.contains(r#"outro: note("g#1")"#));
        // Old drop1 body gone.
        assert!(!new_code.contains(r#"s("sd*2")"#));
    }

    #[test]
    fn upsert_by_index() {
        let (new_code, id) = upsert_section(SAMPLE, "1", r#"s("hh*8")"#).unwrap();
        assert_eq!(id, "intro");
        assert!(new_code.contains(r#"intro: s("hh*8")"#));
    }

    #[test]
    fn multi_upsert_preserves_order() {
        let patches = vec![
            ("intro".into(), r#"s("bd")"#.into()),
            ("outro".into(), r#"s("sd")"#.into()),
        ];
        let (new_code, wrote) = upsert_sections(SAMPLE, &patches).unwrap();
        assert_eq!(wrote, vec!["intro", "outro"]);
        assert!(new_code.contains(r#"intro: s("bd")"#));
        assert!(new_code.contains(r#"outro: s("sd")"#));
        assert!(new_code.contains("drop1: stack("));
    }

    #[test]
    fn missing_section_errors_with_names() {
        let err = upsert_section(SAMPLE, "verse", "x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("drop1"));
        assert!(err.contains("intro"));
    }

    #[test]
    fn no_form_errors_clearly() {
        let err = upsert_section(r#"$: s("bd*4") // @drums"#, "drums", "x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("upsert_track"));
    }

    #[test]
    fn poker_face_shaped_fixture_lists_all_keys() {
        // Minimal shape matching the real Agency song (selector + many keys).
        let code = r#"
"<intro@1 machine@2 drop1@2 outro@1>".slow(4).pickRestart({
  intro: stack(s("bd")),
  machine: stack(s("bd*4"), s("hh*8")),
  drop1: stack(s("bd*4").gain(1.5), s("industrial*4")),
  outro: s("bd")
})
"#;
        let secs = list_sections(code);
        let ids: Vec<_> = secs.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["intro", "machine", "drop1", "outro"]);
    }

    /// MIDI-dump shape from live telemetry: fat bodies in `const sections`,
    /// thin `sections.X` aliases in pickRestart. list/upsert must hit the fat
    /// bodies or the agent rewrites the whole file.
    const MIDI_DUMP_SHAPE: &str = r#"setbpm(128);
const sections = {
  intro: stack(
    s("bd*4").gain(0.5),
    note("g#2").s("sawtooth")
  ),
  drop1: stack(
    s("bd*4").gain(0.9),
    s("sd*2")
  ),
  outro: note("g#1").s("sine").gain(0.2)
};
$: "<intro@1 drop1@2 outro@1>".slow(4).pickRestart({
  intro: sections.intro,
  drop1: sections.drop1,
  outro: sections.outro
})
"#;

    #[test]
    fn midi_dump_lists_fat_const_sections_not_aliases() {
        let secs = list_sections(MIDI_DUMP_SHAPE);
        assert_eq!(
            secs.len(),
            3,
            "previews: {:?}",
            secs.iter().map(|s| &s.preview).collect::<Vec<_>>()
        );
        assert_eq!(secs[0].id, "intro");
        // Must show the stack body, not `sections.intro`.
        assert!(
            secs[0].preview.contains("stack") || secs[0].preview.contains("bd"),
            "preview should be fat body, got: {}",
            secs[0].preview
        );
        assert!(!secs[0].preview.starts_with("sections."));
    }

    #[test]
    fn midi_dump_upsert_rewrites_const_body() {
        let (new_code, id) =
            upsert_section(MIDI_DUMP_SHAPE, "drop1", r#"s("bd*8").gain(1.4)"#).unwrap();
        assert_eq!(id, "drop1");
        assert!(new_code.contains(r#"drop1: s("bd*8").gain(1.4)"#));
        // Alias line in pickRestart unchanged.
        assert!(new_code.contains("drop1: sections.drop1"));
        // Other fat bodies intact.
        assert!(new_code.contains("intro: stack("));
        assert!(!new_code.contains(r#"s("sd*2")"#));
    }

    /// The section binding does not use a conventional name — discovery must
    /// resolve it from the alias prefix (`arrangement.intro`) and, via the AST,
    /// locate the `const arrangement` object regardless of the hardcoded list.
    const NON_STANDARD_BINDING: &str = r#"setbpm(124);
const arrangement = {
  intro: stack(s("bd*4").gain(0.4)),
  build: stack(s("bd*4"), s("hh*16"))
};
$: "<intro build>".slow(2).pickRestart({
  intro: arrangement.intro,
  build: arrangement.build
})
"#;

    #[test]
    fn resolves_non_hardcoded_binding_name() {
        let secs = list_sections(NON_STANDARD_BINDING);
        assert_eq!(secs.len(), 2);
        assert!(
            !secs[0].preview.starts_with("arrangement."),
            "got: {}",
            secs[0].preview
        );
        assert!(
            secs[1].preview.contains("hh*16"),
            "got: {}",
            secs[1].preview
        );

        let (new_code, id) = upsert_section(NON_STANDARD_BINDING, "build", r#"s("cp*4")"#).unwrap();
        assert_eq!(id, "build");
        assert!(new_code.contains(r#"build: s("cp*4")"#));
        assert!(new_code.contains("build: arrangement.build")); // alias untouched
        assert!(!new_code.contains("hh*16"));
    }
}
