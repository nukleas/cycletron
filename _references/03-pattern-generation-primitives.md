# Pattern-generation primitives — inventory & mapping

The single biggest extractable asset from the live-coding world for an *AI-first* engine is
a vetted catalog of **algorithmic-composition functions**. Two libraries (both well-documented)
are near-complete inventories. Below they're mapped onto Cycletron's six corpus categories
(`rhythm, melody, harmony, form, timbre, motion`) so they can become: (a) AI tools, (b) corpus
generators, and/or (c) DSL methods.

---

## A. total-serialism (JS) — tmhglnd.github.io/total-serialism

A compact, gettable function set. Categories below; **[cat]** = best-fit corpus bucket.

### Generative
- `spread()` / `spreadInclusive()` — evenly distributed values between bounds. **[melody/motion]**
- `fill()` — array filled with repeated values. **[rhythm]**
- `sine()` / `cosine()` — sampled sine/cosine periods (great as LFO-ish value series). **[motion]**
- `binary()` — number → binary array (rhythm from integers). **[rhythm]**
- `space()` — onset patterns from spacing. **[rhythm]**

### Algorithmic
- `euclid()` — Euclidean rhythms (Cycletron likely has this already — confirm parity). **[rhythm]**
- `hexBeat()` — rhythm from a hex string (e.g. `"a4"` → beats). Terse + powerful. **[rhythm]**
- `fibonacci()`, `pisano()` — Fibonacci & Pisano-period sequences. **[melody/form]**
- `collatz()` — Collatz sequence as a melodic/rhythmic contour. **[melody]**
- `infinity()` — **Per Nørgård's infinity series**, an endlessly self-similar melody. **[melody]**
- `Automaton` — elementary cellular automaton (Wolfram rules) → evolving patterns. **[motion/rhythm]**

### Stochastic
- `random()`, `coin()`, `die()` — uniform random / binary / range. **[any]**
- `urn()` — sampling without replacement (no repeats until exhausted). **[melody/rhythm]**
- `MarkovChain` / `DeepMarkov` — transition-probability sequence generation (n-order). **[any — see doc 04]**
- `clave()` — binary clave rhythm patterns. **[rhythm]**

### Transform
- `reverse()`, `retrograde()`, `inverse()`, `transpose()` — classic serial transforms. **[melody/harmony]**
- `duplicate()`, `interleave()`, `palindrome()`, `lace()` — structural manipulation. **[form]**
- `lookup()` — map indices through a lookup table. **[any]**

### Translate / tonal
- `noteToMidi()` / `midiToNote()` / `midiToFreq()` / `freqToMidi()` — conversions.
- `relativeToMidi()` — relative-semitone notation → MIDI.
- `chordsFromNumerals()` — **Roman-numeral progression → chords**. **[harmony]**
- `Scala` — import `.scl` tuning files (microtonal). **[harmony/timbre]**

### Statistic / utility
- `average()`, `mode()`, `deviation()`, `compare()` — analyze generated material.
- `add/subtract/multiply/divide()` — elementwise math on value arrays.
- `draw()` — ASCII-art visualization of binary patterns (nice for agent explanations).

---

## B. isobar (Python) — github.com/ideoforms/isobar

A lazy "pattern algebra" — patterns compose with operators. The *composability* model is as
interesting as the individual classes.

- **Sequence**: `PSeries` (arithmetic), `PGeom` (geometric), `PLoop`, `PPingPong`,
  `PStutter`, `PEuclidean`, `PArpeggiator`.
- **Stochastic**: `PWhite` (uniform), `PBrown` (brownian/random walk — smooth drift),
  `PCoin`, `PChoice` (weighted), `PShuffle`.
- **Tonal**: `PDegree` (scale degree → MIDI), `PFilterByKey`, `PMidiNoteToFrequency`.
- **Advanced**: `PMarkov` (1st-order chain), `PLSystem` (Lindenmayer rewriting),
  `PFadeNotewise`, `PWInterpolate` / `PWSine` (temporal warping / accel-decel).
- **Operators**: patterns support `+ - * / // % **`, comparisons, bit-shifts — so generated
  material is *algebraic* and reusable. **This is the key idea**: a small set of generators
  plus operators yields huge variety.
- **Scalar transforms**: `PScaleLinLin`/`PScaleLinExp` (range mapping), `PWrap` (fold into
  range), `PDiff`, `PChanged`, `PMap`.

---

## C. Mercury — design philosophy to imitate (tmhglnd/mercury)

Mercury is the *style* guide for AI-generated, audience-legible code:

- **Semantic clarity over symbolic density** — clear descriptive names, lowercase commands,
  no bracket/semicolon overhead. Cycletron's AI output should read like prose.
- **30-line visible-performance limit** — a strong prior for keeping generated patterns short
  and comprehensible (good corpus-curation heuristic).
- **Declarative `set` / `new` / `list` core** — global state, sound declarations, and named
  sequences as three simple primitives.
- **Inline probability** — numeric lists with decimals (`[1 0 0.5]`) bake chance into
  notation. Worth checking whether strudel-rs mini-notation has an equivalent (`?` degrade
  exists — see DSL doc §"Degradation").
- **Fluid fx chains** — `fx(reverb 0.3 15) fx(drive 10)` read left-to-right.

---

## How this maps to Cycletron

Three ways to land these:

1. **As agent tools / corpus generators (lowest risk, highest leverage).** Implement the
   pure-function ones in Rust (they're tiny: euclid, hexBeat, infinity series, collatz,
   markov, cellular automaton, weighted choice, brownian walk, numeral→chord). Expose them to
   the agent and/or run them offline to *grow the curated corpus* under each category. They
   produce value arrays → trivially lowered to strudel mini-notation `note("…")`.

2. **As DSL methods (higher effort).** Only if strudel-rs upstream wants them; otherwise keep
   them in Cycletron's generation layer so `validate_code` stays the contract.

3. **As corpus tags.** Tag curated `.strudel` files by the technique used (euclidean,
   markov, serial-transform, numeral-progression…) so `search_corpus` can retrieve by
   *method*, not just category — sharpening the AI's few-shot grounding.

**Suggested first batch** (cheap, broadly useful, one per corpus category):
`euclid`/`hexBeat` (rhythm) · Per Nørgård `infinity` (melody) · `chordsFromNumerals`
(harmony) · `palindrome`/`interleave` (form) · `Scala`/microtonal (timbre) ·
`brown`/cellular `Automaton` (motion).
