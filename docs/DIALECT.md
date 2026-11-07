# Cycletron dialect (strudel-rs)

Patterns in Cycletron run on **strudel-rs**, not the browser Strudel (strudel.cc) runtime.
Nearly all of web Strudel's mini-notation and pattern API works unchanged, so the upstream
docs are a fine place to learn. This page lists what differs on the pinned engine and what
fails silently. For the full supported surface see
[STRUDEL_RS_SUPPORTED.md](./STRUDEL_RS_SUPPORTED.md).

Items marked *engine* are strudel-rs limitations, not design. They go away as the engine
catches up; the list shrinks with each engine bump.

---

## Differences from web Strudel

### Commas inside `< >` don't stack (engine)

Upstream, `<a b, c d>` plays both groups as alternating stacks. Here each comma group
becomes its own slot, so nothing plays together.

```strudel
// good
note("<c2 g2 a2 f2>")
note("<[c3,e3,g3] [f3,a3,c4]>")
s("bd, sd")

// plays one note per cycle instead of two together
note("<c2, g2>")
```

### `.scale()` needs a root (engine)

Upstream defaults the tonic to C. Here a bare mode name does nothing, without an error.
Scale only quantizes **numeric** degrees, not note names like `c4`.

```strudel
// good
note("0 2 4 5 7").scale("C4:minor")

// silent no-op
note("0 2 4 5 7").scale("minor")
```

### Euclid and `..` arguments are literals (engine)

```strudel
// good
s("bd(3,8,1)")
s("<bd(3,8) bd(3,8,1) bd(3,8,2)>")

// rejected
s("bd(<3 5>,8)")
s("bd(3,8,<0 2>)")
```

### Some methods take a number, not a pattern (engine)

Controls (`lpf`, `gain`, `pan`, `n`, …) and `fast`/`slow`/`ply`/`late`/`early` take patterns,
as upstream. These take a plain number here: `every`, `lastOf`, `sometimesBy`, `degradeBy`,
`euclid`, `iter`, `chunk`, `hurry`, `linger`, `segment`, `striate`, `chop`, `swingBy`,
`add`, `sub`, `mul`, `div`, `range`, `off`.

```strudel
// good
note("0 2 4").add(12)
s("bd sd").every(2, x => x.fast(2))

// rejected: "1st argument must be a number"
note("0 2 4").add("<0 12>")
s("bd sd").every("<2 3>", x => x.fast(2))
```

### `vowel` takes numbers (engine)

`0`=a `1`=e `2`=i `3`=o `4`=u. Upstream letters (`vowel("a e")`) are dropped silently.

### Not available

- `choose`, `chooseCycles`, `wchoose`: use `randcat`, `wrandcat` or `pick`.
- `loopAt`, `fit`, `slice`, `splice`, `scrub`: use `chop`, `striate`, `bite`, `speed`.
- `stepcat`/`timeCat`: use `arrange([bars, pat], …)` or `@` weights.
- `chord` as a method after `n(...)`: use `chord("…").voicing()` and `arp`.
- `all(...)`, `samples(...)`, `$drums:` named tracks (use `$:` and `_$:`), free-standing
  arrow helpers, `"a b".s()` string-literal methods, `setcps` (use `setbpm`/`setcpm`).
- Controls: `postgain`, `freq`, `accelerate`, `nudge`, `octave`, `djf`, `compressor`,
  `unison`/`spread`, the `lfo`/`warp`/`wt` families. Short envelope aliases `lpa lpd lps lpr`
  and `fmatt fmdec fmsus fmrel`: use `lpattack`, `fmattack`, etc.

## Silent, not an error

These validate and play nothing, or the wrong thing. `validate_pattern` warns on the first two.

| Code | What happens |
| --- | --- |
| `.pan(-0.3)`, `.pan(sine.range(-0.3, 0.3))` | Pan is 0..1 (same as upstream, which clamps). Here out-of-range is NaN and the event is silent. |
| `chord("Cm7").s("piano")` | Same as upstream: without `.voicing()` the symbol is only a tag. |
| `.scale("minor")` | No root, no effect. |
| `.vowel("a")` | Letters dropped. |
| `note("c e".add(12))` | The `.add` on a bare string is ignored. |
| `.cpm(90)` in a chain | Sets the **song** tempo (same as `setcpm`), does not speed up that pattern. |

## Same as web Strudel

Things often listed as Cycletron quirks that are not:

- Pan is 0..1 with 0.5 centre, upstream too.
- `chord(...)` needs `.voicing()` to become notes, upstream too.
- `|` (random choice) works inside `[ ]` and `{ }`, not inside `< >`. Upstream's grammar
  rejects it there as well.
- `setbpm(120);` has parentheses because it is JavaScript. `setbpm` itself is a Cycletron
  extra (upstream has `setcpm`, `setcps`).
- `cat` is slowcat, `seq` is fastcat.
- A `< >` slot lasts one cycle. Sections get their length from `@n` weights, from
  `.slow(n)` on the selector, or from `arrange()`. Cycletron's form tools (`cycletron check`, the
  agent's arrangement review) read the `"<a@2 b@2>".slow(n).pickRestart({…})` shape, so
  that is the house convention, not an engine rule. Rough guide at 140 BPM: `.slow(4)` ≈ 7s
  per slot, `.slow(8)` ≈ 14s, `.slow(16)` ≈ 27s.

---

## Quick self-check

If something is silent or errors on eval:

1. Pan range, scale root, vowel numbers.
2. Commas inside `< >`.
3. A pattern where this engine wants a number (see above).
4. Ask the AI to run **validate_pattern**, or validate from the agent tools.
5. Help → Show Logs for the exact parser message.
