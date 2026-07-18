Review passed clean. Playing, then cross-checking with the analyzers.---


# FRICTION REPORT — structured self-test


## Tool-call count per phase


| Phase | Ideal | Actual | Delta | Why |
|---|---|---|---|---|
| 0 inventory | 1 | 1 | 0 | — |
| 1 trap tests | 5 | 5 | 0 | parallel batch |
| 2 genre map | 5 gen + 2 review + 1 play = 8 | 5 + 2 + 1 = 8 | 0 | — |
| 3 full song | ≤2 reads → write → review → fix → review → play (≤5) | 1 review + 1 play = 2 | −3 | pre-existing editor code already valid; single-gate claim held |
| 4 analyzers | 2 | 2 | 0 | — |
| Total | ~16 | 18 | +2 | Phase 0+1 baseline; no waste |


---


## High friction (silent or hard to diagnose)


### H1. analyze_arrangement shreds the outro into FG FG fragments
Snippet (tool output):

Form: A B C D E F G F G
  F  cyc 56–57  bd wt_bell wt_pad   ~6 ev/cyc
  G  cyc 58–59  bd wt_bell          ~2 ev/cyc
  F  cyc 60–61  bd wt_bell wt_pad   ~6 ev/cyc
  G  cyc 62–63  bd wt_bell          ~2 ev/cyc

The pickRestart label is a single 8-cycle outro. The pad pattern is note("<[a3,c4,e4,g4] [f4,a4,c5,e5] ~ ~>") — intentional 2-on / 2-off. The analyzer treats the rest-cycles as an instrumentation change → splits one section into four 2-cycle micro-sections. pickRestart labels are invisible to it. Form critique (inside review_pattern) correctly said clean; the arrangement tool disagrees with itself's sibling.

### H2. review_pattern digest silently drops gm_epiano1
Snippet:

== digest ==
  sounds: bd, hh, oh, sd, sine, wt_bell, wt_pad, wt_pluck

Code has s("gm_epiano1") in both drop and drop2 (32 of 64 cycles). Not listed. inspect_pattern over 16 cycles (intro+build only) also omits it — fair for that window — but the 64-cycle digest has no excuse. A user grepping the digest for "is my epiano actually firing?" gets a false negative.

### H3. review_pattern form critique does not surface robotic pad loops
The pad in every section is the same 4-bar chord walk under .slow(8) labels — it loops 2× per 8-cycle section and 4× across the two drop tokens. Form critique returned clean. The system prompt documents "robotic 1-bar loop under a long section" as a form warn, but a 4-bar phrase under an 8-cycle (or 16-cycle via repeated labels) section is not flagged. Either the threshold is too loose, or multi-token sections (drop drop) aren't summed when checking loop-vs-section-length.


### H4. inspect_pattern dumps every onset — unusable for long forms
16 cycles → ~150 lines of per-event detail. For a 64-cycle song this would be thousands of lines. There is no summary mode (e.g. verbosity: summary | events). To answer "does the drop enter at cycle 16?" you must scroll. The high-level facts (sounds, pitch range, loop length) are buried under the event log.


---


## Medium friction (workflow)


### M1. Genre family routing collapses to one child with no disambiguation
Snippet:

// generate_pattern(genre="trance")
// uplifting trance in A minor (generated) — four-on-floor...

Identical code to uplifting-trance. Calling the bare family name silently picks one subgenre. No "routed trance → uplifting-trance; other children: psytrance, …" note. A user asking for "trance" and getting a supersaw uplift with no warning has no way to know the map has more.

### M2. ukg alias routes correctly, but the comment labels it "2-step garage"

// 2-step garage in G minor (generated) — shuffled 2-step...

Alias works. The comment genre name doesn't match the requested alias. Cosmetic, but if you're grepping generated comments for the alias you typed, you miss it.

### M3. Generator pieces always trip the mono note
Both reviewed generators:

[note] mono: All 7 voices are centre-panned — the mix is mono.
[note] mono: All 6 voices are centre-panned — the mix is mono.

Every generate_pattern output is fully centre-panned. The critic dutifully notes it every time. Either the generator should sprinkle .pan(0.3) / .jux(rev) on hats/leads, or the mono note should suppress when every voice is centre (it's the default, not a mistake). As-is, the note is noise on generated code.

### M4. Gabber generator produces a intentional-but-flagged semitone clash

[note] semitone-clash: 1 simultaneous minor-2nd clash(es) (e.g. a2 vs a#3 at cycle 1).

A phrygian bass with a#2 against an a-minor-ish stab is on-brand for gabber. The critic can't know genre intent. Severity is only note (good), but there's no way for the generator to mark a clash as intentional, so every gabber/phrygian seed will carry this forever.

### M5. list_sounds omits effects documented in the system prompt
System prompt lists .chorus, .chorusspeed, .vowel, .grainsize, .scatter, .ir. list_sounds returns only sample/synth names — no effects inventory. Not a bug per se (it's list_sounds, not list_methods), but the prompt documents these as "New effects" with no other discovery path. If an effect is engine-missing, you find out only at validate time.


### M6. Syntax-error caret is good; recovery hint is generic
Snippet:

INVALID: dsl-notation error: Unclosed parenthesis - missing closing ')' at 16..16
  line 1: s("bd*4".fast(2)
                          ^ here
Fix the error and validate again before playing.

Caret is excellent. The "fix" is "fix the error" — no suggestion that the real problem is also a quote-before-method issue ("bd4".fast(2) vs "bd4").fast(2)). For this particular trap the unclosed-paren diagnosis is technically correct (the ( after s is never closed), but the user-intended bug is the string closed too early. A secondary hint ("did you mean .fast(2) outside the string?") would cut a confused retry.

---


## Wishlist


### W1. review_pattern digest should list section→label map when pickRestart is present

== form ==
  intro  0–7    e1  bd,wt_pad
  build  8–15   e3  bd,hh,sine,wt_bell,wt_pad
  drop   16–31  e5  …

Today you need a separate analyze_arrangement call, and even that invents A/B/C labels instead of using the pickRestart keys (see H1).

### W2. inspect_pattern verbosity: "summary" flag
Return sounds / pitch range / loop length / per-cycle event counts / section boundaries — not every onset. Keep the full event log behind verbosity: "events" (default for ≤4 cycles).


### W3. generate_pattern should accept pan: true (or just always width-spread hats/leads)
Kills M3 at the source. One .jux(rev) on the hat line and .pan(0.35) on the lead would silence the mono note and sound better.


### W4. Silence-lint coverage gap: missing .s() / .sound() on a note pattern
Not tested this round, but worth adding: note("c3 e3 g3") with no sound defaults to sine (audible) — fine. chord("Cm7").voicing() with no .s() — does it warn? Unknown. A "no-sound-specified" note (not warn) would help.


---


## Phase 1 trap scorecard


| Trap | Expected | Result | Pass? |
|---|---|---|---|
| (a) s("kicck*4 boom_bap") | warn unknown sounds | [warn] unknown-sound: 'boom_bap'… + 'kicck'… + fix hint | ✅ |
| (b) chord("<Cm7 FM7>").s("supersaw") | warn unvoiced | [warn] unvoiced-chord: … Write chord(…).voicing().s(…) | ✅ |
| (c) .pan(-0.5) | warn pan range | [warn] pan-range: pan -0.50 is outside 0..1 — … NaN … silent | ✅ |
| (d) note(…).s("gm_epiano1") | clean (no false positive) | valid — safe to play | ✅ |
| (e) s("bd*4".fast(2) | syntax error, useful msg | Unclosed parenthesis … ^ here | ✅ (caret good; see M6 for recovery-hint gap) |


Silence lint: 3/3 traps caught, 0 false positives on the control. Promised coverage delivered.


---


## Phase 2 genre map scorecard


| Request | Routed? | Own-review gate |
|---|---|---|
| amapiano | ✅ F# minor, 112 bpm | clean (mono note only) |
| gabber | ✅ A phrygian, 180 bpm | clean (semitone-clash note + mono) |
| uplifting-trance | ✅ A minor, 138 bpm | (not re-reviewed) |
| ukg (alias) | ✅ → 2-step garage, 130 bpm | (not re-reviewed) |
| trance (family) | ✅ → uplifting-trance (silent collapse, M1) | identical to uplifting-trance |


No generator piece failed its own review gate at warn level. Digest bpm/sounds matched the code for both reviewed pieces (amapiano: 112 / cp,gm_epiano1,hh,lt,sine,wt_pluck ✅; gabber: 180 / bd,hh,sawtooth ✅). Generator ↔ critic agreement holds.


---


## Phase 3 round-trip verdict


Ideal shape: context ≤2 → write → review → fix → review → play.
Actual: write (pre-existing) → review (clean) → play. Zero fix iterations. The single-gate claim held — review_pattern replaced validate + critique_pattern + critique_form with one call, and form critique correctly saw the pickRestart energy arc as clean.


No avoidable round-trips. (The song was already in the editor from a prior session; if written from scratch this run, it would have been write → 1 review → play, still inside budget.)


---


## Phase 4 analyzer cross-check


| Signal | review_pattern digest | inspect (16 cyc) | analyze_arrangement (64 cyc) |
|---|---|---|---|
| bpm | 132 ✅ | 132 ✅ | 132 ✅ |
| max voices | 8 | 8 | — |
| sounds | missing gm_epiano1 (H2) | intro+build only: bd,hh,sine,wt_bell,wt_pad | per-section, uses note as a pseudo-instrument name |
| sections | form: clean | — | A–G, but outro shredded (H1); labels are A/B/C not intro/build/drop |
| period | "none detected" | "no repeat within 16" | "no repeat within 64" |


Disagreements that matter:

H1 — arrangement tool invents FG FG for a single outro label.

H2 — digest omits gm_epiano1 that is live for half the song.

analyze_arrangement reports instrument note in drop sections — that's the epiano/pluck notes leaking their pattern type, not a sound name. Confusing in the section table.

---


## Verdict on the new tooling


Did review_pattern cut round-trips? Yes. Phase 3 was 2 calls against an old-world 4–5. Form + mix + silence + validate in one response is the right shape. The "fix warns → re-review once → play" loop is real and short.


Did the silence lint catch what it promised? Yes — all three historical failure modes (unknown sound, unvoiced chord, NaN pan) fire with a named warn and a fix hint. The gm false-positive control stayed clean. This is the highest-confidence part of the stack.


What did it still miss?

Digest incomplete sounds list on multi-section songs (H2).

Form critique doesn't flag a 4-bar phrase looped under 8/16-cycle sections (H3).

No visibility into pickRestart label boundaries inside the digest (W1) — you still reach for analyze_arrangement, which then invents its own labels and over-segments (H1).


---

## Top-3 highest-ROI fixes


### 1. Teach analyze_arrangement (and review's form digest) to read pickRestart labels
API shape: when the AST has "<a b c>".slow(n).pickRestart({…}), emit:

sections:
  intro  cyc 0–7   (from label, length = slow_factor)
  build  cyc 8–15
  …

instead of density-delta A/B/C. Density-delta remains as a fallback for non-pickRestart code. Fixes H1 and enables W1 in one change. Also stop splitting on intentional rest-cycles inside a labelled section.

### 2. Fix the review_pattern digest sounds union
API shape: sounds list = union of every sound/note-sound that emits ≥1 event in the scanned window, including gm_* and section-local instruments. Currently looks like it's sampling a subset of cycles or dropping sounds that only appear mid-form. One-line fix, kills H2, restores trust in the digest.


### 3. Generator width + form-critique loop threshold
Two small coordinated changes:

generate_pattern: auto-apply mild stereo (.jux(rev) on hats, .pan(0.35) on lead/pluck). Kills M3 at source; every generated seed stops carrying a mono note.

form critique: when a melodic/harmonic pattern's intrinsic period * 2 ≤ section length (including summed repeated labels like drop drop), emit [warn] robotic-loop: 4-bar phrase under 16-cycle section — develop the line or shorten the section. Closes H3.


---
