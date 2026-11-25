use super::tools_doc::current_document;
use super::{ToolErr, ToolResult, findings, opt_usize};
use crate::state::AppState;
use cycletron_analysis as strudel;
use cycletron_core::types::{ToolCategory, ToolOutcome};

/// Hash used as a review-cache key (stable for identical source).
pub(crate) fn code_hash(code: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    code.hash(&mut h);
    h.finish()
}

/// Resolve optional `code` for review/validate: explicit arg → current editor.
pub(super) fn resolve_code_or_editor(
    input: &serde_json::Value,
    state: &AppState,
) -> Result<String, ToolErr> {
    if let Some(c) = input["code"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(c.to_string());
    }
    current_document(state).map_err(|_| {
        ToolErr::precondition(
            "No code provided and nothing is in the editor. Pass `code`, or play a pattern first.",
        )
    })
}

/// Telemetry write-kind when the tool didn't stamp one: full play vs track edit.
pub(super) fn infer_write_kind(name: &str, input: &serde_json::Value) -> Option<String> {
    match name {
        "play_pattern" => {
            if input
                .get("code")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
            {
                Some("full".into())
            } else {
                Some("reuse".into())
            }
        }
        "upsert_track" | "upsert_tracks" => Some("track".into()),
        "upsert_section" | "upsert_sections" => Some("section".into()),
        "upsert_binding" => Some("binding".into()),
        "review_pattern" => Some("review".into()),
        "hear_pattern" => Some("hear".into()),
        "validate_pattern" => Some("validate".into()),
        _ => None,
    }
}

pub(super) fn tool_validate_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;

    if code.trim().is_empty() {
        return Ok(ToolOutcome::ok("valid (empty)", "valid — safe to play"));
    }
    match strudel::Evaluated::new(&code, 4) {
        Ok(ev) => {
            // Syntax is fine — now hunt the silent-failure class: events that
            // evaluate but will never sound (unknown sounds, unvoiced chords,
            // NaN pan). Lint over a short window; failures here never block.
            let mut lint = strudel::lint_source(&code);
            lint.extend(strudel::lint_digest(
                ev.digest(),
                &crate::sounds::known_sound_set(state),
            ));
            if lint.is_empty() {
                Ok(ToolOutcome::ok("valid", "valid — safe to play"))
            } else {
                let mut out = String::from("valid syntax, BUT with audibility issues:\n");
                for f in &lint {
                    out.push_str(&format!("  [{}] {}: {}\n", f.severity, f.code, f.message));
                }
                out.push_str("\nFix the warns (they mean silent layers) before playing.");
                let warns = lint.iter().filter(|f| f.severity == "warn").count();
                Ok(
                    ToolOutcome::ok(format!("valid, {warns} audibility warning(s)"), out)
                        .with_warnings(findings(&lint)),
                )
            }
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "INVALID: {e}{}\n\nFix the error and validate again before playing.",
                error_context(&code, &e.to_string())
            ),
        )),
    }
}

/// If an engine error carries a byte span ("… at 16..20"), render the
/// offending line with a caret under it so nobody counts characters by hand.
pub(super) fn error_context(code: &str, err: &str) -> String {
    let Some(pos) = err
        .rsplit_once(" at ")
        .and_then(|(_, span)| span.split("..").next())
        .and_then(|s| {
            s.trim()
                .trim_end_matches(|c: char| !c.is_ascii_digit())
                .parse::<usize>()
                .ok()
        })
    else {
        return String::new();
    };
    let pos = code.floor_char_boundary(pos.min(code.len()));
    let line_start = code[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = code[pos..]
        .find('\n')
        .map(|i| pos + i)
        .unwrap_or(code.len());
    let line_no = code[..line_start].matches('\n').count() + 1;
    let col = code[line_start..pos].chars().count();
    let line = &code[line_start..line_end];
    let caret = format!(
        "\n  line {line_no}: {line}\n  {}^ here",
        " ".repeat(col + "line : ".len() + line_no.to_string().len())
    );
    // Common typo: a method chained on a string literal INSIDE a call, e.g.
    // `s("bd*4".fast(2))` — the quote closed too early; it should be
    // `s("bd*4").fast(2)` (chain on the pattern, not the string in the call).
    let hint = if quote_then_method(line) {
        "\n  hint: a method looks chained on a string INSIDE a call — did the quote close too \
         early? `s(\"bd*4\".fast(2))` should be `s(\"bd*4\").fast(2)`."
    } else {
        ""
    };
    format!("{caret}{hint}")
}

/// True when a line contains a closing `"` immediately followed by `.method` —
/// the tell-tale of `s("bd*4".fast(2))` (method chained on the string literal).
fn quote_then_method(line: &str) -> bool {
    let b = line.as_bytes();
    b.windows(2).enumerate().any(|(i, w)| {
        w[0] == b'"' && w[1] == b'.' && b.get(i + 2).is_some_and(u8::is_ascii_alphabetic)
    })
}

/// The combined quality gate: validate + silence lint + mix critique + (for
/// multi-section songs) form critique, in ONE call — cuts the
/// validate→critique→critique_form round-trip tax for full songs.
///
/// `code` is optional: omit to review the document currently in the editor
/// (avoids re-emitting a full song just to gate it). Identical code is served
/// from a per-run cache; a hard budget of
/// [`crate::state::MAX_REVIEWS_PER_RUN`] real reviews per user message stops
/// thrash loops.
pub(super) fn tool_review_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;
    let cycles = input["cycles"].as_u64().unwrap_or(8).min(64) as usize;
    let hash = code_hash(&code);

    // Cache hit / budget check. Do not call stamp_write_kind while holding the
    // agent_write lock — it re-locks the same mutex (non-reentrant → deadlock).
    let cache_or_budget: Option<(ToolOutcome, &str)> = {
        let w = state.agent_write.lock();
        if let Some(cached) = w.last_review.as_ref().filter(|r| r.hash == hash) {
            let mut o = cached.result.clone();
            o.summary = format!("cached review: {}", o.summary);
            o.text.push_str(if cached.result.ok {
                "\n\n(cached — identical code to previous review; \
                 call play_pattern with no code to play it, or edit then re-review.)"
            } else {
                "\n\n(cached — identical code to previous review, which failed; \
                 fix it, then re-review.)"
            });
            Some((o, "review_cache"))
        } else if w.review_calls >= crate::state::MAX_REVIEWS_PER_RUN {
            Some((
                ToolOutcome::failed(
                    ToolCategory::BudgetExhausted,
                    format!(
                        "Review budget used ({}/{} this request). Fix from the prior review's \
                         warns, then call play_pattern (omit code to play the last reviewed \
                         buffer) or upsert_track for a surgical edit. Do not re-review.",
                        crate::state::MAX_REVIEWS_PER_RUN,
                        crate::state::MAX_REVIEWS_PER_RUN,
                    ),
                ),
                "review_budget",
            ))
        } else {
            None
        }
    };
    if let Some((early, kind)) = cache_or_budget {
        state.stamp_write_kind(kind);
        return Ok(early);
    }

    let result = review_code(&code, cycles, state);
    state.stamp_write_kind("review");

    // Count every non-cached attempt against the budget, and remember the
    // review so play_pattern can reuse a passing buffer without a second
    // full-document generation from the model.
    {
        let mut w = state.agent_write.lock();
        w.review_calls += 1;
        w.last_review = Some(crate::state::LastReview::new(code, result.clone()));
    }
    Ok(result)
}

/// Core review pipeline — pure-ish (needs state only for the sound catalog).
/// Shared by `review_pattern` and the built-in play gate. The envelope's
/// `warnings` are every finding the report printed, so callers never re-parse
/// the report text.
pub(crate) fn review_code(code: &str, cycles: usize, state: &AppState) -> ToolOutcome {
    match strudel::review_report(code, cycles, &crate::sounds::known_sound_set(state)) {
        strudel::ReviewOutcome::Invalid(e) => ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "INVALID: {e}{}\n\nFix the error and review again.",
                error_context(code, &e)
            ),
        ),
        strudel::ReviewOutcome::Report {
            mut text,
            findings: found,
        } => {
            let warns = found.iter().filter(|f| f.severity == "warn").count();
            let summary = if warns == 0 {
                "review: ready to play".to_string()
            } else {
                format!("review: {warns} warning(s)")
            };
            text.push_str(&if warns == 0 {
                "\nVERDICT: ready to play. Call play_pattern with no code to play this buffer."
                    .to_string()
            } else {
                format!(
                    "\nVERDICT: {warns} warning(s) — fix the warns, then play \
                     (play_pattern with no code reuses this buffer after a clean re-review)."
                )
            });
            let notes = found.iter().filter(|f| f.severity == "note").count();
            if notes > 0 && state.agent_policy.lock().advisory_notes {
                text.push_str(&format!(
                    "\n{notes} [note] line(s) above are observations, not defects — mention them to \
                     the user if relevant; do not rewrite for them unless they asked about the mix \
                     (hear_pattern measures it)."
                ));
            }
            ToolOutcome::ok(summary, text).with_warnings(findings(&found))
        }
    }
}

/// Render the pattern offline and measure it — the agent's ears. The render
/// is CPU-bound (mix + every stem), so it runs on a blocking thread; the
/// envelope carries the full report as `data` and its findings as warnings.
pub(super) async fn tool_hear_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    // Explicit code → last reviewed buffer → current editor, like play_pattern.
    let code = if let Some(c) = input["code"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        c.to_string()
    } else if let Some(c) = state.last_reviewed_code() {
        c
    } else {
        current_document(state).map_err(|_| {
            ToolErr::precondition(
                "Nothing to hear: pass `code`, review a pattern first, or play one so it is in \
                 the editor.",
            )
        })?
    };

    let Some(samples) = state.sample_paths.lock().clone() else {
        return Err(ToolErr::precondition(
            "No sample set is resolved for offline rendering yet — the active set is not \
             downloaded. The user can pick or download one in the Samples manager.",
        ));
    };

    {
        let mut w = state.agent_write.lock();
        if w.hear_calls >= crate::state::MAX_HEARS_PER_RUN {
            return Ok(ToolOutcome::failed(
                ToolCategory::BudgetExhausted,
                format!(
                    "Hear budget used ({}/{} this request). Act on the last measurement — fix \
                     the mix surgically and play it; do not render again.",
                    crate::state::MAX_HEARS_PER_RUN,
                    crate::state::MAX_HEARS_PER_RUN,
                ),
            ));
        }
        w.hear_calls += 1;
    }

    // Fail as the review would on code that does not evaluate, before paying
    // for a render.
    if let Err(e) = strudel::Evaluated::new(&code, 1) {
        return Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "INVALID: {e}{}\n\nFix the error (review_pattern) before hearing it.",
                error_context(&code, &e)
            ),
        ));
    }

    let opts = cycletron_render::HearOptions {
        cycles: input["cycles"].as_u64().map(|n| n as usize),
        stems: input["stems"].as_bool().unwrap_or(true),
        bpm: Some(state.session.lock().tempo),
        ..cycletron_render::HearOptions::default()
    };
    let report = tokio::task::spawn_blocking(move || cycletron_render::hear(&code, &samples, opts))
        .await
        .map_err(|e| ToolErr::io(format!("render task failed: {e}")))?
        .map_err(ToolErr::io)?;

    let summary = format!(
        "mix: {} · {} cycle(s), {:.1} s{} · {} ms",
        report.verdict,
        report.cycles,
        report.seconds,
        if report.stems.is_empty() {
            String::new()
        } else {
            format!(", {} stems", report.stems.len())
        },
        report.render_ms,
    );
    let warnings = findings(&report.findings);
    let data = serde_json::to_value(&report).map_err(ToolErr::io)?;
    Ok(
        ToolOutcome::ok(summary, cycletron_render::report_to_text(&report))
            .with_warnings(warnings)
            .with_data(data),
    )
}

pub(super) fn tool_inspect_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;
    let cycles = opt_usize(input, "cycles", 8);
    // "auto": full event log for short windows, summary for long forms (a
    // 64-cycle dump is thousands of lines nobody can scan).
    let verbosity = input["verbosity"].as_str().unwrap_or("auto");
    let want_events = match verbosity {
        "events" => true,
        "summary" => false,
        _ => cycles <= 4,
    };

    match strudel::Evaluated::new(&code, cycles) {
        Ok(ev) if !want_events => Ok(ToolOutcome::ok(
            format!("digest summary, {cycles} cycles"),
            strudel::digest_to_summary(ev.digest()),
        )),
        Ok(ev) => Ok(ToolOutcome::ok(
            format!("event log, {cycles} cycles"),
            strudel::digest_to_text(ev.digest()),
        )),
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not inspect — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and inspect again."
            ),
        )),
    }
}

pub(super) fn tool_analyze_arrangement(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;
    let max_cycles = opt_usize(input, "max_cycles", 32);

    match strudel::Evaluated::new(&code, max_cycles) {
        Ok(ev) => {
            let a = strudel::analyze(&ev);
            Ok(ToolOutcome::ok(
                format!("{} section(s)", a.sections.len()),
                strudel::analyze_to_text(&a),
            ))
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not analyze — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and analyze again."
            ),
        )),
    }
}

pub(super) fn tool_critique_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;
    let cycles = opt_usize(input, "cycles", 16);

    match strudel::Evaluated::new(&code, cycles.max(4)) {
        Ok(ev) => {
            let c = strudel::critique(&ev);
            Ok(critique_outcome(
                "mix critique",
                &c.findings,
                strudel::critique_to_text(&c),
            ))
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not critique — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and critique again."
            ),
        )),
    }
}

/// A critique as an envelope: its findings become `warnings`, the summary
/// counts the warns.
fn critique_outcome(what: &str, found: &[strudel::Finding], text: String) -> ToolOutcome {
    let warns = found.iter().filter(|f| f.severity == "warn").count();
    let summary = if warns == 0 {
        format!("{what}: clean")
    } else {
        format!("{what}: {warns} warning(s)")
    };
    ToolOutcome::ok(summary, text).with_warnings(findings(found))
}

pub(super) fn tool_critique_form(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;
    let cycles = opt_usize(input, "cycles", 32);

    match strudel::Evaluated::new(&code, cycles.clamp(8, 64)) {
        Ok(ev) => {
            let c = strudel::critique_form(&ev);
            Ok(critique_outcome(
                "form critique",
                &c.findings,
                strudel::form_critique_to_text(&c),
            ))
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not critique the form — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and try again."
            ),
        )),
    }
}
