# strudel-rs Supported DSL Surface

Ground truth for what the strudel-rs parser+evaluator accepts. Verified against
the strudel-rs source at the rev the workspace `Cargo.toml` pins (not web-strudel
docs — they diverge, and not whatever checkout happens to be on disk). Anything
not listed here is **not guaranteed to work**. `strudel-dsl names` prints every
name the pinned engine dispatches; diff it against this file when bumping.

Source-of-truth files (jump here when something is ambiguous):

- Lexer / tokens: `crates/strudel-mini/src/lexer.rs`
- Mini-notation parser: `crates/strudel-mini/src/parser.rs`
- Mini-notation evaluator: `crates/strudel-mini/src/evaluator.rs`
- Pattern methods: `crates/strudel-core/src/pattern.rs` (every `#[strudel_method]`)
- Free functions / combinators: `crates/strudel-core/src/combinators.rs` (every `#[strudel_function]`)
- Synth registry: `crates/strudel-sounds/src/synths.rs`
- Sample registry / aliases: `crates/strudel-sounds/src/aliases.rs`
- Tempo conversion: `crates/strudel-dsl/src/file_parser.rs`
- Dispatch macro: `crates/strudel-macros/src/lib.rs` (auto-generates the name→fn table)

## 1. File-level directives

Top-of-file only. Strudel-rs parses these as commands, not pattern expressions.
**Syntax is function-call form with a trailing semicolon** — `setbpm(120);`
NOT `setbpm 120`.

| Directive | Effect |
| --- | --- |
| `setbpm(N);` | Beats per minute. Conversion: `cps = bpm / 240`. Assumes 4 beats per cycle. |
| `setcpm(N);` | Cycles per minute. `cps = cpm / 60`. Same as web Strudel. |
| `hush` | Silence everything. |

`setcps(...)` is **not** accepted by the pinned engine (it lands in a later strudel-rs).
`setbpm` is a Cycletron extra; web Strudel only has `setcpm`/`setcps`. A `.bpm(n)` or
`.cpm(n)` call on a pattern chain sets the **song** tempo too (same effect as the
directive), it does not scale that one pattern the way web Strudel's `.cpm()` does.

For multi-track `.strudel` files, prefix each track with `$:`:

```
setbpm(120);
$: stack(s("bd*4"), s("~ sd ~ sd"))
$: note("c4 e4 g4").s("sine")
```

For single-pattern files, the directive plus a plain DSL expression works too:

```
setbpm(120);
stack(s("bd*4"), s("~ sd ~ sd"))
```

BPM is also published via `getCurrentBpmPtr()` so the host can read it after each
`parsePattern` (see `ui/src/app.ts` for the JS side).

## 2. Mini-notation operators

Inside `"..."` strings. The lexer is `crates/strudel-mini/src/lexer.rs`.

| Op | Example | Semantics |
| --- | --- | --- |
| (space) | `bd sd hh` | Fastcat — events distributed evenly over the cycle. |
| `[ ]` | `bd [sd cp]` | Subdivide a slot. Inner cycle compressed to fit. |
| `< >` | `<bd sd cp>` | Slowcat — one element per cycle. |
| `{ }` | `{bd sd, hh cp}` | Polymeter — comma-separated patterns aligned by step count. |
| `{ } % N` | `{bd sd hh}%4` | Polymeter with explicit step count. |
| `,` | `[bd, sd, hh]` | Stack (parallel) — inside `[ ]` or `{ }` or at the top level. **Inside `< >` this engine splits the groups into alternating slots instead of stacking them** (web Strudel stacks; engine fix tracked). |
| `*N` | `bd*4` | Repeat N times in the slot (speed up). |
| `/N` | `bd/2` | Slow by N (one event every N cycles). |
| `@N` | `bd@2 sd` | Weighted slot — `bd` gets 2 units of time, `sd` gets 1. |
| `_` | `bd _ _ sd` | Shorthand weight: extends the previous element by +1 unit. |
| `!N` | `bd!3` | Replicate event N times in-place. |
| `?` / `?P` | `bd?` `bd?0.3` | Degrade — 50% drop by default, or probability P. |
| `:N` | `bd:2` | Sample variant index (2nd sample in the `bd` bank). |
| `..` | `0 .. 7` | Numeric range expansion → `0 1 2 3 4 5 6 7`. Bounds must be literal numbers on this engine. |
| `(p,s)` / `(p,s,r)` | `bd(3,8)` `bd(3,8,2)` | Bjorklund / Euclidean: `p` pulses over `s` steps, optional rotation `r`. All three must be literal numbers on this engine (web Strudel takes patterns). |
| `\|` | `bd \| sd \| cp` | Random choice per cycle (seeded → deterministic). **Only inside `[ ]` / `{ }` or at the top level; not inside `< >`** (same as web Strudel's grammar). |
| `.` | `bd sd . hh cp` | "Feet" — split cycle into equal-time chunks per `.`-segment. |
| `^` | `bd^ sd` | Step-count marker for polymeter alignment. |
| `~` or `-` | `bd ~ sd ~` | Rest / silence. |
| `"..."` `'...'` | `"c3 e3"` | Quoted sub-pattern. Both quote styles work. |

Atoms match the regex `[a-zA-Z][a-zA-Z0-9_#.^~-]*` or `[0-9]+[a-zA-Z]...` —
so `808bd`, `c#3`, `bd_kick` are all legal atoms.

**Reserved keywords inside mini-notation** (lexer tokens): `setcps`, `setbpm`,
`hush`, `slow`, `fast`, `scale`, `struct`, `target`, `euclid`, `rotL`, `rotR`,
`cat`. Don't use them as sample names.

## 3. Free functions (top-level)

From `combinators.rs` and the bottom of `pattern.rs`. Call these without a
receiver.

### Pattern constructors

| Function | Aliases | Returns / notes |
| --- | --- | --- |
| `pure(value)` | — | One event per cycle holding `value`. |
| `silence()` | `hush` | Empty pattern. |
| `note(pat)` | `n` | Reinterpret values as MIDI notes. |
| `sound(pat)` | `s` | Reinterpret values as sound names. |
| `chord(pat)` | — | Expand chord symbols (e.g. `"Cm7"` → constituent notes). |
| `mini(str)` | `m` | Parse a string as mini-notation (rarely needed; string literals already parse). |
| `binary(n)` | — | The bits of `n` as a `1 0 …` sequence, one cycle. |
| `binaryN(n, bits)` | — | Same, padded or cut to `bits` steps. |

### Combinators (variadic)

| Function | Aliases | Semantics |
| --- | --- | --- |
| `fastcat(...)` | `sequence`, `seq` | Concatenate, one cycle total. |
| `slowcat(...)` | `cat` | One pattern per cycle. `cat` is slowcat here as in web Strudel. |
| `randcat(...)` | — | One of the patterns per cycle, chosen at random (seeded). |
| `wrandcat([pat, weight], …)` | — | Weighted `randcat`. |
| `stack(...)` | `polyrhythm` | Play patterns simultaneously. |
| `polymeter(...)` | `pm` | Stack with LCM step alignment. |
| `arrange(...)` | — | Section combinator: `arrange([bars, pat], …)` plays each pattern for `bars` cycles at its native rate, then loops. |

### Continuous signal generators (0..1)

All return a `Pattern<f64>` that varies continuously across the cycle.

| Function | Shape |
| --- | --- |
| `sine`, `sine2` | Sine, single / double-frequency. |
| `cosine` | Cosine. |
| `saw`, `saw2`, `isaw` | Sawtooth ramps; `isaw` = inverted. |
| `tri`, `tri2` | Triangle. |
| `square`, `square2` | Square wave. |
| `rand` | Uniform random 0..1, deterministic per cycle. |
| `perlin` | Smooth 0..1 noise across cycles. |
| `irand(n)` | Integer random in `[0, n)`. |
| `run(n)` | Integer ramp `0..n` across the cycle. |

These are most useful piped into a control with `.range(lo, hi)` or
`.rangex(lo, hi)`.

## 4. Pattern methods

All chainable. Verified from `pattern.rs` (`#[strudel_method]` attributes).
Aliases inside `()`.

### Time / sequencing

`fast(n)`, `slow(n)`, `hurry(n)`, `early(t)`, `late(t)`, `zoom(s, e)`, `rev`,
`palindrome`, `linger(t)`, `repeatCycles(n)`, `replicate(n)`, `ply(n)`,
`inside(n, fn)`, `outside(n, fn)`, `within(start, end, fn)`, `chop(n)`,
`segment(rate)` (`seg`).

| Method | Behaviour |
|--------|-----------|
| `hurry(n)` | `fast(n)` plus a matching sample-speed change. |
| `ribbon(offset, cycles)` (`rib`) | Loop the window of that many cycles starting at offset, for as long as the pattern plays. Fractional lengths work. |
| `beat(positions, div)` | Place the source at the given slots of a cycle divided into div: `beat("0 4", 8)`. Positions wrap modulo div; div is a plain number. |
| `press` | Push every event into the second half of its own span. |
| `pressBy(r)` | Shift each event r of the way into its span (r may be a pattern). 0 is identity; outside 0–1 is silence. |
| `iter(n)` / `iterBack(n)` | Each cycle, start the pattern one `n`th later (or earlier). |
| `chunk(n, fn)` / `chunkBack(n, fn)` / `fastChunk(n, fn)` | Apply `fn` to one `n`th of the cycle, moving to the next chunk each cycle (backwards / every chunk per cycle). |
| `swingBy(x, n)` / `swing(n)` | Delay every second of `n` subdivisions by `x` (swing uses a third). |
| `brak` | Every other cycle, squash the pattern into half a cycle and shift it a quarter later (breakbeat feel). |
| `shuffle(n)` / `scramble(n)` | Cut the cycle into `n` slices and play them in random order (shuffle: each once; scramble: with repeats). |
| `striate(n)` | Play the `n`th slice of every sample, moving through the slices across the cycle. |
| `bite(n, "idx")` | Cut the cycle into `n` slices and sequence them by the index pattern: `bite(4, "0 2 1 3")`. |

### Patterned arguments

Controls (`lpf`, `gain`, `pan`, `n`, `speed`, …) take a pattern or a signal everywhere, as in
web Strudel, and so do `fast`, `slow`, `ply`, `late`, `early`, `pressBy` and pickRestart
selectors. For the other time and conditional methods this engine is stricter and wants a
plain number: every, lastOf, sometimesBy, degradeBy, euclid, iter, chunk, hurry, linger,
segment, striate, chop, swingBy, add, sub, mul, div, range, off.

`s("bd sd").every("<2 3>", …)` or `.add("<0 12>")` is rejected with "1st argument must be
a number". The next strudel-rs lifts this for `add`, `mul`, `off`, `segment`, `range`; the
rest are tracked.

### Stepwise

Arguments are plain numbers, not patterns (no `stepcat` in this port yet).
`fast` and `hurry` preserve step counts; `striate` multiplies them.

| Method | Behaviour |
|--------|-----------|
| `pace(steps)` | Refit the pattern to that many steps per cycle. Identity when the pattern carries no step count. |
| `expand(factor)` | Multiply the step count without moving events. Audible only once `pace` reads it back. |
| `contract(factor)` | Divide the step count; see `expand`. |

### Conditionals

`every(n, fn)` (`firstOf`), `lastOf(n, fn)`, `when(cond, fn)`, `always(fn)`,
`never`, `sometimes(fn)`, `sometimesBy(prob, fn)`, `often(fn)`, `rarely(fn)`,
`almostAlways(fn)`, `almostNever(fn)`, `someCycles(fn)`, `someCyclesBy(prob, fn)`
(whole cycles instead of single events).

### Degradation

`degrade`, `degradeBy(prob)`, `mask(pat)`.

### Stereo & layering

`jux(fn)`, `juxBy(amount, fn)`, `off(time, fn)`, `superimpose(fn, ...)` (`sup`),
`layer(fn, ...)`.

### Structure

`struct(pat)` (method + mini-notation name), `euclid(p, s, [rot])`
(`euclidRot`, `bjork`), `euclidLegato(p, s)`, `euclidLegatoRot(p, s, r)`.

### Selection / picking

All camelCase aliases are the **canonical** form when used from mini-notation
chains.

`pick(...)`, `pickmod(...)`, `pickOut(...)`, `pickmodOut(...)`,
`pickRestart(...)`, `pickmodRestart(...)`, `pickReset(...)`,
`pickmodReset(...)`, `inhabit(...)` (`pickSqueeze`),
`inhabitmod(...)` (`pickmodSqueeze`), `pickF(...)`, `pickmodF(...)`.

### Notes / pitch / scale

| Method | Behaviour |
|--------|-----------|
| `arp(pat)` | Arpeggiate each chord. pat is an index pattern (`arp("0 2 1 3")`, rebased per chord) or a Tidal ordering name: up, down, updown, downup, up&down, down&up, converge, diverge, disconverge, pinkyup, pinkyupdown, thumbup, thumbupdown. Names and indices mix in one pattern; an unknown name is silence, not a fallback to up. |

`note(pat)` (`n`), `sound(pat)` (`s`), `transpose(n)` (`trans`),
`scaleTranspose(n)` (`scaleTrans`, `strans`), `scale("name")`,
`rootNotes(octave)`, `voicing()`, `voicings(dict)`, `chord(pat)`,
`dictionary(name)` (`dict`), `unit(name)`.

### Math on values

`add(n)`, `sub(n)`, `mul(n)`, `div(n)`, `range(lo, hi)`, `rangex(lo, hi)`
(exponential), `range2(lo, hi)` (legacy alias of `range`).

### Stutter / echo

`stut(times, feedback, time)`, `stutWith(times, time, fn)` (`echoWith`),
`echo(times, time, feedback)`.

### ADSR envelope (note)

`attack(t)` (`att`), `decay(t)` (`dec`), `sustain(level)` (`sus`),
`release(t)` (`rel`), `duration(t)` (`dur`), `adsr(a, d, s, r)`.

### Amplitude / panning

`gain(v)`, `amp(v)`, `velocity(v)` (`vel`), `pan(v)`.

### Low-pass filter

`cutoff(hz)` (`lpf`, `lp`, `ctf`), `resonance(q)` (`lpq`),
`lpenv(amount)` (`lpe`), `lpattack(t)` (`lpatt`), `lpdecay(t)` (`lpdec`),
`lpsustain(level)` (`lpsus`), `lprelease(t)` (`lprel`).

### High-pass filter

`hpf(hz)` (`hp`, `hcutoff`), `hresonance(q)` (`hpq`),
`hpenv(amount)` (`hpe`), `hpattack(t)` (`hpatt`), `hpdecay(t)` (`hpdec`),
`hpsustain(level)` (`hpsus`), `hprelease(t)` (`hprel`).

### Band-pass filter

`bpf(hz)` (`bp`, `bandf`), `bandq(q)` (`bpq`),
`bpenv(amount)` (`bpe`), `bpattack(t)` (`bpatt`), `bpdecay(t)` (`bpdec`),
`bpsustain(level)` (`bpsus`), `bprelease(t)` (`bprel`).

### Pitch envelope

`penv(amount)` (`pe`), `pattack(t)` (`patt`), `pdecay(t)` (`pdec`),
`psustain(level)` (`psus`), `prelease(t)` (`prel`).

### Delay

`delay(amount)`, `delaytime(t)` (`delayt`, `dt`),
`delayfeedback(amount)` (`delayfb`, `dfb`). Colon form: `delay(".5:.125:.6")` sets all three.

### Reverb / room

`room(amount)`, `roomsize(size)` (`size`, `sz`, `rsize`), `roomdamp(amount)` (`verbdamp`).
Colon form: `room(".5:.9")` sets amount and size.

### Distortion & shaping

`dist(amount)` (`distort`, `distortion`), `shape(amount)`, `crush(bits)`,
`coarse(n)`, `clip(multiplier)` (`legato`).

**`dist` and `shape` are mutually exclusive.** The voice setup is
`if dist {…} else if shape {…}` — set both and `shape` is silently ignored.
`dist(x)` → drive `x + 1`; `shape(s)` → drive `(1+s)/(1-s)`. Distortion then
applies an output trim of `1/(1 + 0.3·(drive − 1))`, so heavier drive is
*quieter*; compensate with `gain`, which is not clamped. `dist` also selects the
curve via colon notation — `dist("2:1:2")` is drive 3.0 on hard clip (0 S-curve,
1 tanh, 2 hard, 3 cubic, 4 diode, 5 asym, 6 foldback, 7 sine-fold, 8 Chebyshev);
the middle slot (`distortvol`) is a no-op placeholder.

**`clip` is NOT a clipper** — despite the name it is a note-length multiplier
(`duration × clip`), the same control as `legato`. Use `shape`/`dist` to
saturate.

### Pitch modulation / FM

`fmindex(v)` (`fmi`, `fm`), `fmratio(v)` (`fmh`),
`fmattack(t)` (`fma`), `fmdecay(t)` (`fmd`), `fmsustain(level)` (`fms`),
`fmrelease(t)` (`fmr`), `fmenv(amount)` (`fme`),
`vib(rate)` (`vibrato`), `vibmod(depth)` (`vmod`),
`tremolo(rate)` (`trem`), `tremolodepth(depth)` (`tremdepth`),
`tremoloshape(s)` (`tremshape`), `detune(semitones)` (`det`; the engine scales by 2^(v/12), so 0.12 is 12 cents).

### Pulse width / PWM

| Method | Behaviour |
|--------|-----------|
| `width(v)` (`pw`) | Pulse width 0–1. Setting it on a plain sine / tri / saw / square voice promotes it to a pulse oscillator. Colon form `pw("0.3:2:0.4")` sets width, rate and depth at once. |
| `pwmrate(hz)` (`pwrate`, `pwr`) | Rate of the pulse-width LFO. |
| `pwmdepth(v)` (`pwsweep`, `pws`) | Depth of the pulse-width LFO. |

### Phaser

| Method | Behaviour |
|--------|-----------|
| `phaser(hz)` (`phaserrate`, `ph`) | Sweep a notch through the signal. Rate alone engages it with a default depth. |
| `phaserdepth(v)` (`phd`, `phasdp`) | How far the notch travels. |

### Chorus

`chorus(depth)` (`choruspeed(rate)`) — short modulated delay (LFO depth 0–1,
rate in Hz). Depth also controls wet/dry mix. Alias: pass both together with
colon notation `chorus("0.5:1.2")`.

### Vowel filter

`vowel(v)` — three parallel bandpass filters approximating vocal formants.
`v` is 0=A, 1=E, 2=I, 3=O, 4=U (or a pattern cycling through them). **Numbers only:** web
Strudel's `vowel("a e i")` letters are dropped without an error on this engine.

### Granular synthesis

`grainsize(ms)` (`grain`) — activates granular playback of a sample. Each note
spawns a cloud of up to 8 overlapping grains windowed with a Hann envelope.
- `scatter(0..1)` — position scatter around `begin` (default 0.5).
- Colon shorthand: `grainsize("100:0.5")` sets size + scatter in one call.
- `begin` sets the cloud centre. `speed` controls grain playback rate.

Works on any `s("...")` sample trigger. Synth voices are unaffected.

### Impulse-response reverb

`ir(v)` — applies a short convolution reverb using a pre-baked impulse
response. `v` selects the character: 0=small room, 1=hall, 2=plate.
Applied as an **insert** (per-voice), not a send. Use alongside or instead of
`room()`. The IRs are 512-sample synthetic responses baked at build time.

### Effect quick-list (chainable)

Compact index of the timbre/space effects above (see subsections for detail):
`vowel(v)`, `grainsize(ms)` (`grain`), `scatter(v)`, `ir(v)`, `adsr(a, d, s, r)`,
`roomdamp(amount)` (`verbdamp`), `ctf(hz)`, `chorus(depth)` (`choruspeed`),
`width(v)` (`pw`), `pwmrate(hz)`, `pwmdepth(v)`, `phaser(hz)`, `phaserdepth(v)`.

### Sample playback

`speed(v)`, `begin(0..1)` (`sampleBegin`), `end(0..1)` (`sampleEnd`), `cut(group)`,
`bank(name)`, `loop(v)`, `orbit(v)` (`o`), `duration(v)` (`dur`).

### Ducking / sidechain

`duck(v)`, `duckatt(t)` (`duckattack`, `datt`), `duckdepth(v)`,
`duckons(v)` (`duckonset`), `duckorbit(v)`. There is no duck release control.

### Metadata (no audio effect)

`color(hex)` (`colour`), `anchor(pos)`, `unit(name)`. Web Strudel's visualiser calls
`pianoroll`, `punchcard`, `scope`, `spiral`, `log` are accepted as no-ops so pasted code
validates.

(Note: add_context, add_control, set_context, strip_context, filter_haps,
filter_values, onsets_only, discrete_only are Rust-only Pattern API — they are
**not** registered as DSL methods and cannot be called from a .strudel chain.)

### Tempo from a chain

`bpm(n)`, `cpm(n)` — set the song tempo from inside a chain (see §1). Not a per-pattern
speed change.

## 5. Synth names (the `s("…")` registry)

From `crates/strudel-sounds/src/synths.rs`. Pass to `s(...)` / `.sound(...)`.

| Name(s) | Type |
| --- | --- |
| `sine`, `sin` | Sine oscillator |
| `triangle`, `tri` | Triangle oscillator |
| `sawtooth`, `saw` | Sawtooth oscillator |
| `square`, `sq` | Square oscillator |
| `pulse` | Variable-width pulse (`width` 0..1) |
| `fm` | 2-op FM (`fmindex`, `fmratio`) |
| `supersaw` | Detuned saw stack |
| `supersquare` | Detuned square stack |
| `superpwm` | Detuned pulse-width-modulation stack |
| `superzow` | Detuned "zow" saw/square hybrid stack |
| `white`, `noise` | White noise |
| `pink` | Pink noise |
| `brown`, `red` | Brown noise |
| `crackle` | Granular crackle |
| `sbd` | Subtractive bass-drum synth |
| `wt_sine` | Wavetable — pure sine |
| `wt_tri` | Wavetable — triangle (odd harmonics) |
| `wt_square` | Wavetable — square wave |
| `wt_saw` | Wavetable — sawtooth |
| `wt_flute` | Wavetable — flute timbre |
| `wt_clarinet` | Wavetable — clarinet timbre |
| `wt_oboe` | Wavetable — oboe timbre |
| `wt_violin` | Wavetable — violin timbre |
| `wt_cello` | Wavetable — cello timbre |
| `wt_trumpet` | Wavetable — trumpet timbre |
| `wt_bassoon` | Wavetable — bassoon timbre |
| `wt_organ` | Wavetable — pipe organ |
| `wt_piano` | Wavetable — piano timbre |
| `wt_bell` | Wavetable — bell / metallic |
| `wt_pluck` | Wavetable — plucked string |
| `wt_bass` | Wavetable — electric bass |
| `wt_lead` | Wavetable — synth lead |
| `wt_pad` | Wavetable — warm pad |
| `wt_choir` | Wavetable — choir / vocal |
| `wt_strings` | Wavetable — string ensemble |

## 6. Samples

`s("bd")` / `s("sd")` etc. resolve to sample banks. The Cycletron UI ships
a default drum kit (`bd sd sn hh cp oh ht mt lt cr cb rs rim rd sh tb brk cl ma lc mc hc` —
see `ui/sample-tables.ts`). `bd`/`sd`/`hh`/`oh`/`cr`/toms/congas are multi-variant
(`hh:2`, `bd:4`); `rim` is the same bank as `rs`. Plus a curated percussion/texture
pack (`perc click metal east hand industrial space arpy tabla jvbass`), melodic/speech
expansion banks (`flbass uke cpluck cbow speech`), a bundled VCSL slice — note-mapped
instruments `kalimba marimba vibraphone glockenspiel tubularbells harp ocarina
recorder_alto_sus balafon harmonica steinway strumstick psaltery_pluck dantranh`
(`note("c4 e4").s("kalimba")` plays in tune from the nearest recorded note) and indexed
percussion `gong timpani didgeridoo bongo shaker_small tambourine agogo guiro sleighbells
triangles framedrum darbuka` — and the five drum machine kits.
Additional banks load on demand from the configured URL. Sample indices select
variants: `bd:3` / `flbass:2` pick the Nth sample in that bank. Names are case-insensitive.

`.bank(name)` **is supported** and rewrites every sample name in the pattern to
`{Bank}_{sound}`: `s("bd sd").bank("RolandTR808")` == `s("RolandTR808_bd
RolandTR808_sd")` — the two forms are interchangeable, and `name` may itself be a
pattern (`.bank("<RolandTR808 RolandTR909>")` alternates per cycle). It only
affects samples (no-ops on synths / GM). **Caveat:** a voice the chosen kit lacks
resolves to nothing and plays silent — e.g. LinnDrum has no `cr`, so
`s("bd cr").bank("LinnDrum")` drops the crash. Keep such accents on the default
kit, or pick a machine that has the voice.

Soundfont / WebAudioFont support exists in `crates/strudel-soundfont` and is
wired through `patternhandle.queryMissingBanks()`. **This is wired up in
Cycletron**: the scheduler scans a lookahead window for missing banks
(`ui/scheduler.ts` `onMissingBanks`), and General MIDI instruments referenced
as `s("gm_piano")`, `s("gm_violin")`, etc. stream in on demand from the
WebAudioFont CDN (`ui/sample-loader.ts` `loadWebAudioFont`, driven by
`ui/src/app.ts` `_loadMissingBanks` + `ui/soundfont-tables.ts`). The first
cycle that references an instrument may be silent while its soundfont loads.
Custom `strudel.json` sample-map banks are **not yet** wired (GM only for now).

**Offline bundling:** the default drum kit and ~21 common GM instruments are
vendored into `ui/public/{samples,soundfonts}/` and served same-origin, so they
load with no network. `ui/sample-loader.ts` is offline-first (bundled path →
CDN fallback), so other GM instruments and the DR-55 kit still stream from the
network when referenced.

**Local sample folders (desktop):** users install their own samples as a pack
(command palette → "Install Sample Pack…"; `src-tauri/src/packs.rs` +
`src-tauri/src/sounds.rs` `scan_folder_banks`). Each subfolder becomes a bank
`s("<folder>")` with files indexed in natural order (`<folder>:1` etc.); loose
audio at the root is grouped by filename convention — `BD-…`/`SNARE-…` become
`bd`/`snare`, falling back to one indexed bank when no convention is present.
Bank names are sanitized to ≤31 bytes, and names colliding with the core kit are
suffixed with the pack id. Loaded bank names reach the agent via `list_sounds`.

## 7. Notes, scales, chords

- Note names: `c`, `c#`, `db`, `cb`, `c##`, `cbb`, … with optional octave
  (`c3`, default `c4`). Numeric MIDI also accepted: `note("60 64 67")`.
- `chord("Cm7")` / `chord("F:maj7")` carries the chord symbol; add `.voicing()`
  to expand it to pitches (see DIALECT.md — without it the symbol is treated
  as a sample name).
- `scale("C4:minor")`, `scale("D4:dorian")`, `scale("E3:major pentatonic")`
  quantise numeric note values into the given scale. The `root:mode` form is
  mandatory — a bare mode name like `scale("minor")` fails to parse and is
  ignored.
- `transpose(n)` shifts in semitones; `scale_transpose(n)` shifts in scale
  degrees.

## 8. Gotchas the parser will reject

Common JS-strudel idioms that **don't** survive the strudel-rs parser:

- `setbpm 120` (no parens) — must be `setbpm(120);` with parens and a semicolon.
- `<a | b | c>` — `|` (random choice) doesn't compose inside `< >` slowcat
  brackets, here or in web Strudel. Use space-separated `<a b c>` for per-cycle
  alternation, or move the choice outside the angle brackets.
- `bd(3,8,<0 1 2>)` — the Euclidean arguments must be static numbers;
  a pattern there is rejected. Slowcat pre-rotated variants instead:
  `<bd(3,8) bd(3,8,1) bd(3,8,2)>`.
- `note("<c2, g2>")` — a comma inside `< >` splits the groups into alternating slots
  instead of stacking them. Write `note("<[c2,g2] …>")` or use `stack()`.
- `.scale("minor")` — no root, no effect (web Strudel defaults to C). Write
  `.scale("C4:minor")`.
- `.every("<2 3>", fn)`, `.degradeBy("<.2 .8>")`, `.add("<0 12>")` — these take a plain
  number here; see "Patterned arguments" in §4.
- `.vowel("a")` — letters are dropped; use `0..4`.
- `setcps(0.5);` — not accepted; use `setcpm` or `setbpm`.

(Both arrow forms — bare `x => x.fast(2)` and parenthesised `(x) => x.fast(2)` —
now parse and behave identically; the parens are no longer rejected. Verified by
`engine_contract`.)

(Single-quoted `'...'` and backtick `` `...` `` strings **do** parse on the
current engine — double quotes are still the convention, but the other two are
not rejected.)

## 9. Known gaps vs. web-strudel

Most of web Strudel's mini-notation and pattern API works unchanged. What does not, on
the pinned engine (re-check when bumping):

- **Mini-notation:** comma inside `< >` splits instead of stacking; Euclid and `..`
  arguments must be literals.
- **Methods that only take numbers** where web Strudel takes patterns: see §4
  "Patterned arguments".
- **Missing functions:** `choose`, `chooseCycles`, `wchoose` (use `randcat` /
  `wrandcat` / `pick`); `loopAt`, `fit`, `slice`, `splice`, `scrub` (use `chop`,
  `striate`, `bite`, `speed`); `stepcat`/`timeCat` (use `arrange` or `@` weights);
  `squeeze`, `xfade`, `undegradeBy`, `invert`; `chord` as a method
  (`n("0 2").chord("…").voicing()`), use `chord("…").voicing()` with `arp`; `all()`
  across `$:` tracks.
- **Missing controls:** `postgain`, `freq`, `accelerate`, `nudge`, `octave`, `djf`,
  `compressor`, `unison`/`spread`, `noise`, the `lfo`/`warp`/`wt` families, the midi/osc
  controls. Short envelope aliases `lpa lpd lps lpr` (and hp/bp) and `fmatt fmdec fmsus
  fmrel` are missing; the long forms work.
- **`vowel`** takes `0..4`, not letters.
- **JavaScript:** `const x = …` bindings, arithmetic in arguments, arrow callbacks and
  `$:`/`_$:` tracks work. Free-standing arrow helpers (`const f = p => …; f(pat)`),
  `"a b".s()` string-literal methods and named tracks (`$drums:`) are rejected.
  No `samples(...)`: sample banks come from the library and the bundled kits.
- Spectral effects, MIDI input: not implemented.
- `.bank(...)` **is** supported for the bundled drum-machine kits (RolandTR808/909/707/606/727,
  LinnDrum, BossDR55), see §6; custom `strudel.json` banks aren't wired yet.

Out-of-range or malformed values that web Strudel clamps or rejects can be **silent**
here: pan outside 0..1, `scale` without a root, `vowel` letters, a `.add()` on a bare
string. `validate_pattern` warns on the first; the rest are listed in `docs/DIALECT.md`.

## 10. Validation contract

Cycletron ships two validators driven by the same logic:

- `validate_pattern` IPC tool (used by the agent and the editor) →
  `src-tauri/src/strudel.rs::validate_code`.
- `cargo run -p corpus-check` CLI gate → `tools/corpus-check/main.rs`.

Both run the candidate through `parse_strudel_file → evaluate_file`, then
`eval_dsl_with_tempo`, then `strudel_mini::parse + evaluate`, surfacing the
last error if all paths fail. The CLI additionally asserts the pattern emits
at least one event in cycle 0 (catches silent patterns). Anything that
round-trips both is by definition supported.
