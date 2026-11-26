#[allow(unused_imports)]
use super::tools_analysis::infer_write_kind;
use super::*;

#[cfg(test)]
mod write_path_tests {
    use super::*;
    use serde_json::json;

    fn state_with_code(code: &str) -> AppState {
        let s = AppState::new();
        s.session.lock().set_pattern(code.to_string());
        s.reset_agent_write_run();
        s
    }

    fn sink() -> mpsc::UnboundedSender<AgentEvent> {
        let (tx, _rx) = mpsc::unbounded_channel();
        tx
    }

    #[test]
    fn review_without_code_uses_editor() {
        let s = state_with_code(r#"s("bd*4")"#);
        let out = tool_review_pattern(&json!({}), &s).unwrap();
        assert!(out.ok, "got: {out:?}");
        assert!(out.text.starts_with("REVIEW"), "got: {}", out.text);
        assert!(
            s.last_reviewed_code().as_deref() == Some(r#"s("bd*4")"#),
            "review should stash the buffer"
        );
    }

    #[test]
    fn inspect_and_analyze_without_code_use_editor() {
        let s = state_with_code(r#"s("bd*4")"#);
        let inspect =
            tool_inspect_pattern(&json!({"cycles": 4, "verbosity": "summary"}), &s).unwrap();
        assert!(inspect.ok, "inspect: {inspect:?}");
        assert!(
            inspect.text.to_lowercase().contains("bd") || inspect.text.contains("4 events"),
            "should inspect the editor, not require a toy snippet: {}",
            inspect.text
        );
        let analyze = tool_analyze_arrangement(&json!({}), &s).unwrap();
        assert!(analyze.ok, "analyze: {analyze:?}");
        assert!(
            !analyze.text.contains("sawtooth"),
            "must not invent a dummy pattern: {}",
            analyze.text
        );
    }

    #[test]
    fn review_cache_hits_on_identical_code() {
        let s = state_with_code(r#"s("bd*4")"#);
        let a = tool_review_pattern(&json!({"code": r#"s("bd*4")"#}), &s).unwrap();
        assert!(!a.text.contains("(cached"));
        let b = tool_review_pattern(&json!({"code": r#"s("bd*4")"#}), &s).unwrap();
        assert!(
            b.text.contains("(cached"),
            "second identical review should cache: {}",
            b.text
        );
        assert!(b.summary.starts_with("cached review"), "{}", b.summary);
        assert!(b.ok);
        // Cache hits must not burn the review budget.
        assert_eq!(s.agent_write.lock().review_calls, 1);
    }

    #[test]
    fn review_budget_blocks_third_distinct_review() {
        let s = AppState::new();
        s.reset_agent_write_run();
        let codes = [r#"s("bd*4")"#, r#"s("bd*8")"#, r#"s("hh*8")"#];
        for (i, code) in codes.iter().enumerate() {
            let out = tool_review_pattern(&json!({"code": code}), &s).unwrap();
            if i < 2 {
                assert!(
                    out.text.starts_with("REVIEW"),
                    "review {i} should run, got: {}",
                    out.text
                );
            } else {
                assert_eq!(
                    out.category,
                    Some(ToolCategory::BudgetExhausted),
                    "third review should hit budget, got: {out:?}"
                );
                assert!(!out.retryable);
                assert!(out.text.contains("Review budget used"));
            }
        }
        assert_eq!(s.agent_write.lock().review_calls, 2);
    }

    #[test]
    fn play_without_code_reuses_last_reviewed() {
        let s = AppState::new();
        s.reset_agent_write_run();
        let code = r#"s("bd*4").gain(0.8)"#;
        let rev = tool_review_pattern(&json!({"code": code}), &s).unwrap();
        assert!(rev.text.contains("VERDICT"), "{}", rev.text);

        let out = tool_play_pattern(&json!({}), &s, &sink()).unwrap();
        assert!(out.ok, "{out:?}");
        assert!(
            out.text.contains("reused") || out.text.contains("playback"),
            "play with no code should reuse: {}",
            out.text
        );
        assert_eq!(s.session.lock().current_pattern.as_deref(), Some(code));
        assert_eq!(s.take_write_kind().as_deref(), Some("reuse"));
    }

    #[test]
    fn play_with_code_stamps_full() {
        let s = AppState::new();
        let out = tool_play_pattern(&json!({"code": r#"s("sd*2")"#}), &s, &sink()).unwrap();
        assert!(out.ok, "{out:?}");
        assert!(out.text.contains("playback"), "{}", out.text);
        assert_eq!(out.to_model_text().lines().next(), Some("[result ok=true]"));
        // stamp may already be taken by a caller; stamp_write_kind sets pending
        // — tool_play_pattern stamps "full" for explicit code.
        // We already consumed nothing; pending should be "full".
        assert_eq!(s.take_write_kind().as_deref(), Some("full"));
    }

    #[test]
    fn model_output_chars_proxy_drops_on_reuse_path() {
        // Proxy for LLM cost: when play reuses the reviewed code (omits its own),
        // a review→play turn emits the song once, not twice.
        let song = r#"s("bd*4")"#.repeat(500); // ~4k chars
        let legacy_emit = song.len() * 2; // review + play both with code
        let fast_emit = song.len(); // review only; play reuses
        assert!(fast_emit * 2 == legacy_emit);
        assert_eq!(fast_emit, legacy_emit / 2);
    }

    #[test]
    fn section_upsert_beats_full_rewrite_on_chars() {
        let song =
            std::fs::read_to_string("/tmp/cycletron-bench-song.strudel").unwrap_or_else(|_| {
                r#"
"<intro@1 drop1@2>".slow(4).pickRestart({
  intro: stack(s("bd*4")),
  drop1: stack(s("bd*4").gain(1.0), s("sd*2"))
})
"#
                .into()
            });
        let secs = cycletron_doc::sections::list_sections(&song);
        assert!(
            !secs.is_empty(),
            "bench song should parse as pickRestart sections"
        );
        let drop = secs
            .iter()
            .find(|s| s.id == "drop1")
            .expect("drop1 section");
        let section_body = &song[drop.expr_start..drop.expr_end];
        // Surgical path emits ~section size; legacy re-emits whole song twice.
        let surgical = section_body.len();
        let legacy = song.len() * 2;
        assert!(
            surgical * 5 < legacy,
            "section upsert should be >>5× smaller emit than full review+play \
             (section={surgical}, legacy={legacy})"
        );
    }

    #[test]
    fn play_with_builtin_review_blocks_invalid() {
        let s = AppState::new();
        // Truly un-evaluable: unclosed call + junk method.
        let out = tool_play_pattern(
            &json!({"code": "s(\"bd*4\").nope(((", "review": true}),
            &s,
            &sink(),
        )
        .unwrap();
        assert_eq!(
            out.category,
            Some(ToolCategory::NotApplied),
            "invalid code must not play: {out:?}"
        );
        assert!(out.retryable);
        assert!(out.text.starts_with("NOT PLAYED"), "{}", out.text);
        assert!(s.session.lock().current_pattern.is_none());
    }

    #[test]
    fn play_with_silent_layer_carries_structured_warnings() {
        let s = AppState::new();
        // `nope` is not a sound → the silence lint warns, but the pattern
        // still plays (advisory). The warn must be in the envelope, not only
        // in the prose.
        let out = tool_play_pattern(
            &json!({"code": r#"stack(s("bd*4"), s("nope*2"))"#, "review": false}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert!(
            out.warnings.iter().any(|w| w.severity == "warn"),
            "expected a silence-lint warn in the envelope: {out:?}"
        );
        assert!(out.summary.contains("warning"), "{}", out.summary);
        assert!(out.to_model_text().starts_with("[result ok=true warnings="));
    }

    #[test]
    fn repairs_are_reported_structurally() {
        let s = AppState::new();
        // A fenced pattern is mechanically repaired before it plays.
        let out = tool_play_pattern(
            &json!({"code": "```js\ns(\"bd*4\")\n```", "review": false}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert!(
            !out.repairs.is_empty(),
            "fence removal should be a repair: {out:?}"
        );
        assert_eq!(
            s.session.lock().current_pattern.as_deref(),
            Some("s(\"bd*4\")")
        );
    }

    #[test]
    fn hard_failures_are_classified() {
        let s = AppState::new();
        // Nothing in the editor → precondition, not a generic error.
        let e = tool_list_parts(&s).unwrap_err();
        assert_eq!(e.category, ToolCategory::Precondition);
        let e = tool_upsert_track(&json!({"id": "x"}), &s, &sink()).unwrap_err();
        assert_eq!(e.category, ToolCategory::BadArgument);
        assert!(e.message.contains("'code'"));

        let s = state_with_code(r#"$: s("bd*4") // @drums"#);
        let e = tool_mute_track(&json!({"id": "lead"}), &s, &sink()).unwrap_err();
        assert_eq!(e.category, ToolCategory::NotFound);
        assert!(e.message.contains("@drums"));
        let e = tool_upsert_section(&json!({"id": "a", "code": "x"}), &s, &sink()).unwrap_err();
        assert_eq!(e.category, ToolCategory::Precondition);
        s.library.lock().root = std::env::temp_dir();
        let e = tool_read_song(&json!({"path": "/etc/passwd"}), &s).unwrap_err();
        assert_eq!(e.category, ToolCategory::PathDenied);
        assert!(!e.into_outcome().retryable);
    }

    #[test]
    fn play_without_code_after_an_edit_plays_the_edit_not_the_stale_review() {
        let song = r#"
setbpm(120);
"<a@1 b@1>".slow(2).pickRestart({
  a: s("bd*4"),
  b: s("sd*2")
})
"#;
        let s = state_with_code(song);
        assert!(tool_review_pattern(&json!({}), &s).unwrap().ok);
        assert_eq!(s.last_reviewed_code().as_deref(), Some(song));
        let out =
            tool_upsert_section(&json!({"id": "b", "code": r#"s("hh*8")"#}), &s, &sink()).unwrap();
        assert!(out.ok, "{out:?}");
        assert!(
            s.last_reviewed_code().is_none(),
            "an applied edit retires the reviewed buffer"
        );
        let played = tool_play_pattern(&json!({"review": false}), &s, &sink()).unwrap();
        assert!(played.ok, "{played:?}");
        let doc = s.session.lock().current_pattern.clone().unwrap();
        assert!(
            doc.contains(r#"b: s("hh*8")"#),
            "play must keep the edit: {doc}"
        );
    }

    #[test]
    fn third_rewrite_of_one_section_is_refused_and_resets_per_run() {
        let song = r#"
setbpm(120);
"<a@1 b@1>".slow(2).pickRestart({
  a: s("bd*4"),
  b: s("sd*2")
})
"#;
        let s = state_with_code(song);
        let take = |code: &str| {
            tool_upsert_section(&json!({"id": "b", "code": code}), &s, &sink()).unwrap()
        };
        assert!(take(r#"s("hh*8")"#).ok);
        // A NOT APPLIED attempt does not count: the model must be able to fix it.
        let bad = take("s(\"hh*8\").nope(((");
        assert_eq!(bad.category, Some(ToolCategory::NotApplied));
        assert!(take(r#"s("hh*4")"#).ok);
        let third = take(r#"s("hh*2")"#);
        assert_eq!(
            third.category,
            Some(ToolCategory::BudgetExhausted),
            "{third:?}"
        );
        assert!(!third.retryable);
        assert!(third.text.contains("@b"), "{}", third.text);
        // Another target is unaffected, and the batch form checks every id.
        assert!(take_other(&s).ok);
        let batch = tool_upsert_sections(
            &json!({"patches": [{"id": "a", "code": r#"s("bd*2")"#}, {"id": "b", "code": r#"s("cp")"#}]}),
            &s,
            &sink(),
        )
        .unwrap();
        assert_eq!(batch.category, Some(ToolCategory::BudgetExhausted));
        // A new user message resets the budget.
        s.reset_agent_write_run();
        assert!(take(r#"s("hh")"#).ok);

        fn take_other(s: &AppState) -> ToolOutcome {
            tool_upsert_section(&json!({"id": "a", "code": r#"s("bd*8")"#}), s, &sink()).unwrap()
        }
    }

    #[test]
    fn leeway_policy_never_refuses_and_drops_the_advisory_line() {
        let song =
            "setbpm(120);\n\"<a@1 b@1>\".slow(2).pickRestart({ a: s(\"bd*4\"), b: s(\"sd*2\") })\n";
        let s = state_with_code(song);
        *s.agent_policy.lock() = crate::state::AgentPolicy::LEEWAY;
        for i in 0..4 {
            let out = tool_upsert_section(
                &json!({"id": "b", "code": format!("s(\"hh*{}\")", i + 1)}),
                &s,
                &sink(),
            )
            .unwrap();
            assert!(out.ok, "take {i}: {out:?}");
        }
        // Masking notes exist in this mix; the leeway review does not frame them.
        let doc = r#"stack(note("a2 e2").s("sawtooth").lpf(300).gain(0.6), note("<[c4,e4,g4]>").s("wt_strings").gain(0.8), note("<e4 g4>").s("wt_choir").lpf(4200).gain(0.5))"#;
        let r = review_code(doc, 4, &s);
        assert!(r.warnings.iter().any(|w| w.severity == "note"), "{r:?}");
        assert!(!r.text.contains("observations, not defects"));
        *s.agent_policy.lock() = crate::state::AgentPolicy::default();
        let r = review_code(doc, 4, &s);
        assert!(r.text.contains("observations, not defects"), "{}", r.text);
    }

    #[test]
    fn full_play_blocked_after_list_sections_unless_force() {
        let song = r#"setbpm(120);
const sections = {
  intro: stack(s("bd*4").gain(0.5)),
  drop1: stack(s("bd*4").gain(0.9), s("sd*2")),
  outro: note("c2").s("sine")
};
$: "<intro@1 drop1@2 outro@1>".slow(4).pickRestart({
  intro: sections.intro, drop1: sections.drop1, outro: sections.outro
})
"#;
        // Pad so full rewrite exceeds FULL_REWRITE_GUARD_CHARS.
        let song = format!("{song}\n// {}\n", "x".repeat(4_200));
        let s = state_with_code(&song);
        let listed = tool_list_sections(&s).unwrap();
        assert_eq!(listed.summary, "3 section(s)");
        assert!(listed.text.contains("@drop1"), "{}", listed.text);
        assert!(
            listed.text.contains("stack") || listed.text.contains("bd"),
            "fat preview: {}",
            listed.text
        );

        let big = format!("{song}\n// rewrite attempt\n");
        assert!(big.len() >= crate::state::FULL_REWRITE_GUARD_CHARS);
        let blocked =
            tool_play_pattern(&json!({"code": big, "review": false}), &s, &sink()).unwrap();
        assert_eq!(
            blocked.category,
            Some(ToolCategory::PolicyBlocked),
            "expected full rewrite block, got: {blocked:?}"
        );
        assert!(blocked.retryable, "the model may retry with force:true");
        assert!(blocked.text.contains("force: true"), "{}", blocked.text);
        assert_eq!(s.take_write_kind().as_deref(), Some("full_blocked"));

        let forced = tool_play_pattern(
            &json!({"code": &song, "review": false, "force": true}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(forced.ok, "force:true must allow play: {forced:?}");
    }

    #[test]
    fn list_and_upsert_section_roundtrip() {
        let song = r#"
setbpm(120);
"<a@1 b@1>".slow(2).pickRestart({
  a: s("bd*4"),
  b: s("sd*2")
})
"#;
        let s = state_with_code(song);
        let listed = tool_list_sections(&s).unwrap();
        assert!(listed.text.contains("@a"), "{}", listed.text);
        assert!(listed.text.contains("@b"), "{}", listed.text);

        let out = tool_upsert_section(
            &json!({"id": "b", "code": r#"s("hh*8").gain(0.5)"#}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert_eq!(out.summary, "Section @b updated");
        assert!(out.text.contains("Section @b"), "{}", out.text);
        let doc = s.session.lock().current_pattern.clone().unwrap();
        assert!(doc.contains(r#"b: s("hh*8").gain(0.5)"#));
        assert!(doc.contains(r#"a: s("bd*4")"#));
    }

    #[test]
    fn upsert_binding_replaces_helper_const() {
        let song = r#"setbpm(120);
const lead = note("c e g").s("sawtooth").gain(0.6);
$: lead.slow(2)
"#;
        let s = state_with_code(song);
        let out = tool_upsert_binding(
            &json!({"name": "lead", "code": r#"note("a c e").s("square")"#}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert!(out.text.contains("Binding `lead`"), "{}", out.text);
        let doc = s.session.lock().current_pattern.clone().unwrap();
        // Only the binding body changed; the track and directive are intact.
        assert!(
            doc.contains(r#"const lead = note("a c e").s("square");"#),
            "{doc}"
        );
        assert!(doc.contains("$: lead.slow(2)"));
        assert!(doc.contains("setbpm(120);"));
        assert!(!doc.contains("sawtooth"));
    }

    /// Local wall-time + emit-size bench (no LLM). Run with:
    ///   cargo test -p cycletron-app write_path_bench -- --nocapture --ignored
    #[test]
    #[ignore = "manual bench — needs /tmp/cycletron-bench-song.strudel"]
    fn write_path_bench() {
        use std::time::Instant;
        let song = std::fs::read_to_string("/tmp/cycletron-bench-song.strudel")
            .expect("export session song to /tmp/cycletron-bench-song.strudel first");
        let s = AppState::new();
        let secs = cycletron_doc::sections::list_sections(&song);
        eprintln!("=== write-path bench ===");
        eprintln!(
            "song: {} chars, {} lines, {} sections",
            song.len(),
            song.lines().count(),
            secs.len()
        );

        let t0 = Instant::now();
        let report = review_code(&song, 8, &s);
        let review_ms = t0.elapsed().as_millis();
        eprintln!(
            "review_code (8 cyc): {review_ms} ms  verdict={}",
            report.text.lines().last().unwrap_or("")
        );

        let t1 = Instant::now();
        let _ = cycletron_doc::sections::list_sections(&song);
        eprintln!("list_sections: {} µs", t1.elapsed().as_micros());

        if let Some(drop) = secs.iter().find(|x| x.id == "drop1") {
            let body = &song[drop.expr_start..drop.expr_end];
            let t2 = Instant::now();
            let (new_doc, _) =
                cycletron_doc::sections::upsert_section(&song, "drop1", body).unwrap();
            eprintln!(
                "upsert_section(drop1) same body: {} µs  (emit proxy: section={} vs full×2={})",
                t2.elapsed().as_micros(),
                body.len(),
                song.len() * 2
            );
            assert_eq!(new_doc, song, "identity upsert should be byte-identical");
        }

        // Model-output proxy for the last song's 4-turn session shape.
        let legacy_edit = song.len() * 2; // review+play full
        let reuse_edit = song.len(); // review full, play()
        let section_edit = secs
            .iter()
            .find(|x| x.id == "drop1")
            .map(|d| d.expr_end - d.expr_start)
            .unwrap_or(500);
        eprintln!("emit-size proxy (chars the model must stream):");
        eprintln!("  legacy review+play:     {legacy_edit}");
        eprintln!(
            "  review + play reuse:    {reuse_edit}  (−{}%)",
            100 - 100 * reuse_edit / legacy_edit
        );
        eprintln!(
            "  upsert_section(drop1):  {section_edit}  (−{}%)",
            100 - 100 * section_edit / legacy_edit
        );
    }
}

#[cfg(test)]
mod turn_end_tests {
    use super::*;
    use cycletron_agent::client::AgentError;
    use parking_lot::Mutex;
    use std::collections::VecDeque;

    /// Hands back scripted responses in order, then a provider error.
    struct Scripted(Mutex<VecDeque<MessagesResponse>>);

    impl Scripted {
        fn new(responses: Vec<MessagesResponse>) -> Self {
            Self(Mutex::new(responses.into()))
        }
    }

    #[async_trait::async_trait]
    impl LlmProvider for Scripted {
        async fn stream_message(
            &self,
            _system: &str,
            _messages: &[ApiMessage],
            _tools: &[ToolDefinition],
            _event_tx: &mpsc::UnboundedSender<AgentEvent>,
        ) -> Result<MessagesResponse, AgentError> {
            self.0
                .lock()
                .pop_front()
                .ok_or_else(|| AgentError::Http("script exhausted".to_string()))
        }

        fn max_tokens(&self) -> u32 {
            4096
        }
    }

    fn response(content: Vec<ContentBlock>, stop: StopReason) -> MessagesResponse {
        MessagesResponse {
            id: String::new(),
            content,
            stop,
            usage: Usage {
                input_tokens: 0,
                output_tokens: 0,
            },
        }
    }

    fn text(t: &str) -> ContentBlock {
        ContentBlock::Text {
            text: t.to_string(),
        }
    }

    async fn run(provider: &Scripted) -> Turn {
        let state = AppState::new();
        let mut session = cycletron_core::session::Session::new(120.0);
        session.add_user_message("make a beat".to_string());
        let (tx, _rx) = mpsc::unbounded_channel();
        run_agent_loop(provider, &session.messages, &state, tx).await
    }

    #[tokio::test]
    async fn dropped_stream_fails_but_keeps_text() {
        let p = Scripted::new(vec![response(vec![text("half a")], StopReason::Dropped)]);
        let turn = run(&p).await;
        assert_eq!(turn.text, "half a");
        assert!(
            matches!(turn.end, TurnEnd::Failed(_)),
            "dropped stream must fail the turn"
        );
    }

    #[test]
    fn error_stop_notice_carries_the_provider_message() {
        let end = TurnEnd::Failed("AI provider error: Overloaded".to_string());
        assert_eq!(
            end.notice().as_deref(),
            Some("AI provider error: Overloaded")
        );
        assert!(TurnEnd::Complete.notice().is_none());
    }

    #[tokio::test]
    async fn max_tokens_without_tools_is_truncated() {
        let p = Scripted::new(vec![response(
            vec![text("a very long")],
            StopReason::MaxTokens { cut_tool: None },
        )]);
        let turn = run(&p).await;
        assert_eq!(turn.text, "a very long");
        assert!(matches!(turn.end, TurnEnd::Truncated));
    }

    #[tokio::test]
    async fn cut_tool_gets_truncated_result_and_a_complete_tool_still_runs() {
        let call_ok = ContentBlock::ToolUse {
            id: "t1".to_string(),
            name: "list_methods".to_string(),
            input: serde_json::json!({}),
        };
        let call_cut = ContentBlock::ToolUse {
            id: "t2".to_string(),
            name: "play_pattern".to_string(),
            input: serde_json::json!({}),
        };
        let p = Scripted::new(vec![
            response(
                vec![call_ok, call_cut],
                StopReason::MaxTokens {
                    cut_tool: Some("t2".to_string()),
                },
            ),
            response(vec![text("done")], StopReason::EndTurn),
        ]);
        let turn = run(&p).await;
        assert!(matches!(turn.end, TurnEnd::Complete));
        assert_eq!(turn.tools.len(), 2);
        assert!(
            turn.tools[0].outcome.ok,
            "zero-arg tool must run: {:?}",
            turn.tools[0].outcome
        );
        assert_eq!(
            turn.tools[1].outcome.category,
            Some(ToolCategory::Truncated)
        );
    }

    #[tokio::test]
    async fn provider_error_after_a_tool_round_keeps_the_trace() {
        let call = ContentBlock::ToolUse {
            id: "t1".to_string(),
            name: "list_methods".to_string(),
            input: serde_json::json!({}),
        };
        // One tool round, then the script runs out: the provider fails.
        let p = Scripted::new(vec![response(vec![call], StopReason::ToolUse)]);
        let turn = run(&p).await;
        assert!(matches!(turn.end, TurnEnd::Failed(_)));
        assert_eq!(turn.tools.len(), 1, "the tool that ran must stay on record");
    }

    #[tokio::test]
    async fn endless_tool_rounds_hit_the_cap() {
        let rounds = (0..MAX_ITERATIONS)
            .map(|i| {
                response(
                    vec![ContentBlock::ToolUse {
                        id: format!("t{i}"),
                        name: "list_methods".to_string(),
                        input: serde_json::json!({}),
                    }],
                    StopReason::ToolUse,
                )
            })
            .collect();
        let p = Scripted::new(rounds);
        let turn = run(&p).await;
        assert!(matches!(turn.end, TurnEnd::IterationCap));
        assert_eq!(turn.tools.len(), MAX_ITERATIONS);
    }
}

#[cfg(test)]
mod session_history_tests {
    use super::*;
    use chrono::Utc;
    use cycletron_core::types::{ToolCategory, ToolOutcome, ToolTrace};
    use serde_json::json;

    fn chat(role: ChatRole, content: &str, tools: Vec<ToolTrace>) -> ChatMessage {
        ChatMessage {
            id: "m".to_string(),
            role,
            content: content.to_string(),
            timestamp: Utc::now(),
            tools,
        }
    }

    #[test]
    fn tool_turns_replay_as_structured_exchange() {
        // An assistant turn that called a tool must come back as the assistant
        // tool_use + a paired user tool_result — otherwise the model forgets
        // what it already did (the #2 amnesia bug).
        let history = vec![
            chat(ChatRole::User, "make a house beat", vec![]),
            chat(
                ChatRole::Assistant,
                "Here you go",
                vec![ToolTrace {
                    id: "call_1".into(),
                    name: "play_pattern".into(),
                    input: json!({ "code": "bd*4" }),
                    outcome: ToolOutcome::ok("playing", "playing"),
                    duration_ms: 3,
                }],
            ),
            chat(ChatRole::User, "louder", vec![]),
        ];

        let api = session_to_api_messages(&history);
        // user, assistant(text+tool_use), user(tool_result), user.
        assert_eq!(api.len(), 4);

        assert_eq!(api[1].role, "assistant");
        assert!(matches!(&api[1].content[0], ContentBlock::Text { text } if text == "Here you go"));
        match &api[1].content[1] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "play_pattern");
                assert_eq!(input["code"], "bd*4");
            }
            other => panic!("expected tool_use, got {other:?}"),
        }

        assert_eq!(api[2].role, "user");
        match &api[2].content[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "call_1");
                // The envelope header survives replay so categories reach the
                // model on later turns too.
                assert_eq!(content, "[result ok=true]\nplaying");
                assert_eq!(*is_error, None);
            }
            other => panic!("expected tool_result, got {other:?}"),
        }

        assert_eq!(api[3].role, "user");
    }

    #[test]
    fn text_only_history_is_flat_and_system_is_skipped() {
        let history = vec![
            chat(ChatRole::System, "sys", vec![]),
            chat(ChatRole::User, "hi", vec![]),
            chat(ChatRole::Assistant, "hello", vec![]),
        ];
        let api = session_to_api_messages(&history);
        // System dropped (passed separately); two plain text turns remain.
        assert_eq!(api.len(), 2);
        assert_eq!(api[0].role, "user");
        assert_eq!(api[1].role, "assistant");
        assert!(matches!(&api[1].content[0], ContentBlock::Text { text } if text == "hello"));
    }

    #[test]
    fn errored_tool_and_toolless_prose_round_trip() {
        // Empty assistant prose + an errored tool: the assistant turn is just
        // the tool_use, and the result carries is_error = Some(true) plus the
        // failure header.
        let history = vec![chat(
            ChatRole::Assistant,
            "",
            vec![ToolTrace {
                id: "c9".into(),
                name: "save_song".into(),
                input: json!({ "name": "x" }),
                outcome: ToolOutcome::failed(ToolCategory::PathDenied, "denied"),
                duration_ms: 0,
            }],
        )];
        let api = session_to_api_messages(&history);
        assert_eq!(api[0].content.len(), 1);
        assert!(matches!(&api[0].content[0], ContentBlock::ToolUse { .. }));
        match &api[1].content[0] {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(*is_error, Some(true));
                assert_eq!(
                    content,
                    "[result ok=false category=path-denied retryable=no]\ndenied"
                );
            }
            other => panic!("expected tool_result, got {other:?}"),
        }
    }
}

/// Headless agent eval: run real prompts through the real loop against the
/// configured provider and print what the agent did — every tool row with its
/// outcome category and timing, the reply, and a review of the song it
/// left in the editor. Each song is written to `_eval/<arm>/<slug>.strudel`.
///
/// Uses the app's own data dir (settings, provider key / OAuth, corpus), so a
/// debug build reads `provider-keys.json` there. Run with:
///
///   cargo test -p cycletron-app agent_eval -- --ignored --nocapture
///
/// Env: `CYCLETRON_EVAL_PROMPTS` (`;`-separated; default: five genre briefs),
/// `CYCLETRON_EVAL_SEED` (a `.strudel` file loaded into the editor before every
/// prompt, so the prompts are edit requests), `CYCLETRON_EVAL_ARMS`
/// (`guardrails`, `leeway`, or both comma-separated; default `guardrails`),
/// `CYCLETRON_EVAL_DATA_DIR`, `CYCLETRON_EVAL_OUT`.
#[cfg(test)]
mod agent_eval {
    use super::*;
    use crate::state::AgentPolicy;
    use cycletron_core::session::Session;
    use std::path::PathBuf;
    use std::time::Instant;

    const DEFAULT_PROMPTS: &str = "Make me a deep house track — warm, rolling, something I could DJ with;\
        Build a driving techno track, dark and hypnotic, 130 bpm;\
        Write a drum and bass tune with a proper break and a reese bass;\
        Give me a boom-bap hip-hop beat with a dusty sample-style lead;\
        Make an ambient piece — slow, evolving pads, no drums, that breathes";

    fn slug(s: &str) -> String {
        s.chars()
            .take(40)
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

    fn policy_for(arm: &str) -> AgentPolicy {
        match arm {
            "leeway" => AgentPolicy::LEEWAY,
            "guardrails" => AgentPolicy::default(),
            other => panic!("unknown arm '{other}' (guardrails | leeway)"),
        }
    }

    /// What one prompt cost and left behind.
    #[derive(Default)]
    struct Run {
        calls: usize,
        fails: Vec<String>,
        blocked: usize,
        code_chars: usize,
        rewrites: std::collections::BTreeMap<String, usize>,
        tool_ms: u64,
    }

    #[tokio::test]
    #[ignore = "manual eval — talks to the configured LLM provider"]
    async fn agent_eval() {
        let data_dir = std::env::var("CYCLETRON_EVAL_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").unwrap())
                    .join("Library/Application Support/com.nukleas.cycletron")
            });
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let out_dir = std::env::var("CYCLETRON_EVAL_OUT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| workspace.join("_eval"));
        let prompts: Vec<String> = std::env::var("CYCLETRON_EVAL_PROMPTS")
            .unwrap_or_else(|_| DEFAULT_PROMPTS.to_string())
            .split(';')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        let seed = std::env::var("CYCLETRON_EVAL_SEED")
            .ok()
            .map(|p| std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("seed {p}: {e}")));
        let arms: Vec<String> = std::env::var("CYCLETRON_EVAL_ARMS")
            .unwrap_or_else(|_| "guardrails".to_string())
            .split(',')
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect();

        let state = AppState::new();
        state.initialize(data_dir).expect("initialize app state");
        let samples = cycletron_render::SampleSetPaths::Cycletron {
            manifest: workspace.join("ui/public/cycletron.strudel.json"),
            packs: Vec::new(),
        };
        *state.sample_paths.lock() = Some(samples.clone());
        let active = state.user_settings.lock().llm.active.clone();
        if crate::oauth::refresh_if_stale(&active).await {
            state.rebuild_agent_client();
        }
        let client = state
            .agent_client
            .lock()
            .clone()
            .expect("no AI provider configured (is ai_consent on, and is a key stored?)");
        let model = state
            .user_settings
            .lock()
            .llm
            .active_profile()
            .model
            .clone();
        eprintln!(
            "== agent eval: provider={active} model={model} prompts={} arms={} seed={} ==",
            prompts.len(),
            arms.join(","),
            seed.as_ref()
                .map_or("none".to_string(), |s| format!("{} chars", s.len()))
        );

        let mut rows: Vec<String> = Vec::new();
        for arm in &arms {
            *state.agent_policy.lock() = policy_for(arm);
            let arm_dir = out_dir.join(arm);
            std::fs::create_dir_all(&arm_dir).unwrap();
            let mut totals = Run::default();
            let mut total_wall = 0.0f64;

            for prompt in &prompts {
                eprintln!("\n### [{arm}] {prompt}");
                let tempo = state.config.lock().audio.default_tempo;
                let mut session = Session::new(tempo);
                if let Some(code) = &seed {
                    session.set_pattern(code.clone());
                }
                *state.session.lock() = session;
                let messages = {
                    let mut s = state.session.lock();
                    s.add_user_message(prompt.clone());
                    s.messages.clone()
                };

                let (tx, mut rx) = mpsc::unbounded_channel();
                let printer = tokio::spawn(async move {
                    let mut run = Run::default();
                    while let Some(ev) = rx.recv().await {
                        match ev {
                            AgentEvent::ToolCall { name, input, .. } => {
                                let compact = crate::telemetry::truncate(
                                    &serde_json::to_string(&input).unwrap_or_default(),
                                    110,
                                );
                                eprintln!("  ⚙ {name} {compact}");
                                run.code_chars +=
                                    crate::telemetry::code_chars_of(&input).unwrap_or(0);
                                if name.starts_with("upsert_") {
                                    let ids: Vec<String> = input["patches"]
                                        .as_array()
                                        .map(|a| {
                                            a.iter()
                                                .filter_map(|p| p["id"].as_str().map(String::from))
                                                .collect()
                                        })
                                        .unwrap_or_else(|| {
                                            input["id"]
                                                .as_str()
                                                .or(input["name"].as_str())
                                                .map(|s| vec![s.to_string()])
                                                .unwrap_or_default()
                                        });
                                    for id in ids {
                                        *run.rewrites.entry(rewrite_key(&id)).or_insert(0) += 1;
                                    }
                                }
                            }
                            AgentEvent::ToolResult {
                                name,
                                outcome,
                                duration_ms,
                                ..
                            } => {
                                run.calls += 1;
                                run.tool_ms += duration_ms;
                                let cat = outcome
                                    .category
                                    .map(|c| format!(" [{}]", c.as_str()))
                                    .unwrap_or_default();
                                if !outcome.ok {
                                    run.fails.push(format!("{name}{cat}"));
                                }
                                if outcome.category == Some(ToolCategory::BudgetExhausted)
                                    && name.starts_with("upsert_")
                                {
                                    run.blocked += 1;
                                }
                                eprintln!(
                                    "  {} {name} — {}{cat} ({duration_ms} ms)",
                                    if outcome.ok { "✓" } else { "✗" },
                                    outcome.summary
                                );
                            }
                            _ => {}
                        }
                    }
                    run
                });

                let started = Instant::now();
                let turn = run_agent_loop(client.as_ref(), &messages, &state, tx).await;
                let wall = started.elapsed().as_secs_f64();
                let run = printer.await.unwrap();

                state
                    .session
                    .lock()
                    .add_assistant_message_with_tools(turn.text.clone(), turn.tools);
                let reply = match turn.end.notice() {
                    Some(notice) => format!("{} [{notice}]", turn.text),
                    None => turn.text,
                };
                let reply_preview: String = reply.replace('\n', " ").chars().take(240).collect();
                eprintln!("  ↳ {reply_preview}");

                let code = state.session.lock().current_pattern.clone();
                let quality = match &code {
                    Some(c) if seed.as_deref() == Some(c.as_str()) => {
                        "unchanged from the seed".to_string()
                    }
                    Some(c) => {
                        let path = arm_dir.join(format!("{}.strudel", slug(prompt)));
                        std::fs::write(&path, c).unwrap();
                        let r = review_code(c, 8, &state);
                        let warns = r.warnings.iter().filter(|w| w.severity == "warn").count();
                        let notes = r.warnings.iter().filter(|w| w.severity == "note").count();
                        let heard = {
                            let (c, samples) = (c.clone(), samples.clone());
                            tokio::task::spawn_blocking(move || {
                                cycletron_render::hear(
                                    &c,
                                    &samples,
                                    cycletron_render::HearOptions {
                                        cycles: Some(4),
                                        stems: false,
                                        ..cycletron_render::HearOptions::default()
                                    },
                                )
                            })
                            .await
                            .unwrap()
                            .map(|h| h.verdict)
                            .unwrap_or_else(|e| format!("hear failed: {e}"))
                        };
                        eprintln!(
                            "  saved {} ({} chars) — {} · hear: {heard}",
                            path.display(),
                            c.len(),
                            r.summary
                        );
                        if r.ok {
                            format!(
                                "{} chars, {warns} warn, {notes} note, hear {heard}",
                                c.len()
                            )
                        } else {
                            "INVALID".to_string()
                        }
                    }
                    None => "no song in the editor".to_string(),
                };
                let repeats: Vec<String> = run
                    .rewrites
                    .iter()
                    .filter(|(_, n)| **n > 1)
                    .map(|(k, n)| format!("@{k}×{n}"))
                    .collect();
                rows.push(format!(
                    "{arm:<10} {:<34} {:>4.0}s {:>2} tools {:>6} code chars  blocked {}  fails {:<22} repeats {:<16} song: {quality}",
                    slug(prompt).chars().take(34).collect::<String>(),
                    wall,
                    run.calls,
                    run.code_chars,
                    run.blocked,
                    if run.fails.is_empty() {
                        "none".to_string()
                    } else {
                        run.fails.join(",")
                    },
                    if repeats.is_empty() {
                        "-".to_string()
                    } else {
                        repeats.join(" ")
                    },
                ));
                totals.calls += run.calls;
                totals.code_chars += run.code_chars;
                totals.blocked += run.blocked;
                totals.fails.extend(run.fails);
                total_wall += wall;
            }
            rows.push(format!(
                "{arm:<10} TOTAL {:>4.0}s {:>3} tools {:>7} code chars  blocked {}  fails {}",
                total_wall,
                totals.calls,
                totals.code_chars,
                totals.blocked,
                totals.fails.len()
            ));
        }

        eprintln!("\n== summary ==");
        for r in &rows {
            eprintln!("{r}");
        }
    }
}
