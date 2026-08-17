//! Pattern analysis for Cycletron: validation, event inspection, mix critique,
//! and arrangement/form analysis. Extracted from the Tauri app
//! (`src-tauri/src/strudel.rs`, which now re-exports this crate) so the same
//! review pipeline the in-app agent uses can run from CLI tools like
//! `tools/song-check`. Plain Rust: code strings in, serializable digests out.
//!
//! The pipeline is split by concern: [`inspect`] (foundation — execute + digest
//! + note/value helpers), [`arrangement`], [`critique`] (mix), and [`form`].

pub mod arrangement;
pub mod critique;
pub mod engine_contract;
pub mod execute;
pub mod form;
pub mod inspect;
pub mod methods;
pub mod repair;
pub mod sounds;
pub mod spectral;

pub use arrangement::*;
pub use critique::*;
pub use execute::execute;
pub use form::*;
pub use inspect::*;
pub use methods::{dsl_symbols, methods_listing, DslSymbol};
pub use repair::{remap_sounds, sanitize_source, sanitize_source_with_catalog, Sanitized};

#[cfg(test)]
mod tests {
    use super::*;
    // Crate-private helpers the tests exercise directly (not part of the
    // re-exported public API).
    use crate::form::{label_energy, parse_pickrestart_labels};
    use crate::inspect::{midi_to_name, note_name_to_midi};

    fn known() -> sounds::SoundSet {
        sounds::SoundSet::builtin_only()
    }

    #[test]
    fn lint_flags_unknown_sound_as_silent_layer() {
        let d = inspect_code("s(\"bd kicck bd kicck\")", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(
            f.iter().any(|f| f.code == "unknown-sound" && f.severity == "warn"),
            "got: {f:?}"
        );
    }

    #[test]
    fn lint_hints_voicing_for_bare_chord_symbols() {
        // chord("Cm7") without .voicing() reaches the sampler as sound "Cm7".
        let d = inspect_code("s(\"Cm7 FM7\")", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(f.iter().any(|f| f.code == "unvoiced-chord"), "got: {f:?}");
    }

    #[test]
    fn lint_flags_negative_pan() {
        let d = inspect_code("s(\"bd*4\").pan(-0.3)", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(
            f.iter().any(|f| f.code == "pan-range" && f.message.contains("NaN")),
            "got: {f:?}"
        );
    }

    #[test]
    fn lint_accepts_clean_patterns_and_gm_names() {
        let d = inspect_code("stack(s(\"bd*4\"), note(\"c3\").s(\"gm_epiano1\")).pan(0.4)", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(
            f.iter().all(|f| f.severity != "warn"),
            "clean pattern warned: {f:?}"
        );
    }

    #[test]
    fn note_name_parsing() {
        assert_eq!(note_name_to_midi("c4"), Some(60));
        assert_eq!(note_name_to_midi("c"), Some(60)); // default octave 4
        assert_eq!(note_name_to_midi("c#4"), Some(61));
        assert_eq!(note_name_to_midi("db4"), Some(61));
        assert_eq!(note_name_to_midi("a4"), Some(69));
        assert_eq!(note_name_to_midi("eb3"), Some(51));
        // Drum/sample names are not pitches.
        assert_eq!(note_name_to_midi("bd"), None);
        assert_eq!(note_name_to_midi("hh"), None);
        assert_eq!(midi_to_name(60), "c4");
    }

    #[test]
    fn drum_pattern_sounds() {
        let d = inspect_code(r#"s("bd ~ sd ~")"#, 1).unwrap();
        assert_eq!(d.total_events, 2);
        assert_eq!(d.sounds, vec!["bd".to_string(), "sd".to_string()]);
        assert!(d.note_low.is_none(), "drums are not pitched");
        assert!(d.silent_cycles.is_empty());
    }

    #[test]
    fn melody_pitch_range() {
        let d = inspect_code(r#"note("c4 e4 g4 c5")"#, 1).unwrap();
        assert_eq!(d.total_events, 4);
        assert_eq!(d.note_low.as_ref().unwrap().midi, 60);
        assert_eq!(d.note_high.as_ref().unwrap().midi, 72);
    }

    #[test]
    fn synth_voice_keeps_note_and_sound_distinct() {
        let d = inspect_code(r#"note("c3").s("sawtooth")"#, 1).unwrap();
        let ev = &d.cycles[0].events[0];
        assert_eq!(ev.sound.as_deref(), Some("sawtooth"));
        assert_eq!(ev.midi, Some(48));
    }

    #[test]
    fn slowcat_period_detection() {
        // Alternates each cycle → period of 2.
        let d = inspect_code(r#"s("<bd sd>")"#, 8).unwrap();
        assert_eq!(d.period_cycles, Some(2));
    }

    #[test]
    fn stable_pattern_has_period_one() {
        let d = inspect_code(r#"s("bd*4")"#, 4).unwrap();
        assert_eq!(d.period_cycles, Some(1));
        assert_eq!(d.max_voices, 1);
    }

    #[test]
    fn tempo_surfaces_seconds_per_cycle() {
        let d = inspect_code("setbpm(120);\ns(\"bd*4\")", 1).unwrap();
        assert_eq!(d.bpm, Some(120.0));
        // 120 bpm, 4 beats/cycle → 0.5 cps → 2s/cycle.
        assert!((d.seconds_per_cycle.unwrap() - 2.0).abs() < 1e-6);
    }

    #[test]
    fn chord_symbol_not_misread_as_note() {
        // "C7" is a chord symbol here, not the note C octave 7.
        let d = inspect_code(r#"chord("<Gm7 C7 FM7>").s("triangle")"#, 3).unwrap();
        assert!(
            d.note_low.is_none(),
            "unvoiced chord symbols should not register as pitches, got {:?}",
            d.note_low
        );
        // The chord symbol is still surfaced as the event value.
        assert!(d.cycles[0].events.iter().any(|e| e.value == "Gm7"));
    }

    #[test]
    fn arrangement_constant_instrumentation_is_one_section() {
        let a = analyze_code(r#"stack(s("bd*4"), s("hh*8"))"#, 16).unwrap();
        assert_eq!(a.period_cycles, Some(1));
        assert_eq!(a.sections.len(), 1);
        assert_eq!(a.sections[0].instruments, vec!["bd".to_string(), "hh".to_string()]);
        assert_eq!(a.form, "A");
    }

    #[test]
    fn arrangement_detects_entering_instrument() {
        // hh only present on alternating cycles → two sections, ABAB… form,
        // period 2.
        let a = analyze_code(r#"stack(s("bd*4"), s("<hh*4 ~>"))"#, 16).unwrap();
        assert_eq!(a.period_cycles, Some(2));
        assert_eq!(a.form, "A B");
        assert_eq!(a.sections.len(), 2);
        assert!(a.sections[0].instruments.contains(&"hh".to_string()));
        assert!(!a.sections[1].instruments.contains(&"hh".to_string()));
    }

    #[test]
    fn arrangement_total_length_from_tempo() {
        let a = analyze_code("setbpm(120);\ns(\"<bd sd>\")", 8).unwrap();
        assert_eq!(a.period_cycles, Some(2));
        // 120bpm → 0.5cps → 2s/cycle → 2 cycles = 4s.
        assert!((a.total_seconds.unwrap() - 4.0).abs() < 1e-6);
    }

    fn has_code(c: &Critique, code: &str) -> bool {
        c.findings.iter().any(|f| f.code == code)
    }

    #[test]
    fn critique_flags_clipping() {
        // Four independent SUSTAINED full-level sources: 4.0 after grouping →
        // warn. (Drum transients are weighted 0.5×, so they need synths.)
        let c = critique_code(
            r#"stack(note("c2").s("sawtooth").gain(1), note("e3").s("sine").gain(1), note("g3").s("supersaw").gain(1), note("c4").s("triangle").gain(1))"#,
            8,
        )
        .unwrap();
        assert!(has_code(&c, "clipping"), "{:?}", c.findings);
        assert!(!c.ok);
    }

    #[test]
    fn critique_groups_chord_tones_as_one_source() {
        // A 4-note pad at 0.22 + a kick at 0.4: raw sum would be 1.28 → with
        // the OLD per-voice counting a bigger pad would false-positive. After
        // g·√n grouping this is ~0.84 — must be clean (the tool-test report's
        // exact complaint).
        let c = critique_code(
            r#"stack(s("bd*4").gain(0.4), note("[a3,c4,e4,g4]").s("supersaw").gain(0.22))"#,
            8,
        )
        .unwrap();
        assert!(
            !has_code(&c, "clipping") && !has_code(&c, "hot-mix"),
            "chord pad false-positived: {:?}",
            c.findings
        );
    }

    #[test]
    fn critique_hot_but_plausible_mix_is_a_note_not_warn() {
        // ~2.4 sustained after grouping: surfaced as hot-mix note, gate passes.
        let c = critique_code(
            r#"stack(note("c2").s("sawtooth").gain(0.8), note("e3").s("sine").gain(0.8), note("g3").s("supersaw").gain(0.8))"#,
            8,
        )
        .unwrap();
        assert!(has_code(&c, "hot-mix"), "{:?}", c.findings);
        assert!(!has_code(&c, "clipping"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_silent_cycle() {
        let c = critique_code(r#"s("<bd*4 ~>")"#, 8).unwrap();
        assert!(has_code(&c, "silent-cycles"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_static_pitch() {
        let c = critique_code(r#"note("c4 c4 c4 c4").s("triangle")"#, 4).unwrap();
        assert!(has_code(&c, "static-pitch"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_no_low_end() {
        let c = critique_code(r#"note("c5 e5 g5 b5").s("triangle")"#, 4).unwrap();
        assert!(has_code(&c, "no-low-end"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_semitone_clash() {
        let c = critique_code(r#"stack(note("c4").s("sine"), note("c#4").s("sine"))"#, 4).unwrap();
        assert!(has_code(&c, "semitone-clash"), "{:?}", c.findings);
    }

    #[test]
    fn critique_clean_pattern_has_no_warnings() {
        let c = critique_code(
            r#"stack(s("bd*4"), note("c2 e2 g2 a2").s("sawtooth").pan("0.2 0.8"))"#,
            8,
        )
        .unwrap();
        assert!(c.ok, "expected no warnings, got {:?}", c.findings);
    }

    #[test]
    fn invalid_code_errors() {
        assert!(inspect_code("s(\"bd\".gain(", 1).is_err());
    }

    #[test]
    fn lint_source_catches_the_unvoiced_chord_trap() {
        // Trap (b) from the tool-test report — sailed through as "safe".
        let f = lint_source(r#"chord("<Cm7 FM7>").s("supersaw").gain(0.6)"#);
        assert!(
            f.iter().any(|f| f.code == "unvoiced-chord" && f.severity == "warn"),
            "got: {f:?}"
        );
        // Voiced chord: clean.
        assert!(lint_source(r#"chord("<Cm7 FM7>").voicing().s("supersaw")"#).is_empty());
    }

    #[test]
    fn lint_source_ignores_chord_mentioned_in_a_comment() {
        // A `chord(...)` in a `//` comment must not count toward the balance.
        let code = "// chord(...) expands to notes\nchord(\"<C F>\").voicing().s(\"sine\")";
        assert!(
            !lint_source(code).iter().any(|f| f.code == "unvoiced-chord"),
            "comment chord() falsely tripped the lint: {:?}",
            lint_source(code)
        );
    }

    #[test]
    fn lint_source_notes_a_melodic_layer_with_no_instrument() {
        let f = lint_source(r#"note("c4 e4 g4")"#);
        assert!(
            f.iter().any(|f| f.code == "default-synth" && f.severity == "note"),
            "got: {f:?}"
        );
        // With an instrument assigned: no nudge.
        assert!(
            !lint_source(r#"note("c4 e4 g4").s("wt_lead")"#)
                .iter()
                .any(|f| f.code == "default-synth")
        );
    }

    #[test]
    fn critique_does_not_nag_mono_on_a_sparse_centre_mix() {
        // A 3-voice centred sketch must NOT trip the mono note (centre is the
        // default; the nudge is reserved for dense 5+ voice pitched mixes).
        let c = critique_code(
            r#"stack(s("bd*4"), note("c2 e2 g2 c3").s("sawtooth"), note("<c4 e4>").s("sine"))"#,
            4,
        )
        .unwrap();
        assert!(
            !c.findings.iter().any(|f| f.code == "mono"),
            "unexpected mono nag: {:?}",
            c.findings
        );
    }

    #[test]
    fn critique_flags_static_one_bar_loop_but_not_a_developed_phrase() {
        // Whole piece repeats every bar + pitched → loop-development nudge.
        let c = critique_code(r#"stack(s("bd*4"), note("c4 e4 g4 e4").s("sine"))"#, 8).unwrap();
        assert!(
            c.findings.iter().any(|f| f.code == "loop-development"),
            "static loop not flagged: {:?}",
            c.findings
        );
        // A multi-bar developing phrase (period > 1) must NOT trip it.
        let c2 = critique_code(r#"note("<[c4 e4 g4 e4] [g4 e4 c4 e4]>").s("sine")"#, 8).unwrap();
        assert!(
            !c2.findings.iter().any(|f| f.code == "loop-development"),
            "developed phrase wrongly flagged: {:?}",
            c2.findings
        );
    }

    /// The tool-test song shape: 8 labeled tokens × .slow(8). Labels are
    /// ground truth — density flicker inside a section must NOT produce
    /// off-grid warns (the report's bug 2: 18 spurious lines).
    #[test]
    fn form_critique_trusts_pickrestart_labels() {
        let code = r#"setbpm(130);
$: "<intro build drop drop break drop2 drop2 outro>".slow(8).pickRestart({
    intro: s("hh ~ ~ ~"),
    build: s("bd ~ hh ~, ~ ~ ~ hh"),
    drop: s("bd*4, hh*8, ~ cp ~ cp"),
    break: s("<[hh ~ ~ ~] [~ ~ hh ~]>"),
    drop2: s("bd*4, hh*8, cp*2, oh ~ oh ~"),
    outro: s("hh ~ ~ ~")
})"#;
        let c = critique_form_code(code, 64).unwrap();
        assert!(!has_code(&c, "off-grid"), "phantom sections: {:?}", c.findings);
        assert!(!has_code(&c, "missing-slow"), "{:?}", c.findings);
        assert!(c.ok, "expected clean form, got {:?}", c.findings);
    }

    #[test]
    fn form_critique_flags_missing_slow_once() {
        let code = r#"setbpm(130);
$: "<intro drop outro>".pickRestart({
    intro: s("hh ~ ~ ~"),
    drop: s("bd*4, hh*8"),
    outro: s("hh ~ ~ ~")
})"#;
        let c = critique_form_code(code, 16).unwrap();
        assert!(has_code(&c, "missing-slow"), "{:?}", c.findings);
        // ONE clear warn, not a wall of off-grid spam.
        assert_eq!(c.findings.len(), 1, "{:?}", c.findings);
    }

    #[test]
    fn form_critique_flags_off_grid_slow_factor() {
        let code = r#"setbpm(130);
$: "<intro drop>".slow(3).pickRestart({
    intro: s("hh ~ ~ ~"),
    drop: s("bd*4, hh*8")
})"#;
        let c = critique_form_code(code, 16).unwrap();
        assert!(has_code(&c, "off-grid"), "{:?}", c.findings);
    }

    /// `.s(…)` applied BEFORE `.struct(…)` must survive into the digest: a
    /// struct'd chord keeps its sound rather than falling back to the default synth.
    ///
    /// Ignored while the sibling strudel-rs build does not preserve hap context
    /// through `with_structure` — re-enable when that engine fix is present.
    #[test]
    #[ignore = "depends on strudel-rs with_structure hap-context preservation"]
    fn struct_keeps_pre_applied_sound_in_digest() {
        let d = inspect_code(r#"note("[a3,c4,e4]").s("supersaw").struct("~ 1 ~ 1").gain(0.5)"#, 1)
            .unwrap();
        assert!(
            d.sounds.iter().any(|s| s == "supersaw"),
            "struct dropped the sound: {:?}",
            d.sounds
        );
        assert!(
            d.cycles[0].events.iter().all(|e| e.sound.as_deref() == Some("supersaw")),
            "chord events lost sound: {:?}",
            d.cycles[0].events
        );
    }

    /// Generator↔critic contract: pieces from the genre map must not trip the
    /// clipping gate on their own review (the tool-test report caught amapiano
    /// "7 voices ~3.2" and gabber "6 voices ~2.6" under the old per-voice
    /// counting).
    #[test]
    fn generated_pieces_pass_their_own_clipping_gate() {
        for genre in ["amapiano", "gabber", "uplifting-trance", "house"] {
            let code = cycletron_gen::compose::by_name(genre, 7).unwrap().to_strudel();
            let c = critique_code(&code, 8).unwrap();
            assert!(
                !has_code(&c, "clipping"),
                "{genre} trips its own gate: {:?}",
                c.findings
            );
        }
    }

    /// Round-3 report H1: analyze_arrangement must use pickRestart labels as
    /// section ground truth — an intentional 2-on/2-off pad inside one 8-cycle
    /// outro must NOT shred it into 2-cycle micro-sections.
    #[test]
    fn arrangement_reads_pickrestart_labels() {
        let code = r#"setbpm(130);
$: "<intro drop drop outro>".slow(8).pickRestart({
    intro: s("hh ~ ~ ~"),
    drop: s("bd*4, hh*8"),
    outro: stack(s("bd ~ ~ ~"), note("<[a3,c4,e4] [f3,a3,c4] ~ ~>").s("wt_pad"))
})"#;
        let a = analyze_code(code, 32).unwrap();
        assert_eq!(a.form, "intro drop outro", "form: {}", a.form);
        let outro = a.sections.last().unwrap();
        assert_eq!((outro.start_cycle, outro.end_cycle), (24, 31));
        assert_eq!(outro.cycles, 8, "outro shredded: {:?}", a.sections);
        // drop drop merges into one 16-cycle section.
        assert_eq!(a.sections[1].cycles, 16);
    }

    #[test]
    fn arrangement_length_from_pickrestart_selector() {
        // 4 selector tokens (intro drop drop outro) × .slow(8) = 32-cycle loop.
        // The onset fingerprint finds no clean repeat here, but the selector is
        // authoritative — this is the length export auto-detect relies on.
        let code = r#"setbpm(120);
$: "<intro drop drop outro>".slow(8).pickRestart({
    intro: s("hh ~ ~ ~"),
    drop: s("bd*4, hh*8"),
    outro: s("bd ~ ~ ~")
})"#;
        let a = analyze_code(code, 64).unwrap();
        assert_eq!(a.period_cycles, Some(32), "pickRestart total should drive length");
        assert!(a.repeats);
        // 120 BPM → cps 0.5 → 2s/cycle → 32 × 2 = 64s.
        let secs = a.total_seconds.expect("total_seconds");
        assert!((secs - 64.0).abs() < 0.01, "total_seconds = {secs}");
    }

    #[test]
    fn arrangement_length_falls_back_to_fingerprint_without_selector() {
        // No pickRestart → onset-fingerprint period detection still applies.
        let a = analyze_code("setbpm(120);\ns(\"<bd sd>\")", 8).unwrap();
        assert_eq!(a.period_cycles, Some(2));
        assert!(a.repeats);
    }

    /// Report bug 4 repro attempt: a sound introduced by a LATER pickRestart
    /// section must appear in the digest's sound list.
    #[test]
    fn digest_sees_sounds_from_later_sections() {
        let code = r#"$: "<a b>".slow(2).pickRestart({
    a: s("bd*4"),
    b: note("c3 e3").s("sawtooth")
})"#;
        let d = inspect_code(code, 8).unwrap();
        assert!(
            d.sounds.iter().any(|s| s == "bd") && d.sounds.iter().any(|s| s == "sawtooth"),
            "sounds: {:?}",
            d.sounds
        );
    }

    #[test]
    fn pickrestart_labels_parse() {
        assert_eq!(
            parse_pickrestart_labels(r#""<intro verse drop>".slow(4).pickRestart({})"#),
            Some(vec!["intro".into(), "verse".into(), "drop".into()])
        );
        // `@N` (weight: one continuous N-cycle slot) and `!N` (replicate: N
        // restarting slots) both mean the label spans N selector cycles —
        // expand so section lengths come out right (engine-verified via
        // dsl-eval: `b@2` plays 4 bars through, `b!2` restarts at bar 3).
        assert_eq!(
            parse_pickrestart_labels(r#""<intro@2 drop!3>".pickRestart({})"#),
            Some(vec![
                "intro".into(),
                "intro".into(),
                "drop".into(),
                "drop".into(),
                "drop".into()
            ])
        );
        // Numeric note selectors are not section labels.
        assert_eq!(parse_pickrestart_labels(r#""<0 2 4>".pickRestart({})"#), None);
        // Not a pickRestart at all.
        assert_eq!(parse_pickrestart_labels(r#"note("c e g")"#), None);
    }

    #[test]
    fn label_energy_tiers() {
        assert_eq!(label_energy("drop"), 5);
        assert_eq!(label_energy("final-chorus"), 5);
        assert_eq!(label_energy("lift"), 3);
        assert_eq!(label_energy("intro"), 1);
        assert_eq!(label_energy("break"), 1);
        assert_eq!(label_energy("verse"), 2); // default/mid
    }

    #[test]
    fn form_critique_flags_single_texture() {
        // One looping bar over the window → "no arrangement" note, no warnings.
        let c = critique_form_code(r#"s("bd sd")"#, 8).unwrap();
        assert!(c.ok, "single loop is a note, not a warning");
        assert!(
            c.findings.iter().any(|f| f.code == "no-form"),
            "expected a no-form note, got {:?}",
            c.findings
        );
    }
}
