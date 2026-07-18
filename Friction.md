Form critique completely misread the pickRestart structure — treating density changes as sections and ignoring labels. Rewriting with correct section math and lower gains.Clipping and form still noisy. Dropping gains further and simplifying the form critique's confusion by making every section's internal density constant.Form critique is false-positiveing on density-based sections (not pickRestart labels). Clipping is over-counting simultaneous chord notes. Playing anyway — these are known critique bugs, not real musical issues.# Friction Report — Tooling Self-Test

## High friction (silent or hard to diagnose)

1. **Unvoiced `chord()` is NOT caught by silence lint**
   - Trap (b): `chord("<Cm7 FM7>").s("supersaw").gain(0.6)` → `valid — safe to play`
   - Prompt says "Without `.voicing()`, the chord symbol is treated as a sample bank name → silence." Lint promised to catch this. It didn't. Dead layer sails through as safe.

2. **Form critique ignores pickRestart labels — invents density-based "sections"**
   - Song with `"<intro build drop drop break drop2 drop2 outro>".slow(8)` (8×8 = 64 cycles, all multiples of 4/8)
   - review_pattern returned: `[warn] off-grid: Section F is 2 cycle(s)`, `Section G is 2 cycle(s)` ×4
   - analyze_arrangement confirms the bug source: form `A B C D E F G F G` with F/G as 2-cycle fragments of the *outro* because the pad pattern `<[a3,…] [f4,…] ~ ~>` changes density mid-section. Labels never appear. False-positives block the gate.

3. **Clipping warn over-counts chord notes as separate voices**
   - 4-note pad at gain 0.22 + kick 0.4 = ~1.28 real, but reported as "8 voices summing to gain ~2.6"
   - inspect_pattern confirms: cycle 0 has 1 bd + 4 wt_pad notes. Critique treats each chord tone as a full voice → unfixable clipping warnings on every multi-voice stack. Generator pieces hit the same wall (amapiano "7 voices ~3.2", gabber "6 voices ~2.6").

4. **review_pattern digest omits sounds that fire later**
   - Digest after 64-cycle scan: `sounds: bd, hh, oh, sd, sine, wt_bell, wt_pad, wt_pluck` — **gm_epiano1 missing** even though drop/drop2 use it.
   - inspect_pattern (16 cyc, only intro+build) correctly lists only early sounds. Digest should surface all sounds across the scanned window.

## Medium friction (workflow)

5. **genre_recipe coverage is a stub vs generate_pattern**
   - `genre_recipe("2-step garage")` → `No recipe matches. Available: acid-techno, ambient, chiptune, drum-and-bass, hip-hop, house, indie-synth-rock, pop-punk, synthwave.` (9 recipes)
   - generate_pattern routes 60+ genres (amapiano, gabber, uplifting-trance, ukg, trance all worked). Recipe tool is useless for the genres the generator invents.

6. **Clipping gate forces extra review rounds that can't pass**
   - Phase 3 ideal: write → review → fix → review → play. Actual: 3 reviews, still clipping-warn on final. Gains dropped from 0.9→0.75→0.4 and still "gain ~2.6". Had to override and play with warns active. The gate can't be satisfied for any 4-note chord stack.

7. **Form critique spam: same warn repeated per scan window**
   - First review (bad .slow(2)): 18 identical off-grid warns ("Section A is 2 cycle(s)" ×3, etc.). One unique problem → 18 lines. Should dedupe.

8. **list_sounds vs prompt drift**
   - list_sounds returns `wt_sine, wt_tri, wt_square, wt_saw` not in the system prompt's wavetable list.
   - Prompt lists `sbd` under synths — present. Prompt mentions `.chorus .chorusspeed .vowel .grainsize .scatter .ir` as "New effects" but list_sounds doesn't surface effects at all (expected, but no way to confirm they exist).

9. **Syntax error message is usable but position is opaque**
   - Trap (e): `s("bd*4".fast(2)` → `Unclosed parenthesis - missing closing ')' at 16..16`
   - Correct diagnosis, but "16..16" with no snippet context means counting chars by hand. Fine for short strings; painful for multi-line.

## Wishlist

10. **pickRestart-aware form critique**
    - When code has `"<a b c>".slow(N).pickRestart({...})`, form critique should read the *selector tokens × slow factor*, not re-segment by density. API: if pickRestart AST present, emit `intro: 8cyc, build: 8cyc, …` and check those; only fall back to density segmentation for free-form stacks.

11. **Clipping should weight by perceptual loudness / group chord tones**
    - Notes from the same `note("[a3,c4,e4,g4]")` event should count as one voice at the stated gain, not N. Or report peak *sample* estimate, not raw gain-sum.

12. **generate_pattern should self-gate**
    - Both amapiano and gabber trip clipping on review_as-is. Generator should lower gains until its own critique is clean, or emit a pre-validated stack.

## Tool-call count per phase

| Phase | Ideal | Actual | Why over |
|---|---|---|---|
| 0 inventory | 1 | 1 | — |
| 1 trap tests | 5 | 5 | — |
| 2 genre map | 5 gen + 2 review + 1 play = 8 | 5 gen + 2 review + 1 play = 8 | — |
| 3 full song | ≤2 context + write + 2 review + play ≈ 5 | 2 context + 3 review + 1 play = 6 | Extra review because clipping/form warns unfixable; third review still warned, played anyway |
| 4 analyzers | 2 | 2 | — |
| 5 report | 0 | 0 | — |
| **Total** | **~21** | **22** | +1 forced re-review |

## Verdict on the new tooling

**Did review_pattern cut round-trips?** Partially. Phase 3 stayed near the ideal shape (6 vs 5) — the old validate+critique+critique_form chain would have been 3× per gate = 9 just for gates. Bundling works. But the *quality* of the bundled form/mix critiques forced an extra cycle and an override-to-play, so the net win is real for syntax/silence, soft for musical gates.

**Did the silence lint catch what it promised?**
- ✅ Unknown sounds (a): named both `kicck` and `boom_bap`, said SILENT, pointed at list_sounds.
- ❌ Unvoiced chord (b): **missed completely** — `valid — safe to play`. This is the highest-severity miss; it's the exact failure mode the prompt warns about.
- ✅ Negative pan (c): named the NaN/sqrt problem, gave the fix range.
- ✅ Clean gm control (d): no false positive.
- ✅ Real syntax error (e): clear, actionable.

**What it still missed:** unvoiced chords; form-section identity under pickRestart; chord-tone-as-voice clipping inflation; gm_epiano1 absent from digest.

## Top-3 highest-ROI fixes

1. **Silence-lint: unvoiced chord()**
   - Detect `chord(...)` without a downstream `.voicing()` in the same chain → `[warn] unvoiced-chord: chord("Cm7") needs .voicing() or the symbol is treated as a sample name → silence.`
   - Shape: same as current unknown-sound warn. One AST walk.

2. **Form critique: prefer pickRestart labels over density segmentation**
   - If AST contains `.pickRestart({...})` + a slowcat/selector with `.slow(N)`, compute section lengths as `token_count_of_label × N` and check those. Only density-segment when no pickRestart is present.
   - Shape: `== form critique ==\n  intro  8cyc  ok\n  build  8cyc  ok\n  …\n  [warn] drop is 3cyc — not multiple of 4` (only when true). Kill the "Section F is 2 cycle(s)" spam.

3. **Clipping: group simultaneous same-source notes; soft-cap the warn**
   - Notes sharing onset + sound + gain (i.e. a chord event) count as 1 toward the stack. Report `peak_gain_sum` after grouping. Optionally downgrade to `[note]` when sum < 3.0 after grouping so generators and pad stacks stop blocking the gate.
   - Shape: `[warn] clipping: 3 independent sources at cycle 8 sum to ~1.8 after chord-grouping (raw 8 voices / 2.6).` Or stay quiet below a calibrated threshold.

---

**Phase 1 trap scorecard (for the lint fix PR):**

| Trap | Expected | Got | Pass? |
|---|---|---|---|
| (a) unknown sound | warn + name | warn both names | ✅ |
| (b) unvoiced chord | warn + .voicing() fix | `valid — safe to play` | ❌ **BUG** |
| (c) pan -0.5 | warn NaN/silent | warn + fix range | ✅ |
| (d) clean gm | no warn | no warn | ✅ |
| (e) syntax error | INVALID + hint | Unclosed paren at 16..16 | ✅ |
