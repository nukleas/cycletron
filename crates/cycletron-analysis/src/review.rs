//! The full review pipeline — digest header, silence lint, mix critique, and
//! (for pickRestart/arrange songs) the form map + form critique — over ONE
//! evaluation. This is the exact report the in-app agent's `review_pattern`
//! tool and the `song-check` CLI both render; each caller appends its own
//! VERDICT line and error framing.

use crate::sounds::SoundSet;
use crate::{Evaluated, Finding};

pub enum ReviewOutcome {
    /// The code did not evaluate.
    Invalid(String),
    /// The rendered report (no VERDICT line) and how many warns it contains.
    Report { text: String, warns: usize },
}

pub fn review_report(code: &str, cycles: usize, known: &SoundSet) -> ReviewOutcome {
    // Form checks need ≥8 cycles; the mix critique needs ≥4.
    let has_form = code.contains("pickRestart") || code.contains("arrange");
    let window = if has_form { cycles.clamp(8, 64) } else { cycles.clamp(4, 64) };
    let ev = match Evaluated::new(code, window) {
        Ok(ev) => ev,
        Err(e) => return ReviewOutcome::Invalid(e),
    };
    let digest = ev.digest();

    let mut out = String::from("REVIEW\n== digest ==\n");
    out.push_str(&format!(
        "  bpm {}  ·  {} events / {} cycles  ·  period {}  ·  max {} voices  ·  sounds: {}\n",
        digest.bpm.map(|b| b.to_string()).unwrap_or_else(|| "unset".into()),
        digest.total_events,
        digest.cycles_queried,
        digest
            .period_cycles
            .map(|p| format!("{p} cycle(s)"))
            .unwrap_or_else(|| "none detected".into()),
        digest.max_voices,
        digest.sounds.join(", "),
    ));

    let mut warns = 0usize;
    let section = |title: &str, findings: &[Finding], out: &mut String| {
        out.push_str(&format!("== {title} ==\n"));
        if findings.is_empty() {
            out.push_str("  clean\n");
        }
        for f in findings {
            out.push_str(&format!("  [{}] {}: {}\n", f.severity, f.code, f.message));
        }
    };

    let mut lint = crate::lint_source(code);
    lint.extend(crate::lint_digest(digest, known));
    warns += lint.iter().filter(|f| f.severity == "warn").count();
    section("silence lint", &lint, &mut out);

    let c = crate::critique(&ev);
    warns += c.findings.iter().filter(|f| f.severity == "warn").count();
    section("mix critique", &c.findings, &mut out);

    if has_form {
        // Section→label map so the form is visible without a separate
        // analyze_arrangement call (labels come from the pickRestart selector).
        let a = crate::analyze(&ev);
        out.push_str("== form map ==\n");
        for s in &a.sections {
            out.push_str(&format!(
                "  {:<10} cyc {:>2}–{:<3} {:>5.1} ev/cyc  {}\n",
                s.label,
                s.start_cycle,
                s.end_cycle,
                s.avg_events_per_cycle,
                s.instruments.join(", ")
            ));
        }
        let c = crate::critique_form(&ev);
        warns += c.findings.iter().filter(|f| f.severity == "warn").count();
        section("form critique", &c.findings, &mut out);
    }

    ReviewOutcome::Report { text: out, warns }
}
