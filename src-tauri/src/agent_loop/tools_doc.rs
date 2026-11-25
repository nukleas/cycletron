use super::tools_analysis::error_context;
use super::{
    ToolErr, ToolResult, apply_rewrite, findings, req_str, review_code, rewrite_budget_block,
};
use crate::state::AppState;
use cycletron_agent::types::*;
use cycletron_analysis as strudel;
use cycletron_core::types::{PlaybackState, ToolCategory, ToolFinding, ToolOutcome};
use tokio::sync::mpsc;

/// Repair-and-revalidate gate before playback. Playback injects code straight
/// into the editor, and the agent is only *expected* to validate first — nothing
/// forced it, so raw model output could reach the WASM REPL and play (or, worse,
/// silently fail to). This gate closes that loop in three steps:
///
///   1. deterministically repair the mechanical mistakes with one correct fix
///      (fences, negative literal pan — see `sanitize_source`);
///   2. re-validate the result through the *real* evaluator and fail closed —
///      un-evaluable code is never injected, it goes back to the agent to fix;
///   3. run the advisory silence lint — syntactically valid but audibly-dead
///      layers are surfaced (not blocked; the audible layers still play).
///
/// The repaired code — not the raw input — is what reaches the editor and the
/// session, so `current_pattern` always reflects what actually plays.
pub(super) fn tool_play_pattern(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    // Prefer explicit code → last reviewed buffer → current editor.
    // Omitting code after a successful review is the fast path: the model does
    // not re-stream a full multi-KB song just to commit what it already gated.
    let (raw, reused) = if let Some(c) = input["code"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        (c.to_string(), false)
    } else if let Some(c) = state.last_reviewed_code() {
        state.stamp_write_kind("reuse");
        (c, true)
    } else if let Ok(c) = current_document(state) {
        state.stamp_write_kind("reuse");
        (c, true)
    } else {
        return Err(ToolErr::precondition(
            "play_pattern needs `code`, or a prior successful review_pattern, or a song \
             already in the editor.",
        ));
    };

    // Latency guard (telemetry: list_sections → full 34k play ×2 ≈ 9 min).
    // After the agent listed structure, a full-document rewrite is almost
    // always wrong — use upsert_section / upsert_track. Escape: force: true.
    let force = input
        .get("force")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !reused
        && !force
        && state.listed_structure()
        && raw.len() >= crate::state::FULL_REWRITE_GUARD_CHARS
        && current_document(state)
            .map(|d| d.len() > 200)
            .unwrap_or(false)
    {
        state.stamp_write_kind("full_blocked");
        let secs =
            cycletron_doc::sections::list_sections(&current_document(state).unwrap_or_default());
        let hint = if secs.is_empty() {
            "upsert_track / upsert_tracks (or list_parts first)".to_string()
        } else {
            format!(
                "upsert_section / upsert_sections on: {}",
                secs.iter()
                    .take(12)
                    .map(|s| s.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        return Ok(ToolOutcome::failed(
            ToolCategory::PolicyBlocked,
            format!(
                "NOT PLAYED — full rewrite blocked after list_sections/list_parts in this \
                 request ({code_chars} chars). Streaming the whole song again is the #1 \
                 latency footgun.\n\
                 Edit surgically with {hint}.\n\
                 Only if you truly must replace the entire arrangement, call play_pattern \
                 again with the same code AND force: true.",
                code_chars = raw.len(),
                hint = hint,
            ),
        ));
    }

    // Optional built-in gate: one generation + server-side review, no second tool.
    // Default true for multi-section / large docs; false when the model opts out
    // with review:false (already gated this request).
    let want_review = match input.get("review") {
        Some(v) if v.is_boolean() => v.as_bool().unwrap_or(false),
        _ => {
            raw.contains("pickRestart")
                || raw.contains("arrange")
                || raw.len() > 2_000
                || raw.lines().count() > 40
        }
    };

    let mut gate_note = String::new();
    let mut gate_warnings: Vec<ToolFinding> = Vec::new();
    if want_review {
        let cycles = input["cycles"].as_u64().unwrap_or(8).min(64) as usize;
        let report = review_code(&raw, cycles, state);
        if !report.ok {
            let mut msg = format!(
                "NOT PLAYED — built-in review failed, so nothing changed.\n{}",
                report.text
            );
            if report.text.contains("Arrow functions") || raw.contains("=>") {
                msg.push_str(
                    "\n\nHint: free-standing `const f = x => …` helpers are not valid \
                     top-level strudel. Inline the chain (`.s(\"supersaw\").gain(…)`) \
                     on each note/stack, or use only method callbacks like \
                     `.every(2, x => x.fast(2))`. Do NOT re-emit a second full song — \
                     fix the arrow footgun in a surgical edit if possible.",
                );
            }
            return Ok(ToolOutcome::failed(ToolCategory::NotApplied, msg));
        }
        // Stash as last-reviewed so a later play_pattern() reuses it.
        state.agent_write.lock().last_review =
            Some(crate::state::LastReview::new(raw.clone(), report.clone()));
        // Compact the gate for the tool result (full report can be huge): the
        // digest line, a verdict, and the first few warns — from the envelope,
        // not re-parsed out of the report text.
        let digest = report
            .text
            .lines()
            .find(|l| l.trim_start().starts_with("bpm "))
            .unwrap_or("")
            .trim();
        let warns: Vec<&ToolFinding> = report
            .warnings
            .iter()
            .filter(|w| w.severity == "warn")
            .collect();
        gate_note = format!("\n[built-in review] {digest}\n");
        if warns.is_empty() {
            gate_note.push_str("VERDICT: ready to play.");
        } else {
            gate_note.push_str(&format!(
                "VERDICT: {} warning(s) — fix the warns, then play.\nWarnings:",
                warns.len()
            ));
            for w in warns.iter().take(6) {
                gate_note.push_str(&format!("\n  [{}] {}: {}", w.severity, w.code, w.message));
            }
        }
        gate_warnings = report.warnings;
    }

    let lead = if reused {
        "Pattern sent to editor for playback (reused last reviewed / current buffer — no code re-emitted)."
    } else {
        state.stamp_write_kind("full");
        "Pattern sent to editor for playback."
    };
    let mut out = apply_document(state, event_tx, &raw, lead)?;
    if out.ok {
        out.text.push_str(&gate_note);
        // The gate's critique findings join the commit's silence lint;
        // silence-lint findings the review also ran are deduplicated.
        for w in gate_warnings {
            if !out.warnings.contains(&w) {
                out.warnings.push(w);
            }
        }
        let warns = out.warnings.iter().filter(|w| w.severity == "warn").count();
        if warns > 0 {
            out.summary = format!("playing, {warns} warning(s)");
        }
    }
    Ok(out)
}

/// The shared commit path for anything that changes the playing document:
/// deterministic repair → re-validate (fail closed) → silence lint (advisory) →
/// store in session → emit `__set_code_and_play` (a phase-preserving hot-swap on
/// the frontend). `lead` is the first sentence of the summary returned to the
/// agent. On a validation failure NOTHING is committed or emitted — the caller's
/// edit is a no-op and the agent is told why.
pub(super) fn apply_document(
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    raw: &str,
    lead: &str,
) -> ToolResult {
    // The resolvable sound set drives both the alias remap and the silence lint.
    let known = crate::sounds::known_sound_set(state);

    // 1. Deterministic repair: mechanical fixes + catalog-backed sound aliases.
    let strudel::Sanitized { code, notes } = strudel::sanitize_source_with_catalog(raw, &known);
    let repair_summary = if notes.is_empty() {
        String::new()
    } else {
        let mut s = String::from("\nAuto-repaired:");
        for n in &notes {
            s.push_str(&format!("\n  • {n}"));
        }
        s
    };

    // 2. Re-validate through the REAL evaluator. Fail closed: never inject code
    //    the engine can't parse — that is silence with no feedback loop.
    let evaluated = match strudel::Evaluated::new(&code, 4) {
        Ok(ev) => ev,
        Err(e) => {
            return Ok(ToolOutcome::failed(
                ToolCategory::NotApplied,
                format!(
                    "NOT APPLIED — the resulting pattern does not evaluate, so nothing changed.\n\
                     INVALID: {e}{}{repair_summary}\n\nFix the error and try again.",
                    error_context(&code, &e),
                ),
            )
            .with_repairs(notes));
        }
    };

    // 3. Silence lint (advisory): valid syntax, but audibly-dead layers —
    //    invented sounds, unvoiced chords, out-of-range pan. Surface, don't block.
    let mut lint = strudel::lint_source(&code);
    lint.extend(strudel::lint_digest(evaluated.digest(), &known));
    let warns: Vec<_> = lint.iter().filter(|f| f.severity == "warn").collect();

    // 4. Commit the repaired code: store it and inject into the WASM REPL.
    {
        let mut session = state.session.lock();
        session.set_pattern(code.clone());
        session.playback = PlaybackState::Playing;
    }
    // The document just changed, so a buffer reviewed earlier in this
    // request is stale: a later `play_pattern()` must fall through to the
    // editor, not replay the pre-edit review (the eval caught a whole
    // request's edits silently reverted this way).
    {
        let mut w = state.agent_write.lock();
        if w.last_review.as_ref().map(|r| r.code.as_str()) != Some(code.as_str()) {
            w.last_review = None;
        }
    }
    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__set_code_and_play".to_string(),
        payload: code.clone(),
    });

    // 5. Report back what was repaired and any silent-layer warnings.
    let mut msg = String::from(lead);
    msg.push_str(&repair_summary);
    if !warns.is_empty() {
        msg.push_str("\nPlaying, but these layers may be SILENT — fix, then play again:");
        for f in &warns {
            msg.push_str(&format!("\n  [{}] {}: {}", f.severity, f.code, f.message));
        }
    }
    let mut summary = lead
        .split_once(" (")
        .map_or(lead, |(head, _)| head)
        .trim_end_matches('.')
        .to_string();
    if !warns.is_empty() {
        summary.push_str(&format!(", {} silent-layer warning(s)", warns.len()));
    }
    if !notes.is_empty() {
        summary.push_str(&format!(", {} repair(s)", notes.len()));
    }
    Ok(ToolOutcome::ok(summary, msg)
        .with_warnings(findings(&lint))
        .with_repairs(notes))
}

/// The document currently in the editor/session, or a friendly error when there
/// is nothing to edit yet.
pub(super) fn current_document(state: &AppState) -> Result<String, ToolErr> {
    state.session.lock().current_pattern.clone().ok_or_else(|| {
        ToolErr::precondition(
            "There's no song in the editor yet. Use play_pattern to start one, then edit its \
             tracks with upsert_track / mute_track.",
        )
    })
}

/// List the addressable tracks of the current song (read-only; no playback).
pub(super) fn tool_list_parts(state: &AppState) -> ToolResult {
    state.mark_listed_structure();
    let code = current_document(state)?;
    let parts = cycletron_doc::tracks::list_tracks(&code);
    if parts.is_empty() {
        return Ok(ToolOutcome::ok(
            "no tracks",
            "The current document has no tracks yet.",
        ));
    }
    let mut out = format!("{} track(s) in the current song:\n", parts.len());
    for p in &parts {
        let handle = match &p.id {
            Some(id) => format!("@{id}"),
            None => format!("#{} (no id — address by index)", p.index),
        };
        let muted = if p.muted { " [MUTED]" } else { "" };
        out.push_str(&format!(
            "  {}. {}{}  —  {}\n",
            p.index, handle, muted, p.preview
        ));
    }
    out.push_str(
        "\nEdit one with upsert_track {id, code}; batch with upsert_tracks; \
         silence with mute_track {id}. For pickRestart songs use list_sections / upsert_section.",
    );
    if parts.iter().any(|p| p.id.is_none()) {
        out.push_str(
            "\nUnnamed tracks: address by 1-based index (id: \"1\"). A brand-new name \
             APPENDS a copy — on MIDI dumps that doubles the song. To restyle a long \
             note body, pass code starting with '.' (e.g. .s(\"supersaw\").lpf(800)); \
             the mini-notation is kept. upsert_tracks with one new name per unnamed \
             track replaces them in order and stamps the ids.",
        );
    }
    Ok(ToolOutcome::ok(format!("{} track(s)", parts.len()), out))
}

/// List named sections of a pickRestart/arrange song (read-only).
pub(super) fn tool_list_sections(state: &AppState) -> ToolResult {
    state.mark_listed_structure();
    let code = current_document(state)?;
    let secs = cycletron_doc::sections::list_sections(&code);
    if secs.is_empty() {
        return Ok(ToolOutcome::ok(
            "no sections",
            "No section object found (const sections = {…} or pickRestart/arrange). \
             For `$:` tracks use list_parts / upsert_track.",
        ));
    }
    let mut out = format!("{} section(s) in the current arrangement:\n", secs.len());
    for s in &secs {
        out.push_str(&format!(
            "  {}. @{}  (lines {}–{})  —  {}\n",
            s.index,
            s.id,
            s.start_line + 1,
            s.end_line,
            s.preview
        ));
    }
    out.push_str(
        "\nEdit surgically with upsert_section {id, code} or upsert_sections — \
         do NOT play_pattern the whole song after listing. `code` is only that \
         section's expression (no `drop1:`, no full document). Full rewrite after \
         this call is blocked unless force: true.",
    );
    Ok(ToolOutcome::ok(format!("{} section(s)", secs.len()), out))
}

/// Add or replace one track, then hot-swap. Only the target track's text changes.
pub(super) fn tool_upsert_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let expr = req_str(input, "code")?;
    let code = current_document(state)?;
    if let Some(blocked) = rewrite_budget_block(state, &[id]) {
        return Ok(blocked);
    }
    let (new_code, wrote) = cycletron_doc::tracks::upsert_track(&code, id, expr)?;
    state.stamp_write_kind("track");
    apply_rewrite(
        state,
        event_tx,
        &[wrote.as_str()],
        &new_code,
        &format!("Track @{wrote} updated (other tracks unchanged)."),
    )
}

/// Batch track upserts in one apply (one LLM round-trip for multi-part rebuilds).
pub(super) fn tool_upsert_tracks(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let patches = parse_id_code_patches(input)?;
    let ids: Vec<&str> = patches.iter().map(|(id, _)| id.as_str()).collect();
    if let Some(blocked) = rewrite_budget_block(state, &ids) {
        return Ok(blocked);
    }
    let code = current_document(state).unwrap_or_default();
    let (new_code, wrote) = cycletron_doc::tracks::upsert_tracks(&code, &patches)?;
    state.stamp_write_kind("track");
    let wrote_ids: Vec<&str> = wrote.iter().map(String::as_str).collect();
    apply_rewrite(
        state,
        event_tx,
        &wrote_ids,
        &new_code,
        &format!(
            "{} track(s) updated: {}.",
            wrote.len(),
            wrote
                .iter()
                .map(|id| format!("@{id}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    )
}

/// Replace one pickRestart/arrange section, then hot-swap.
pub(super) fn tool_upsert_section(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let expr = req_str(input, "code")?;
    let code = current_document(state)?;
    if let Some(blocked) = rewrite_budget_block(state, &[id]) {
        return Ok(blocked);
    }
    let (new_code, wrote) = cycletron_doc::sections::upsert_section(&code, id, expr)?;
    state.stamp_write_kind("section");
    apply_rewrite(
        state,
        event_tx,
        &[wrote.as_str()],
        &new_code,
        &format!("Section @{wrote} updated (other sections unchanged)."),
    )
}

/// Batch section upserts in one apply.
pub(super) fn tool_upsert_sections(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let patches = parse_id_code_patches(input)?;
    let ids: Vec<&str> = patches.iter().map(|(id, _)| id.as_str()).collect();
    if let Some(blocked) = rewrite_budget_block(state, &ids) {
        return Ok(blocked);
    }
    let code = current_document(state)?;
    let (new_code, wrote) = cycletron_doc::sections::upsert_sections(&code, &patches)?;
    state.stamp_write_kind("section");
    let wrote_ids: Vec<&str> = wrote.iter().map(String::as_str).collect();
    apply_rewrite(
        state,
        event_tx,
        &wrote_ids,
        &new_code,
        &format!(
            "{} section(s) updated: {}.",
            wrote.len(),
            wrote
                .iter()
                .map(|id| format!("@{id}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    )
}

/// Replace one top-level const/let binding body (a shared helper — gain bus,
/// synth def, drum kit), then hot-swap. Only that binding's expression changes.
pub(super) fn tool_upsert_binding(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let name = req_str(input, "name")?;
    let expr = req_str(input, "code")?;
    let code = current_document(state)?;
    if let Some(blocked) = rewrite_budget_block(state, &[name]) {
        return Ok(blocked);
    }
    let (new_code, wrote) = cycletron_doc::structure::upsert_binding(&code, name, expr)?;
    state.stamp_write_kind("binding");
    apply_rewrite(
        state,
        event_tx,
        &[wrote.as_str()],
        &new_code,
        &format!("Binding `{wrote}` updated (rest of the document unchanged)."),
    )
}

/// Parse `{ patches: [{id, code}, ...] }` or a single `{id, code}`.
fn parse_id_code_patches(input: &serde_json::Value) -> Result<Vec<(String, String)>, ToolErr> {
    if let Some(arr) = input.get("patches").and_then(|v| v.as_array()) {
        let mut out = Vec::with_capacity(arr.len());
        for (i, p) in arr.iter().enumerate() {
            let id = p["id"]
                .as_str()
                .ok_or_else(|| ToolErr::bad_argument(format!("patches[{i}]: missing 'id'")))?
                .to_string();
            let code = p["code"]
                .as_str()
                .ok_or_else(|| ToolErr::bad_argument(format!("patches[{i}]: missing 'code'")))?
                .to_string();
            out.push((id, code));
        }
        if out.is_empty() {
            return Err(ToolErr::bad_argument("patches array is empty"));
        }
        return Ok(out);
    }
    // Single-object sugar: {id, code} treated as one patch.
    if let (Some(id), Some(code)) = (input["id"].as_str(), input["code"].as_str()) {
        return Ok(vec![(id.to_string(), code.to_string())]);
    }
    Err(ToolErr::bad_argument(
        "expected { patches: [{id, code}, ...] } or {id, code}",
    ))
}

/// Mute one track (comment it out), then hot-swap.
pub(super) fn tool_mute_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let code = current_document(state)?;
    let new_code = cycletron_doc::tracks::mute_track(&code, id)?;
    apply_document(state, event_tx, &new_code, &format!("Track '{id}' muted."))
}

/// Restore a muted track, then hot-swap.
pub(super) fn tool_unmute_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let code = current_document(state)?;
    let new_code = cycletron_doc::tracks::unmute_track(&code, id)?;
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!("Track '{id}' unmuted."),
    )
}

pub(super) fn tool_stop(
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    {
        let mut session = state.session.lock();
        session.playback = PlaybackState::Stopped;
    }

    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__stop_playback".to_string(),
        payload: String::new(),
    });
    Ok(ToolOutcome::ok("stopped", "stop command sent"))
}

pub(super) fn tool_set_tempo(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let bpm = input["bpm"]
        .as_f64()
        .ok_or_else(|| ToolErr::bad_argument("missing 'bpm' parameter"))?;

    {
        let mut session = state.session.lock();
        session.tempo = bpm;
    }

    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__set_tempo".to_string(),
        payload: format!("{bpm}"),
    });
    Ok(ToolOutcome::ok(
        format!("tempo {bpm} BPM"),
        format!("tempo set to {bpm} BPM"),
    ))
}
