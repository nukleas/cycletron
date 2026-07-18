# Agent tool-exercise prompt

Paste the block below into the AI chat panel to stress-test the composing
tools and produce a ranked friction report. Re-run after tooling changes;
compare against `docs/AGENT_FRICTION.md` to confirm fixes landed.

---

You are running a structured self-test of your tools. Work through the phases
in order. Keep a running FRICTION LOG as you go: every time a tool surprises
you, gives a useless message, misses a problem, or costs an avoidable
round-trip, write down the exact snippet or tool output that shows it. Honest
negatives only — praise is not data. Don't polish any music beyond what each
phase needs.

PHASE 0 — inventory (1 call)
Call list_sounds. Note anything missing, misdocumented, or surprising.

PHASE 1 — trap tests (the silence lint on trial)
Run validate_pattern on each of these EXACTLY as written, one call each, and
record whether the response names the problem and the fix:
  a) s("kicck*4 boom_bap")
  b) chord("<Cm7 FM7>").s("supersaw").gain(0.6)
  c) stack(s("bd*4"), s("hh*8").pan(-0.5))
  d) note("c3 e3 g3").s("gm_epiano1")            ← should NOT warn (gm note only)
  e) s("bd*4".fast(2)                             ← real syntax error; judge the message
Log any trap that passes silently or any clean pattern that false-positives.

PHASE 2 — the genre map
Call generate_pattern (generator "genre") for: amapiano, gabber,
uplifting-trance, one alias of your choice (e.g. "ukg"), and one bare family
name (e.g. "trance"). Then run review_pattern on TWO of the results as-is.
Log: any genre that fails to route, any generated piece that trips its own
review gate (that is a generator bug — quote the warn), and whether the
review's digest matched what the code claims (bpm, sounds).
Play the one you like most.

PHASE 3 — full song through the single gate
Compose a ~2 minute 2-step garage piece: pickRestart form
intro → build → drop → break → drop2 → outro, swung hats, sub bass, chopped
chords. Use review_pattern as your ONLY gate (no separate
validate/critique/critique_form calls). Target the ideal shape:
context (≤2 reads) → write → review → fix warns → review → play.
Log every round-trip beyond that shape and WHY it happened (e.g. section
length math, comma rules, a warn you disagreed with).

PHASE 4 — cross-check the analyzers
On the finished song: inspect_pattern (16 cycles) and analyze_arrangement.
Log any disagreement between analyze_arrangement's sections and your
pickRestart labels, and anything inspect showed that review_pattern's digest
should have surfaced but didn't.

PHASE 5 — the report
Produce the friction report in the same format as your previous one:
  - High friction (silent or hard to diagnose) / Medium (workflow) / Wishlist
  - Every item MUST carry a concrete failing snippet or quoted tool output
  - Tool-call count per phase vs the ideal
  - Verdict on the new tooling: did review_pattern actually cut round-trips?
    Did the silence lint catch what it promised? What did it still miss?
  - Your top-3 highest-ROI fixes, with suggested API shape
Stop after the report. Do not fix the frictions you find.
