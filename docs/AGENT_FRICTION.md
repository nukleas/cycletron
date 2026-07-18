# Agent friction report — triage

Field reports from the in-app composing agent, triaged into what's fixed,
what's queued, and what belongs in strudel-rs.

## Round 3 — self-test rerun (2026-07-13, `run2.md`)

Scorecard: 5/5 traps caught, 0 false positives, single-gate held (phase 3 in
2 calls), generator↔critic agreement confirmed. New findings, all fixed:

| Finding | Fix |
| --- | --- |
| H2 digest drops gm_epiano1 — **root cause: strudel-rs `with_structure` discarded hap context**, so `.s(…)` before `.struct(…)` lost its sound in the digest AND at playback (every struct'd chord has been playing the default synth) | Engine fix in `strudel-core::Pattern::with_structure` (preserve `value_hap.context`); regression tests in both repos; **WASM rebuilt** so the app's audio path is fixed too. |
| H1 analyze_arrangement shreds labelled sections on density flicker | `analyze_code` now uses pickRestart labels × `.slow(n)` as ground truth (consecutive repeats merge, sections named by label); density lettering only as fallback. |
| H3 form critique missed a 4-bar phrase looped 4× under a 16-cycle section | robotic-loop now computes the phrase's intrinsic period per section and warns when it repeats ≥4× (2 repeats = music, 4 = robot). |
| H4/W2 inspect_pattern dumps every onset | `verbosity` param: auto (events ≤4 cycles, summary beyond), summary = facts + run-length per-cycle counts. |
| W1 no section→label view in review | review_pattern prints a `== form map ==` table (label, cycle range, density, instruments) for pickRestart/arrange code. |
| M1/M2 family/alias routing silently collapses | generate_pattern prepends `// routed 'trance' → uplifting-trance; the map also has: …`. |
| M3 every generated piece trips the mono note | genres.rs helpers add default stereo (chords .pan(0.42), leads .pan(0.62); bass/drums centre); corpus regenerated, 151/151. |
| M4 semitone-clash on phrygian gabber | Accepted — note-severity, genre-intent is unknowable; leave as is. |
| M5 effects not discoverable via list_sounds | Backlog — needs a list_methods/effects inventory sourced from the supported-surface doc. |
| M6 caret good, recovery hint generic | Accepted for now — hint heuristics risk misleading; caret + span considered enough. |

## Round 2 — tooling self-test (2026-07-13, `friction.md`)

The structured self-test (docs/AGENT_TOOL_TEST.md) scored the round-1 fixes:
4/5 traps caught; review_pattern cut the gate chain (22 vs ~21 ideal calls)
but the bundled critiques false-positived. All three of its top-ROI fixes
shipped same day:

| Report finding | Fix |
| --- | --- |
| Trap (b): unvoiced `chord()` missed — symbol hides in the event *value*, not the sound | `lint_source`: `chord(` count > `.voicing(` count → warn. Test = the literal trap. |
| Form critique invented density-based sections, ignored pickRestart labels (18-line off-grid spam) | `critique_form_code` rebuilt: labels × `.slow(n)` are ground truth (consecutive repeats merge); density segmentation only without pickRestart; findings deduped. Missing `.slow(n)` is now its own single first-class warn — the original footgun. |
| Clipping over-counted chord tones (4-note pad ≈ "8 voices ~2.6") | Same-instant events sharing (sound, gain) group as one source at g·√n, and drum transients weight 0.5× (a kick+clap+hat backbeat isn't three held saws); >3.0 = warn, 2.0–3.0 = `hot-mix` note. |
| Syntax error position opaque ("at 16..16") | validate renders the offending line with a caret. |
| list_sounds vs prompt drift (wt_sine/tri/square/saw) | Prompt wavetable list updated. |
| Digest missed gm_epiano1 from later sections | **Cannot reproduce** — `digest_sees_sounds_from_later_sections` proves later-section sounds surface. Likely the song's epiano layer genuinely never fired (i.e. the digest caught a real dead layer). Re-check with the failing song if it recurs. |
| genre_recipe covers 9 genres vs generator's 64 | Backlog: genre-map Phase 3 (recipe per spec). |
| generate_pattern should self-gate (amapiano/gabber tripped clipping) | Enforced by test: `generated_pieces_pass_their_own_clipping_gate` composes amapiano/gabber/uplifting-trance/house and asserts no clipping warn — the generator↔critic contract can't silently regress. |

## Fixed (2026-07-12)

| # | Friction | Fix |
| --- | --- | --- |
| 1 | Silent failures (invented sounds, unvoiced chords, bad pan) pass validation | **Silence lint** in `validate_pattern` + `review_pattern`: unknown `s()` names vs the live sound catalog (with suggestions), chord-symbol-as-sound → `.voicing()` hint, pan outside 0..1 (negative = NaN = silence). `src-tauri/src/strudel.rs::lint_digest`. |
| 9 | gm_* first-cycle silence confuses inspection | Lint emits a `gm-first-cycle` note when cycle 0 is silent and `gm_*` sounds are present: "judge from cycle 1 onward". |
| 10 | Tool round-trip tax (validate → critique → critique_form) | **`review_pattern`** — one call = validate + digest summary + silence lint + mix critique + form critique (when `pickRestart`/`arrange` present) + verdict. Workflow guidance in `prompts/system.md` updated to prefer it. |

## Already documented, kept sharp (prompt gotchas)

- #2 `pickRestart` needs `.slow(n)` on the selector — documented + critique_form flags it.
- #3 comma rules (`,` parallel only in `[]`; forbidden in `<>`) — documented with examples.
- #4 arrow params must be unparenthesized (`x => …`) — documented.
- #5 no `.bank()`, no drum aliases (`rs` not `rim`) — documented + list_sounds says so.
- #12 euclid rotation must be literal — documented with the `<bd(3,8) bd(3,8,1)>` expansion idiom.

The lint now catches the *silent* subset of these mechanically, so a slip under
time pressure surfaces at the gate instead of by ear.

## strudel-rs engine backlog (sibling repo — not yet started)

Ranked by the agent's own ROI ordering:

1. **First-class section length on `pickRestart`** (bars or seconds) so the
   `.slow(n)` mental math disappears. The #2 highest-ROI ask.
2. **`.bank("RolandTR808")`** prefixing instead of `Machine_voice` names.
3. **Patternable euclid rotation** — `bd(3,8,<0 1 2>)`.
4. **Tempo map / mid-song BPM** (`setbpm` is global today).
5. **Bus/group effects** — one reverb send per stack instead of per-event
   `.room()` on every layer; a master trim for gain budgeting (#7).

## Workflow observations worth keeping

- `critique_form` + an explicit FORM plan before `pickRestart` keeps the energy
  arc honest — reinforce in corpus examples.
- `analyze_arrangement` mis-segments on instrumentation flicker (#8); for
  pickRestart songs the selector labels are ground truth. critique_form already
  prefers labels; leave the analyzer as the raw table.
- Multi-bar `[...]` groups inside `<>` are the right idiom for melodic
  development under long sections (#6) — corpus examples added 2026-06 cover
  this; keep growing them.
