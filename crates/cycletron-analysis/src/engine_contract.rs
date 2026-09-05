//! Executable documentation for the strudel-rs engine's behavior contract.
//!
//! Every claim we make *about the engine* — in `docs/STRUDEL_RS_SUPPORTED.md`,
//! `prompts/system.md`, code comments, and the agent's `list_sounds` /
//! `list_methods` output — is a fact that can silently go stale when the pinned
//! engine rev bumps. Free-text prose has nothing binding it to reality; this
//! module does. Each case below is run against the *actual* pinned engine by
//! [`check`], which is gated two ways: a `#[test]` here and the `corpus-check`
//! tool. If the engine's behavior drifts from a documented claim, one of these
//! goes red — so the fix is forced at the seam (the rev bump), not months later
//! when a user notices the agent got confused.
//!
//! When a case here fails after an intentional engine change, update BOTH this
//! table AND the prose it guards (the failure message names the doc claim).

use crate::validate_code;
use strudel_core::ContextKey;

/// A documented behavior, paired with the human-facing claim it backs so a
/// failure points straight at the prose to fix.
struct Case {
    code: &'static str,
    /// Where this behavior is asserted to users/agents.
    doc: &'static str,
}

/// Patterns the validator MUST accept (documented as supported).
const ACCEPTS: &[Case] = &[
    Case {
        code: r#"s("bd").bank("RolandTR808")"#,
        doc: "STRUDEL_RS_SUPPORTED §6 / prompt: .bank() is supported",
    },
    Case {
        code: r#"note("c3").s("sawtooth").bank("RolandTR808")"#,
        doc: ".bank() no-ops on synths (only affects samples)",
    },
    Case {
        code: r#"s("bd sd").bank("<RolandTR808 RolandTR909>")"#,
        doc: ".bank(name) accepts a pattern (per-cycle alternation)",
    },
    Case {
        code: r#"s("bd cp").bank("LinnDrum")"#,
        doc: ".bank() validates even when the kit lacks a voice (plays silent)",
    },
    Case {
        code: r#"s("bd*4").every(2, x => x.fast(2))"#,
        doc: "bare arrow x => … in a callback",
    },
    Case {
        code: r#"s("bd*4").every(2, (x) => x.fast(2))"#,
        doc: "STRUDEL_RS_SUPPORTED §8: parenthesised arrow (x) => … IS accepted (was previously rejected)",
    },
    Case {
        code: r#"s("bd").speed(2).begin(0.1).end(0.9).cut(1)"#,
        doc: "STRUDEL_RS_SUPPORTED §6 sample-playback controls",
    },
    Case {
        code: r#"s("bd").chorus(0.3).vowel(1).scatter(0.2)"#,
        doc: "STRUDEL_RS_SUPPORTED effect quick-list",
    },
    Case {
        code: r#"note("[c3,e3,g3,b3]").arp("<up updown converge pinkyup>")"#,
        doc: "STRUDEL_RS_SUPPORTED §4 / prompt: arp accepts Tidal ordering names",
    },
    Case {
        code: r#"note("[c3,e3,g3]").arp("0 2 1")"#,
        doc: "STRUDEL_RS_SUPPORTED §4 / prompt: arp accepts an index pattern",
    },
    Case {
        code: r#"note("c3").s("square").pw("0.3:2:0.4").pwmrate(1).pwmdepth(0.2)"#,
        doc: "STRUDEL_RS_SUPPORTED §4 / prompt: width/pw colon form + PWM controls",
    },
    Case {
        code: r#"note("c3").s("sawtooth").phaser(1.5).phaserdepth(0.5)"#,
        doc: "STRUDEL_RS_SUPPORTED §4 / prompt: phaser controls",
    },
    Case {
        code: r#"s("bd sd hh cp").ribbon(0, 1.5).press.hurry(2)"#,
        doc: "STRUDEL_RS_SUPPORTED §4 / prompt: ribbon, press, hurry",
    },
    Case {
        code: r#"s("bd sd").beat("0 4", 8).pressBy(0.25)"#,
        doc: "STRUDEL_RS_SUPPORTED §4 / prompt: beat(positions, div), pressBy",
    },
    Case {
        code: r#"s("bd sd hh cp").expand(2).pace(8).contract(2)"#,
        doc: "STRUDEL_RS_SUPPORTED §4 stepwise: pace / expand / contract",
    },
    Case {
        code: r#"s("<bd, sd>")"#,
        doc: "prompt: a comma inside < > parses (it just does not stack)",
    },
];

/// Patterns the validator MUST reject (documented as parser gotchas).
const REJECTS: &[Case] = &[
    Case {
        code: r#"setbpm 120"#,
        doc: "STRUDEL_RS_SUPPORTED §8: setbpm needs parens + semicolon",
    },
    Case {
        code: r#"s("bd(3,8,<0 1 2>)")"#,
        doc: "STRUDEL_RS_SUPPORTED §8: Euclid rotation arg must be static",
    },
    Case {
        code: r#"s("<bd | sd>")"#,
        doc: "STRUDEL_RS_SUPPORTED §8: | random-choice does not compose inside < >",
    },
    Case {
        code: r#"s("bd").nonexistentmethod(3)"#,
        doc: "unknown methods are rejected (validator ⊇ documented surface)",
    },
];

/// Run every contract case against the pinned engine. Returns one message per
/// VIOLATED claim (empty slice = engine matches all documentation). Callers gate
/// on the returned list being empty.
pub fn check() -> Vec<String> {
    let mut fails = Vec::new();

    for c in ACCEPTS {
        if let Err(e) = validate_code(c.code) {
            fails.push(format!(
                "engine no longer ACCEPTS `{}` (doc: {}) — validator said: {}",
                c.code,
                c.doc,
                e.trim()
            ));
        }
    }
    for c in REJECTS {
        if validate_code(c.code).is_ok() {
            fails.push(format!(
                "engine no longer REJECTS `{}` (doc: {}) — it now validates; the doc/prompt gotcha is stale",
                c.code, c.doc
            ));
        }
    }

    // .bank() must actually resolve, not merely parse: the bank name lands in the
    // hap's context on a banked pattern and is absent without it. If this breaks,
    // `.bank()` silently no-ops and the machine-kit story is a lie.
    match bank_context(r#"s("bd").bank("RolandTR808")"#) {
        Some(b) if b.contains("RolandTR808") => {}
        other => fails.push(format!(
            "`.bank(\"RolandTR808\")` did not put the bank in the hap context (got {other:?}) — \
             .bank() no longer resolves; drum-machine docs are stale"
        )),
    }
    if let Some(b) = bank_context(r#"s("bd")"#) {
        fails.push(format!(
            "plain `s(\"bd\")` unexpectedly carries a bank context ({b:?}) — bank resolution changed"
        ));
    }

    fails
}

/// The `bank` value in the first cycle-0 hap's context, if any.
fn bank_context(code: &str) -> Option<String> {
    let out = strudel_dsl::execute(code).ok()?;
    out.pattern
        .query_arc(0, 1)
        .into_iter()
        .find_map(|h| h.context.get(&ContextKey::Bank).map(|v| format!("{v:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_matches_documented_contract() {
        let fails = check();
        assert!(
            fails.is_empty(),
            "engine behavior drifted from documentation ({} claim(s)); \
             update engine_contract.rs AND the prose each names:\n  - {}",
            fails.len(),
            fails.join("\n  - ")
        );
    }
}
