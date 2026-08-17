//! Benchmark for the full review pipeline the in-app agent runs per
//! `review_pattern` call (and `song-check` per file). Mirrors
//! `src-tauri/src/agent_loop.rs::review_code` minus AppState so regressions
//! and wins on the analysis hot path are measurable in isolation.
//!
//! Run: `cargo bench -p cycletron-analysis --bench review`
//! Baselines: `-- --save-baseline pre` / `-- --baseline pre`

use core::hint::black_box;
use criterion::{criterion_group, criterion_main, Criterion};
use cycletron_analysis as analysis;

const SMALL: &str = include_str!("../../../corpus/showcase/techno-loop.strudel");
const MEDIUM: &str = include_str!("../../../corpus/showcase/hard-industrial-acid.strudel");
const LARGE: &str = include_str!("../../../ui/songs/agency/13-kill-switch.strudel");

/// Mirror of `review_code` (src-tauri/src/agent_loop.rs) without AppState.
fn review(code: &str, cycles: usize, known: &analysis::sounds::SoundSet) -> usize {
    analysis::validate_code(code).unwrap();
    let digest = analysis::inspect_code(code, cycles).unwrap();
    let mut findings = analysis::lint_source(code);
    findings.extend(analysis::lint_digest(&digest, known));
    findings.extend(analysis::critique_code(code, cycles).unwrap().findings);
    if code.contains("pickRestart") || code.contains("arrange") {
        black_box(analysis::analyze_code(code, cycles).unwrap());
        findings.extend(analysis::critique_form_code(code, cycles).unwrap().findings);
    }
    findings.len()
}

fn bench_review(c: &mut Criterion) {
    let known = analysis::sounds::SoundSet::builtin_only();
    let mut group = c.benchmark_group("review");
    for (id, code, cycles) in [
        ("small_8", SMALL, 8),
        ("medium_16", MEDIUM, 16),
        ("large_64", LARGE, 64),
    ] {
        group.bench_function(id, |b| {
            b.iter(|| black_box(review(black_box(code), cycles, &known)))
        });
    }
    group.finish();

    c.bench_function("sound_set/builtin", |b| {
        b.iter(|| black_box(analysis::sounds::builtin_sound_set()))
    });
}

criterion_group!(benches, bench_review);
criterion_main!(benches);
