//! Deterministic, zero-semantic-risk repair of the *mechanical* mistakes that
//! make otherwise-good strudel-rs code fail to parse or go silent — the top
//! parse errors documented in `prompts/system.md`.
//!
//! This is the belt to `validate_code`'s suspenders. The agent is *expected* to
//! validate before playing, but nothing forces it, so raw model output can reach
//! the editor. `sanitize_source` fixes the handful of errors that have a single
//! unambiguous correct rewrite, and only ever rewrites constructs that are
//! *already invalid* in strudel-rs — valid code passes through untouched.
//! Everything it can't safely fix is left for `validate_code` to reject.
//!
//! No regex dependency: the workspace has none, so these are hand-rolled scans.

/// Result of [`sanitize_source`]: the repaired code plus one human-readable note
/// per substitution applied (empty `notes` when nothing was touched).
#[derive(Debug, Clone, Default)]
pub struct Sanitized {
    pub code: String,
    pub notes: Vec<String>,
}

/// Curated *true-synonym* aliases: web-strudel / common-LLM sound names that
/// each have exactly one correct strudel-rs equivalent. These are renames of the
/// same instrument (`kick` IS `bd`), never lossy guesses (`chirp` → `hh` is not
/// here — that changes the sound). Every target is in the built-in catalog, and
/// the remap is *also* catalog-gated at call time (see [`remap_sounds`]) so it
/// can never introduce a name the engine can't play.
const SOUND_ALIASES: &[(&str, &str)] = &[
    // Long drum names → strudel-rs abbreviations (targets ∈ DEFAULT_DRUMS).
    ("kick", "bd"),
    ("snare", "sd"),
    ("clap", "cp"),
    ("hat", "hh"),
    ("hihat", "hh"),
    ("openhat", "oh"),
    ("crash", "cr"),
    ("cowbell", "cb"),
    ("rimshot", "rs"),
    ("ride", "rd"),
    ("clave", "cl"),
    ("claves", "cl"),
    ("maracas", "ma"),
    ("shaker", "sh"),
    ("tambourine", "tb"),
    ("piano", "gm_piano"),
    // GM soundfont: web-strudel's long name → strudel-rs's short name.
    ("gm_electric_piano_1", "gm_epiano1"),
];

/// The full pre-playback gate: context-free repairs ([`sanitize_source`]) plus
/// catalog-backed sound-alias remapping ([`remap_sounds`]). This is what the
/// agent's `play_pattern` runs; `known` is the resolvable sound set
/// (`sounds::builtin_sound_set` + any user-loaded banks).
pub fn sanitize_source_with_catalog(input: &str, known: &crate::sounds::SoundSet) -> Sanitized {
    let mut s = sanitize_source(input);
    let remapped = remap_sounds(&s.code, known);
    s.code = remapped.code;
    s.notes.extend(remapped.notes);
    s
}

/// Repair the mechanical mistakes with a single correct rewrite (fences, arrow
/// params, negative pan). Context-free — no sound catalog needed. For the
/// catalog-backed sound remapping too, use [`sanitize_source_with_catalog`].
pub fn sanitize_source(input: &str) -> Sanitized {
    let mut code = input.to_string();
    let mut notes = Vec::new();

    // 1. Stray markdown code fences that leaked into the tool argument.
    if let Some(stripped) = strip_fences(&code) {
        code = stripped;
        notes.push("Stripped markdown code fences from the pattern.".to_string());
    }

    // 2. Parenthesised arrow params are a parse error in strudel-rs:
    //    `.every(2, (x) => x.fast(2))` must be `.every(2, x => x.fast(2))`.
    let (c, n) = strip_arrow_parens(&code);
    if n > 0 {
        code = c;
        notes.push(format!(
            "Removed parentheses around {n} arrow-function parameter(s) (`(x) =>` → `x =>`)."
        ));
    }

    // 3. Negative literal pan is sqrt(-x) = NaN in the panner → the event is
    //    completely silent. Pan is 0..1 in strudel-rs; clamp a bare negative
    //    literal to 0 (hard left, but audible).
    let (c, n) = clamp_negative_pan(&code);
    if n > 0 {
        code = c;
        notes.push(format!(
            "Clamped {n} negative `.pan(...)` literal(s) to 0 (pan is 0..1; negative is silent)."
        ));
    }

    Sanitized { code, notes }
}

/// Drop any line whose first non-space content is a ``` fence. Returns `Some`
/// only when a fence was present, so callers can note the substitution.
fn strip_fences(code: &str) -> Option<String> {
    if !code.contains("```") {
        return None;
    }
    Some(
        code.lines()
            .filter(|line| !line.trim_start().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Rewrite `( ident ) =>` to `ident =>`. Only touches a *single* bare
/// identifier inside the parens — multi-arg `(a, b) =>` or destructuring is
/// left alone (strudel-rs callbacks are single-arg, and touching those would be
/// a guess). Returns the new code and how many params were unwrapped.
fn strip_arrow_parens(code: &str) -> (String, usize) {
    let bytes = code.as_bytes();
    // (start, end) byte span of the `(...)` to replace, plus its inner ident.
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut i = 0;
    while let Some(rel) = code[i..].find("=>") {
        let arrow = i + rel;
        // Walk left over whitespace to the char before `=>`.
        let mut j = arrow;
        while j > 0 && bytes[j - 1].is_ascii_whitespace() {
            j -= 1;
        }
        if j > 0 && bytes[j - 1] == b')' {
            let close = j - 1;
            if let Some(open) = matching_open_paren(bytes, close) {
                let inner = code[open + 1..close].trim();
                if is_single_identifier(inner) {
                    edits.push((open, close + 1, inner.to_string()));
                }
            }
        }
        i = arrow + 2;
    }
    apply_edits(code, edits)
}

/// Replace a bare negative numeric argument to `.pan(` with `0`. A non-literal
/// arg like `.pan(sine.range(-0.3, 0.3))` starts with `s`, not `-`, so it is
/// left untouched (the event-level pan lint still flags it).
fn clamp_negative_pan(code: &str) -> (String, usize) {
    const NEEDLE: &str = ".pan(";
    let bytes = code.as_bytes();
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut search = 0;
    while let Some(rel) = code[search..].find(NEEDLE) {
        let open = search + rel + NEEDLE.len() - 1; // index of '('
        let mut a = open + 1;
        while a < bytes.len() && bytes[a].is_ascii_whitespace() {
            a += 1;
        }
        if a < bytes.len() && bytes[a] == b'-' {
            // Parse `-` digits/`.` — a bare numeric literal.
            let mut b = a + 1;
            let mut saw_digit = false;
            while b < bytes.len() && (bytes[b].is_ascii_digit() || bytes[b] == b'.') {
                saw_digit |= bytes[b].is_ascii_digit();
                b += 1;
            }
            // The literal must be the whole argument: next non-ws is `)`.
            let mut c = b;
            while c < bytes.len() && bytes[c].is_ascii_whitespace() {
                c += 1;
            }
            if saw_digit && c < bytes.len() && bytes[c] == b')' {
                edits.push((a, b, "0".to_string()));
            }
        }
        search = open + 1;
    }
    apply_edits(code, edits)
}

/// Remap known-wrong sound names ([`SOUND_ALIASES`]) to their strudel-rs
/// equivalent. Guarded on both ends:
///   - the wrong name is only remapped when it is *not itself* a resolvable
///     sound (so a user bank literally named `kick` is left alone);
///   - the target is only used when it is actually playable (in `known`, or a
///     `gm_*` name that streams on demand) — the "catalog-backed" guarantee.
///
/// Replacements are confined to the inside of double-quoted mini-notation
/// strings, so identifiers (`let kick = …`), method names, and comments are
/// never touched. Whole-word matching keeps suffixes like `:2` and `*4` intact.
pub fn remap_sounds(code: &str, known: &crate::sounds::SoundSet) -> Sanitized {
    let spans = string_spans(code);
    let mut all_edits: Vec<(usize, usize, String)> = Vec::new();
    let mut notes = Vec::new();

    for (wrong, right) in SOUND_ALIASES {
        // Don't clobber a name that genuinely resolves (e.g. a user bank).
        if known.contains(wrong) {
            continue;
        }
        // Catalog-backed: never map to a name the engine can't play.
        if !(known.contains(right) || right.starts_with("gm_")) {
            continue;
        }
        let edits = word_boundary_edits(code, &spans, wrong, right);
        if !edits.is_empty() {
            notes.push(format!(
                "Remapped {} occurrence(s) of unsupported sound `{wrong}` to `{right}`.",
                edits.len()
            ));
            all_edits.extend(edits);
        }
    }

    let (out, _) = apply_edits(code, all_edits);
    Sanitized { code: out, notes }
}

/// Byte spans (start, end) of the *contents* of each double-quoted string in
/// `code`, honouring `\"` escapes. Used to confine sound remapping to
/// mini-notation literals.
fn string_spans(code: &str) -> Vec<(usize, usize)> {
    let bytes = code.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // `//` comments hold prose ("the piano line"), not mini-notation —
        // skip to end of line so their words are never remapped.
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // JS-strudel sources use all three quote styles; unterminated strings
        // are left unspanned rather than swallowing the rest of the file.
        let quote = bytes[i];
        if quote == b'"' || quote == b'\'' || quote == b'`' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j] != quote {
                j += if bytes[j] == b'\\' { 2 } else { 1 };
            }
            if j < bytes.len() && bytes[j] == quote {
                spans.push((start, j));
                i = j + 1;
            } else {
                i = start;
            }
        } else {
            i += 1;
        }
    }
    spans
}

/// Whole-word occurrences of `needle` that fall entirely inside one of `spans`,
/// as `(start, end, repl)` edits. Word boundaries use identifier chars, so
/// `hat` never matches inside `hihat` and `kick` never matches `kickPattern`.
fn word_boundary_edits(
    code: &str,
    spans: &[(usize, usize)],
    needle: &str,
    repl: &str,
) -> Vec<(usize, usize, String)> {
    let bytes = code.as_bytes();
    let mut edits = Vec::new();
    let mut from = 0;
    while let Some(rel) = code[from..].find(needle) {
        let start = from + rel;
        let end = start + needle.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok && spans.iter().any(|(s, e)| start >= *s && end <= *e) {
            edits.push((start, end, repl.to_string()));
        }
        from = end;
    }
    edits
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Apply span replacements right-to-left so earlier byte offsets stay valid.
fn apply_edits(code: &str, mut edits: Vec<(usize, usize, String)>) -> (String, usize) {
    if edits.is_empty() {
        return (code.to_string(), 0);
    }
    let count = edits.len();
    edits.sort_by_key(|(start, _, _)| *start);
    let mut out = code.to_string();
    for (start, end, repl) in edits.into_iter().rev() {
        out.replace_range(start..end, &repl);
    }
    (out, count)
}

/// Find the `(` matching the `)` at `close` by scanning left with a depth count.
fn matching_open_paren(bytes: &[u8], close: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut k = close;
    loop {
        match bytes[k] {
            b')' => depth += 1,
            b'(' => {
                depth -= 1;
                if depth == 0 {
                    return Some(k);
                }
            }
            _ => {}
        }
        if k == 0 {
            return None;
        }
        k -= 1;
    }
}

/// True for a single JS-style identifier (`x`, `_p`, `$foo`) — rejects commas,
/// dots, whitespace, and anything multibyte.
fn is_single_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_valid_code_untouched() {
        let code = "s(\"bd*4\").every(2, x => x.fast(2)).pan(sine.range(0.2, 0.8))";
        let out = sanitize_source(code);
        assert_eq!(out.code, code);
        assert!(out.notes.is_empty());
    }

    #[test]
    fn strips_arrow_parens() {
        let out = sanitize_source("x.every(2, (x) => x.fast(2))");
        assert_eq!(out.code, "x.every(2, x => x.fast(2))");
        assert_eq!(out.notes.len(), 1);
    }

    #[test]
    fn leaves_multi_arg_arrow_alone() {
        let code = "foo((a, b) => a + b)";
        assert_eq!(sanitize_source(code).code, code);
    }

    #[test]
    fn clamps_negative_literal_pan() {
        let out = sanitize_source("s(\"bd\").pan(-0.3)");
        assert_eq!(out.code, "s(\"bd\").pan(0)");
        assert_eq!(out.notes.len(), 1);
    }

    #[test]
    fn leaves_non_literal_pan_alone() {
        let code = "s(\"bd\").pan(sine.range(-0.3, 0.3))";
        assert_eq!(sanitize_source(code).code, code);
    }

    #[test]
    fn strips_fences() {
        let out = sanitize_source("```strudel\ns(\"bd*4\")\n```");
        assert_eq!(out.code, "s(\"bd*4\")");
        assert_eq!(out.notes.len(), 1);
    }

    #[test]
    fn repairs_compose() {
        let out = sanitize_source("```\ns(\"bd\").every(2, (x) => x.fast(2)).pan(-0.5)\n```");
        assert_eq!(out.code, "s(\"bd\").every(2, x => x.fast(2)).pan(0)");
        assert_eq!(out.notes.len(), 3);
    }

    fn builtin() -> crate::sounds::SoundSet {
        crate::sounds::SoundSet::builtin_only()
    }

    #[test]
    fn remaps_drum_aliases_inside_strings() {
        let out = remap_sounds("s(\"kick snare hat clap\")", &builtin());
        assert_eq!(out.code, "s(\"bd sd hh cp\")");
        assert_eq!(out.notes.len(), 4);
    }

    #[test]
    fn remap_keeps_mini_notation_suffixes() {
        let out = remap_sounds("s(\"kick*4 snare:2\")", &builtin());
        assert_eq!(out.code, "s(\"bd*4 sd:2\")");
    }

    #[test]
    fn remap_does_not_match_inside_longer_word() {
        // `hat` must not fire inside `hihat`, which is its own alias → `hh`.
        let out = remap_sounds("s(\"hihat\")", &builtin());
        assert_eq!(out.code, "s(\"hh\")");
    }

    #[test]
    fn remap_leaves_identifiers_and_comments_alone() {
        let code = "// a kick pattern\nlet kick = s(\"bd\")";
        let out = remap_sounds(code, &builtin());
        assert_eq!(out.code, code);
        assert!(out.notes.is_empty());
    }

    #[test]
    fn remap_respects_a_loaded_bank_of_the_same_name() {
        let known = crate::sounds::SoundSet::with_user_banks(vec!["kick".to_string()]);
        let code = "s(\"kick sd\")";
        assert_eq!(remap_sounds(code, &known).code, code);
    }

    #[test]
    fn remap_skips_when_target_not_playable() {
        // Empty catalog: `bd` is not playable → no remap (catalog-backed guard).
        let out = remap_sounds("s(\"kick\")", &crate::sounds::SoundSet::empty());
        assert_eq!(out.code, "s(\"kick\")");
        assert!(out.notes.is_empty());
    }

    #[test]
    fn remaps_gm_long_name() {
        let out = remap_sounds("note(\"c3\").s(\"gm_electric_piano_1\")", &builtin());
        assert_eq!(out.code, "note(\"c3\").s(\"gm_epiano1\")");
    }

    #[test]
    fn with_catalog_runs_both_passes() {
        let out = sanitize_source_with_catalog("s(\"kick\").pan(-0.2)", &builtin());
        assert_eq!(out.code, "s(\"bd\").pan(0)");
        assert_eq!(out.notes.len(), 2);
    }
}
