# Cycletron dialect (strudel-rs)

Patterns in Cycletron run on **strudel-rs**, not the browser Strudel (strudel.cc)
runtime. Most mini-notation is compatible; these differences cause the most
silent or broken output.

For the full supported surface see [STRUDEL_RS_SUPPORTED.md](./STRUDEL_RS_SUPPORTED.md).

---

## Critical rules

### 1. Pan is 0…1 (not −1…1)

`0` = full left, `0.5` = center, `1` = full right.  
Negative pan → NaN in the panner → **complete silence**.

```strudel
// good
.pan(0.3)
.pan(sine.range(0.2, 0.8))

// bad — silent
.pan(-0.3)
.pan(sine.range(-0.3, 0.3))
```

### 2. `chord()` needs `.voicing()`

Without `.voicing()`, the chord symbol is treated like a sample name → silence.

```strudel
// good
chord("<Cm7 FM7>").voicing().s("supersaw")

// bad — often silent
chord("<Cm7 FM7>").s("supersaw")
```

### 3. `.scale()` needs `"root:mode"`

```strudel
// good
note("0 2 4 5 7").scale("C4:minor")

// bad — no-op
note("0 2 4 5 7").scale("minor")
```

Scale only quantizes **numeric** degrees, not absolute names like `c4`.

### 4. `pickRestart` needs `.slow(n)` on the selector

Without `.slow()`, each section lasts **one cycle** (~1–2s at dance tempos).

```strudel
// good — ~8 cycles per section
"<intro chorus drop>".slow(8).pickRestart({
  intro: s("bd*4"),
  chorus: s("bd*4, hh*8"),
  drop: s("bd*4, ~ cp ~ cp, hh*8"),
})

// bad — sections flash by
"<intro chorus drop>".pickRestart({ ... })
```

Rough guide at 140 BPM: `.slow(4)` ≈ 7s, `.slow(8)` ≈ 14s, `.slow(16)` ≈ 27s.

### 5. Commas inside `< >` don't stack — they split slots

Spaces separate items in slowcat. Commas stack **only** inside `[ ]` / `{ }`
or at the top level of a mini-notation string. Inside `< >` a comma still
*parses*, but it means something else entirely: each comma-separated group
becomes one alternating slot, so nothing plays together.

```strudel
// good
note("<c2 g2 a2 f2>")
note("<[c3,e3,g3] [f3,a3,c4]>")
s("bd, sd")

// bad — parses, but each note becomes its own slot instead of stacking
note("<c2, g2, a2, f2>")
note("<[c3,e3,g3], [f3,a3,c4]>")
```

### 6. Random choice `|` only inside `[ ]` or `{ }`

```strudel
// good
s("[bd | sd]")

// bad
s("<bd | sd>")
```

### 7. Tempo and syntax hygiene

- Prefer `setbpm(120);` with parentheses and a semicolon.
- Prefer **double quotes** for mini-notation, though `'…'` and `` `…` `` also parse.
- `.bank("RolandTR808")` works for the built-in machine kits (RolandTR808/909/707,
  LinnDrum, BossDR55); only arbitrary *custom* sample banks are unsupported.
- Euclid rotation must be a **literal** number: `bd(3,8,1)` not a nested pattern.

---

## Quick self-check

If something is silent or errors on eval:

1. Check pan, voicing, and scale format first.
2. Check commas inside `< >`.
3. Ask the AI to run **validate_pattern**, or validate from the agent tools.
4. Help → Show Logs for the exact parser message.
