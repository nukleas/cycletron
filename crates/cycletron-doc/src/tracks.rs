//! Track-aware document model — the backbone of the agent's *surgical* editing.
//!
//! A `.strudel` document is a preamble (directives / comments) followed by one
//! or more **tracks**: `$:`-prefixed lines that the engine stacks together (a
//! bare top-level expression counts as one implicit track). Historically the
//! only agent→audio path replaced the *entire* buffer, so "add a bass" rewrote
//! the whole song. This module lets the agent address one track by a stable id
//! and rewrite only that track's text, leaving every other line byte-identical.
//!
//! # Addressing
//! A track carries an id via a trailing `// @<id>` marker (the canonical form the
//! agent writes: `$: s("bd*4") // @drums`). A pre-existing labeled track
//! (`drums: s("bd*4")`) is recognised too, with id = the label. Tracks with no
//! id are addressable by 1-based index.
//!
//! # Mute
//! Muting prefixes each of a track's lines with the sentinel `//@mute ` (no space
//! after the slashes — distinct from the `// @id` marker, which requires the
//! space). The line becomes a comment the lexer ignores, so the track goes
//! silent while its text — and its id — are preserved for un-muting.
//!
//! Every operation is *text/line-span* based: untouched tracks are never
//! reparsed or reformatted (unlike round-tripping through the AST's `Display`,
//! which would normalise the whole file). Correctness of the *result* is still
//! enforced by the caller, which re-validates the full buffer through the real
//! evaluator before anything reaches audio — so this module can be coarse on
//! exotic input without ever injecting broken code.

/// The `//@mute ` sentinel prefix a muted track's lines carry.
const MUTE: &str = "//@mute ";

/// How a track is written in the source — affects how we re-emit a replacement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackKind {
    /// `$: <expr>` line.
    Dollar,
    /// `label: <expr>` line (id = label).
    Labeled,
    /// A bare top-level expression (no `$:`/label) — one implicit track.
    Bare,
}

/// One addressable track, mapped to its source line span `[start, end)`.
#[derive(Debug, Clone)]
struct Track {
    id: Option<String>,
    /// 1-based position among tracks.
    index: usize,
    muted: bool,
    kind: TrackKind,
    /// Inclusive start line, exclusive end line (indices into the line vec).
    start: usize,
    end: usize,
}

/// Public, serialisable view of a track for the `list_parts` tool.
#[derive(Debug, Clone)]
pub struct TrackInfo {
    pub id: Option<String>,
    pub index: usize,
    pub muted: bool,
    /// A short single-line preview of the track's code.
    pub preview: String,
}

/// True when a trimmed line begins a `$:` or `label:` track (mute sentinel
/// stripped first). Directives like `setbpm(120);` are `name(…)`, never
/// `name:`, so they don't match.
fn anchor_id(trimmed: &str) -> Option<(TrackKind, Option<String>)> {
    let t = trimmed.strip_prefix(MUTE).unwrap_or(trimmed).trim_start();
    if let Some(rest) = t.strip_prefix("$:") {
        return Some((TrackKind::Dollar, marker_id(rest)));
    }
    // `label:` — identifier then a single colon (not `::`).
    let mut chars = t.char_indices();
    let mut end = 0;
    let mut seen = false;
    for (i, c) in chars.by_ref() {
        if c == '_' || c.is_ascii_alphanumeric() {
            end = i + c.len_utf8();
            seen = true;
        } else {
            break;
        }
    }
    if seen {
        let after = &t[end..];
        let after_trim = after.trim_start();
        if let Some(rest) = after_trim.strip_prefix(':') {
            if !rest.starts_with(':') {
                let label = t[..end].to_ascii_lowercase();
                // A `// @id` marker still wins over the label if both are present.
                let id = marker_id(rest).or(Some(label));
                return Some((TrackKind::Labeled, id));
            }
        }
    }
    None
}

/// Extract the id from a `// @<id>` marker anywhere in `text` (requires the space
/// after `//`, so it never collides with the `//@mute` sentinel). Ids are
/// lowercased and limited to `[a-z0-9_-]`.
fn marker_id(text: &str) -> Option<String> {
    let at = text.find("// @")? + "// @".len();
    let id: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>()
        .to_ascii_lowercase();
    if id.is_empty() { None } else { Some(id) }
}

/// Is this a preamble line — a directive, a standalone comment, or blank —
/// i.e. content that lives *before* the first track and is never itself a track?
/// A muted track (`//@mute $: …`) is a comment textually but IS a track, so it
/// is explicitly excluded.
fn is_preamble_line(line: &str) -> bool {
    let t = line.trim();
    if anchor_id(t).is_some() {
        return false;
    }
    t.is_empty() || t.starts_with("//") || is_directive(t)
}

/// A purely-numeric handle (`"2"`, `"@3"`) addresses a track by 1-based index;
/// anything else is an id.
fn is_index_handle(handle: &str) -> bool {
    let h = handle.trim().trim_start_matches('@');
    !h.is_empty() && h.chars().all(|c| c.is_ascii_digit())
}

/// `setbpm(120);` / `setcps(…)` / `hush` etc. — top-of-file directives.
fn is_directive(trimmed: &str) -> bool {
    const DIRECTIVES: &[&str] = &["setbpm", "setcps", "setcpm", "hush", "samples"];
    DIRECTIVES.iter().any(|d| {
        trimmed == *d
            || trimmed.starts_with(&format!("{d}("))
            || trimmed.starts_with(&format!("{d} "))
    })
}

/// Parse `code` into its tracks. Preamble (leading directives/comments/blanks)
/// is excluded; the first content line starts the track region. `$:`/label lines
/// each begin a track; a leading bare expression is one implicit track; lines
/// after an anchor that aren't themselves anchors fold into that anchor's span
/// (so multi-line `$:` bodies are captured verbatim).
fn parse_tracks(code: &str) -> Vec<Track> {
    let lines: Vec<&str> = code.lines().collect();

    // Find where the track region begins: first non-preamble line.
    let mut i = 0;
    while i < lines.len() && is_preamble_line(lines[i]) {
        i += 1;
    }
    if i >= lines.len() {
        return Vec::new();
    }

    let mut tracks: Vec<Track> = Vec::new();
    let mut index = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        let muted = trimmed.starts_with(MUTE);
        let anchor = anchor_id(trimmed);

        // A bare expression only starts an implicit track when it is the FIRST
        // track (before any anchor); otherwise trailing bare lines fold into the
        // preceding track below.
        let starts_track = anchor.is_some() || (tracks.is_empty() && !is_preamble_line(line));
        if !starts_track {
            // Fold into the previous track's span (or skip if none yet).
            if let Some(last) = tracks.last_mut() {
                last.end = i + 1;
            }
            i += 1;
            continue;
        }

        index += 1;
        let (kind, mut id) = match anchor {
            Some((k, id)) => (k, id),
            None => (TrackKind::Bare, marker_id(line)),
        };
        // Span extends until the next anchor line (or EOF).
        let start = i;
        let mut end = i + 1;
        while end < lines.len() {
            let nt = lines[end].trim_start();
            if anchor_id(nt).is_some() {
                break;
            }
            // Stop a bare/implicit track at a blank line so a trailing bare
            // expression doesn't swallow later blank-separated anchors' gaps.
            end += 1;
        }
        // A `// @id` marker may sit on a later line of a multi-line track body
        // (e.g. `) // @drums`), so backfill from the whole span if the anchor
        // line alone didn't carry one.
        if id.is_none() {
            id = lines[start..end].iter().find_map(|l| marker_id(l));
        }
        tracks.push(Track {
            id,
            index,
            muted,
            kind,
            start,
            end,
        });
        i = end;
    }
    tracks
}

/// One-line preview of a track's source (first line, mute sentinel stripped,
/// clipped). For the `list_parts` display.
fn preview(lines: &[&str], t: &Track) -> String {
    let first = lines.get(t.start).copied().unwrap_or("");
    let s = first
        .trim()
        .strip_prefix(MUTE)
        .unwrap_or(first.trim())
        .trim();
    let clipped: String = s.chars().take(72).collect();
    if s.chars().count() > 72 {
        format!("{clipped}…")
    } else {
        clipped
    }
}

/// List the tracks in `code` (empty when the document has no track content yet).
pub fn list_tracks(code: &str) -> Vec<TrackInfo> {
    let lines: Vec<&str> = code.lines().collect();
    parse_tracks(code)
        .iter()
        .map(|t| TrackInfo {
            id: t.id.clone(),
            index: t.index,
            muted: t.muted,
            preview: preview(&lines, t),
        })
        .collect()
}

/// Resolve a caller-supplied handle (an `@id` or a 1-based index string) to a
/// track. Ids are compared through [`clean_id`] on BOTH sides so a handle and a
/// stored marker match regardless of separator style: `@bass_line`, `@bass-line`
/// and `@bass line` all resolve to the same track. (Ids are always *written* via
/// `clean_id`, so matching on the raw handle would miss any id containing `_`,
/// spaces, or punctuation — appending a duplicate track instead of replacing it.)
fn find<'a>(tracks: &'a [Track], handle: &str) -> Option<&'a Track> {
    let h = handle.trim().trim_start_matches('@');
    let key = clean_id(handle);
    if !key.is_empty() {
        if let Some(t) = tracks
            .iter()
            .find(|t| t.id.as_deref().map(clean_id).as_deref() == Some(key.as_str()))
        {
            return Some(t);
        }
    }
    if let Ok(n) = h.parse::<usize>() {
        return tracks.iter().find(|t| t.index == n);
    }
    None
}

/// Normalise a caller-supplied id to the `[a-z0-9_-]` marker charset.
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

/// Rebuild `code` with `tracks[idx]`'s span replaced by `replacement_lines`
/// (already newline-free strings, one per line). Preserves every other line.
fn splice(code: &str, span: (usize, usize), replacement: &[String]) -> String {
    let lines: Vec<&str> = code.lines().collect();
    let trailing_newline = code.ends_with('\n');
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    out.extend(lines[..span.0].iter().map(|s| s.to_string()));
    out.extend(replacement.iter().cloned());
    out.extend(lines[span.1..].iter().map(|s| s.to_string()));
    let mut joined = out.join("\n");
    if trailing_newline {
        joined.push('\n');
    }
    joined
}

/// Apply several track upserts sequentially (re-parse each time so later
/// patches see earlier inserts). Returns the final document and the ids written.
pub fn upsert_tracks(
    code: &str,
    patches: &[(String, String)],
) -> Result<(String, Vec<String>), String> {
    let mut doc = code.to_string();
    let mut wrote = Vec::with_capacity(patches.len());
    for (id, expr) in patches {
        let (next, w) = upsert_track(&doc, id, expr)?;
        doc = next;
        wrote.push(w);
    }
    Ok((doc, wrote))
}

/// Insert or replace a track. If a track matching `handle` (id or index) exists,
/// its span is replaced; otherwise a new `$: <expr> // @<id>` track is appended.
/// Returns the new document and the id that was written.
pub fn upsert_track(code: &str, handle: &str, expr: &str) -> Result<(String, String), String> {
    let expr = expr.trim();
    if expr.is_empty() {
        return Err("upsert_track: 'code' is empty".to_string());
    }
    let numeric = is_index_handle(handle);
    // A numeric handle names an index, never a new id.
    let id = if numeric {
        String::new()
    } else {
        clean_id(handle)
    };
    let tracks = parse_tracks(code);

    if let Some(t) = find(&tracks, handle) {
        // Replace in place, preserving the track's written form. Keep the
        // track's own id; only fall back to the handle when it names an id
        // (not a bare index) and the track had none.
        let write_id = t.id.clone().unwrap_or_else(|| id.clone());
        let line = match t.kind {
            TrackKind::Bare => {
                // Keep bare form; keep it addressable with a trailing marker.
                if write_id.is_empty() {
                    expr.to_string()
                } else {
                    format!("{expr} // @{write_id}")
                }
            }
            _ => {
                if write_id.is_empty() {
                    format!("$: {expr}")
                } else {
                    format!("$: {expr} // @{write_id}")
                }
            }
        };
        let new_code = splice(code, (t.start, t.end), &[line]);
        return Ok((new_code, write_id));
    }

    // No match → append a new $: track.
    if numeric {
        // A bare index that matched nothing is out of range, not a request to
        // create a track literally named after the number.
        return Err(no_match(&tracks, handle));
    }
    if id.is_empty() {
        return Err(format!(
            "upsert_track: no track matches '{handle}', and a new track needs a \
             non-empty id (letters/digits) to be addressable later."
        ));
    }
    let sep = if code.is_empty() || code.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let new_code = format!("{code}{sep}$: {expr} // @{id}\n");
    Ok((new_code, id))
}

/// Comment out a track (silence it) by prefixing its lines with `//@mute `.
pub fn mute_track(code: &str, handle: &str) -> Result<String, String> {
    toggle_mute(code, handle, true)
}

/// Restore a muted track.
pub fn unmute_track(code: &str, handle: &str) -> Result<String, String> {
    toggle_mute(code, handle, false)
}

fn toggle_mute(code: &str, handle: &str, mute: bool) -> Result<String, String> {
    let tracks = parse_tracks(code);
    let t = find(&tracks, handle)
        .ok_or_else(|| no_match(&tracks, handle))?
        .clone();
    let lines: Vec<&str> = code.lines().collect();
    let replacement: Vec<String> = lines[t.start..t.end]
        .iter()
        .map(|line| {
            let trimmed = line.trim_start();
            if mute {
                if trimmed.starts_with(MUTE) {
                    line.to_string() // already muted
                } else {
                    format!("{MUTE}{line}")
                }
            } else if let Some(idx) = line.find(MUTE) {
                // Strip the sentinel wherever it sits (leading whitespace kept).
                format!("{}{}", &line[..idx], &line[idx + MUTE.len()..])
            } else {
                line.to_string()
            }
        })
        .collect();
    Ok(splice(code, (t.start, t.end), &replacement))
}

/// Delete a track entirely. Not yet exposed as an agent tool (mute is the
/// reversible default); kept for the UI mixer strip and future wiring.
#[allow(dead_code)]
pub fn remove_track(code: &str, handle: &str) -> Result<String, String> {
    let tracks = parse_tracks(code);
    let t = find(&tracks, handle)
        .ok_or_else(|| no_match(&tracks, handle))?
        .clone();
    Ok(splice(code, (t.start, t.end), &[]))
}

/// A helpful "no such track" error listing the handles that DO exist.
fn no_match(tracks: &[Track], handle: &str) -> String {
    let avail: Vec<String> = tracks
        .iter()
        .map(|t| match &t.id {
            Some(id) => format!("@{id}"),
            None => format!("#{}", t.index),
        })
        .collect();
    format!(
        "no track matches '{handle}'. Tracks: {}. Address by @id or 1-based index.",
        if avail.is_empty() {
            "(none)".to_string()
        } else {
            avail.join(", ")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MULTI: &str = "setbpm(120);\n$: s(\"bd*4\") // @drums\n$: s(\"hh*8\") // @hats\n";

    #[test]
    fn lists_marked_tracks() {
        let t = list_tracks(MULTI);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].id.as_deref(), Some("drums"));
        assert_eq!(t[1].id.as_deref(), Some("hats"));
        assert_eq!(t[0].index, 1);
        assert!(!t[0].muted);
        assert!(t[0].preview.contains("bd*4"));
    }

    #[test]
    fn recognises_labeled_tracks() {
        let code = "setbpm(120);\ndrums: s(\"bd*4\")\nbass: note(\"c2\").s(\"sawtooth\")\n";
        let t = list_tracks(code);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].id.as_deref(), Some("drums"));
        assert_eq!(t[1].id.as_deref(), Some("bass"));
    }

    #[test]
    fn upsert_replaces_only_target_line() {
        let (out, id) = upsert_track(MULTI, "drums", "s(\"bd*2\")").unwrap();
        assert_eq!(id, "drums");
        // hats line is byte-identical.
        assert!(out.contains("$: s(\"hh*8\") // @hats"));
        assert!(out.contains("$: s(\"bd*2\") // @drums"));
        assert!(!out.contains("bd*4"));
        // preamble preserved.
        assert!(out.starts_with("setbpm(120);\n"));
    }

    #[test]
    fn upsert_by_index() {
        let (out, id) = upsert_track(MULTI, "2", "s(\"oh*4\")").unwrap();
        assert_eq!(id, "hats");
        assert!(out.contains("$: s(\"oh*4\") // @hats"));
        assert!(out.contains("@drums"));
    }

    #[test]
    fn upsert_appends_new_track() {
        let (out, id) = upsert_track(MULTI, "bass", "note(\"c2\").s(\"sawtooth\")").unwrap();
        assert_eq!(id, "bass");
        assert!(out.contains("$: s(\"bd*4\") // @drums"));
        assert!(out.contains("$: note(\"c2\").s(\"sawtooth\") // @bass"));
        // appended after existing tracks.
        let di = out.find("@drums").unwrap();
        let bi = out.find("@bass").unwrap();
        assert!(bi > di);
    }

    #[test]
    fn upsert_new_requires_id() {
        assert!(upsert_track(MULTI, "99", "s(\"cp\")").is_err());
    }

    #[test]
    fn upsert_underscore_handle_replaces_not_duplicates() {
        // Handle with a `_` is written as `@bass-line` (clean_id maps `_`→`-`);
        // re-upserting the same handle must REPLACE that track, not append a
        // second one. Regression: `find` used to match the raw handle and miss.
        let (once, id) = upsert_track(MULTI, "bass_line", "note(\"c2\")").unwrap();
        assert_eq!(id, "bass-line");
        let (twice, id2) = upsert_track(&once, "bass_line", "note(\"e2\")").unwrap();
        assert_eq!(id2, "bass-line");
        assert_eq!(
            twice.matches("@bass-line").count(),
            1,
            "should be one track:\n{twice}"
        );
        assert!(twice.contains("note(\"e2\")") && !twice.contains("note(\"c2\")"));
        // The hyphen spelling of the same handle also resolves to it.
        let (thrice, _) = upsert_track(&twice, "bass-line", "note(\"g2\")").unwrap();
        assert_eq!(
            thrice.matches("@bass-line").count(),
            1,
            "hyphen alias must match:\n{thrice}"
        );
    }

    #[test]
    fn mute_and_unmute_roundtrip() {
        let muted = mute_track(MULTI, "drums").unwrap();
        let t = list_tracks(&muted);
        assert!(t[0].muted, "drums should read as muted");
        assert!(t[0].id.as_deref() == Some("drums"), "id survives mute");
        assert!(!t[1].muted, "hats untouched");
        assert!(muted.contains("//@mute $: s(\"bd*4\") // @drums"));

        let restored = unmute_track(&muted, "drums").unwrap();
        assert_eq!(restored, MULTI);
    }

    #[test]
    fn remove_drops_span() {
        let out = remove_track(MULTI, "drums").unwrap();
        assert!(!out.contains("bd*4"));
        assert!(out.contains("@hats"));
        assert_eq!(list_tracks(&out).len(), 1);
    }

    #[test]
    fn bare_expression_is_one_implicit_track() {
        let code = "setbpm(120);\nstack(s(\"bd*4\"), s(\"hh*8\"))\n";
        let t = list_tracks(code);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, None);
        assert_eq!(t[0].index, 1);
    }

    #[test]
    fn upsert_new_onto_bare_doc_appends_dollar_track() {
        let code = "setbpm(120);\nstack(s(\"bd*4\"))\n";
        let (out, _) = upsert_track(code, "hats", "s(\"hh*8\")").unwrap();
        // bare expression preserved, new $: track appended (mixed form is valid).
        assert!(out.contains("stack(s(\"bd*4\"))"));
        assert!(out.contains("$: s(\"hh*8\") // @hats"));
    }

    #[test]
    fn replace_bare_track_keeps_bare_form() {
        let code = "setbpm(120);\nstack(s(\"bd*4\"))\n";
        let (out, id) = upsert_track(code, "1", "stack(s(\"bd*2\"))").unwrap();
        assert!(out.contains("stack(s(\"bd*2\"))"));
        // no id was present; index-addressed bare replacement stays bare.
        assert!(id.is_empty());
        assert!(!out.contains("$:"));
    }

    #[test]
    fn multiline_dollar_track_span_is_captured() {
        let code = "setbpm(120);\n$: stack(\n  s(\"bd*4\"),\n  s(\"hh*8\")\n) // @drums\n$: s(\"cp\") // @clap\n";
        let t = list_tracks(code);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].id.as_deref(), Some("drums"));
        // Replacing @clap must not disturb the multi-line drums block.
        let (out, _) = upsert_track(code, "clap", "s(\"rs\")").unwrap();
        assert!(out.contains("  s(\"bd*4\"),\n  s(\"hh*8\")\n) // @drums"));
        assert!(out.contains("$: s(\"rs\") // @clap"));
    }

    #[test]
    fn missing_track_error_lists_available() {
        let e = mute_track(MULTI, "lead").unwrap_err();
        assert!(e.contains("@drums"));
        assert!(e.contains("@hats"));
    }
}
