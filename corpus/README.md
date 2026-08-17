# Cycletron curated corpus

Hand-written `.strudel` examples that exercise the strudel-rs DSL from first
principles. Every file is gated by `cargo run -p corpus-check`, which runs the same
`validate_code` pipeline the live REPL uses — anything that doesn't parse +
evaluate is rejected before it can land.

## Layout

```
corpus/
├── rhythm/    — drum patterns, polyrhythm, euclidean grooves, swing/halftime
├── melody/    — single-line note sequences, scales, modal studies, call/response
├── harmony/   — chord progressions, voicings, drone + melody
├── form/      — multi-section pieces, builds, intros, AABB switching
├── timbre/    — synth design: FM, supersaw, bitcrush, pluck+delay
├── motion/    — continuous modulation: LFOs, rotating Euclidean
└── _examples/ — unpicked MusicRepo candidates (local staging: not gated, not shipped, not committed)
```

Each example is a complete, self-contained `.strudel` file with `setbpm(N);`
at the top.

## Conventions

- One musical idea per file. The first comment line is a short label.
- Use only DSL surface from `docs/STRUDEL_RS_SUPPORTED.md`.
- Prefer named pitches (`c4 e4 g4`) over numeric MIDI for readability.
- Set tempo explicitly at the top of a piece — `setbpm(120);` etc.
- Keep pieces short (4–16 bars of cycle content) so the validator stays fast.

## Adding a new example

1. Draft the `.strudel` file in the right subdir.
2. Run `cargo run -p corpus-check -- corpus/your-subdir/your-file.strudel`.
3. If validation passes, run the whole gate: `cargo run -p corpus-check`.
4. Commit.
