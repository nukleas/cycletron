# strudel-rs Supported DSL Surface

Ground truth for what the strudel-rs parser+evaluator accepts. Verified against
`../strudel-rs/` source (not web-strudel docs — they diverge). Anything not
listed here is **not guaranteed to work**.

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
| `setcpm(N);` | Cycles per minute. `cps = cpm / 60`. |
| `setcps(N);` | Cycles per second, raw. |
| `hush` | Silence everything. |

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
| `,` | `[bd, sd, hh]` | Stack (parallel) — inside `[ ]` or `{ }`. |
| `*N` | `bd*4` | Repeat N times in the slot (speed up). |
| `/N` | `bd/2` | Slow by N (one event every N cycles). |
| `@N` | `bd@2 sd` | Weighted slot — `bd` gets 2 units of time, `sd` gets 1. |
| `_` | `bd _ _ sd` | Shorthand weight: extends the previous element by +1 unit. |
| `!N` | `bd!3` | Replicate event N times in-place. |
| `?` / `?P` | `bd?` `bd?0.3` | Degrade — 50% drop by default, or probability P. |
| `:N` | `bd:2` | Sample variant index (2nd sample in the `bd` bank). |
| `..` | `0 .. 7` | Numeric range expansion → `0 1 2 3 4 5 6 7`. |
| `(p,s)` / `(p,s,r)` | `bd(3,8)` `bd(3,8,2)` | Bjorklund / Euclidean: `p` pulses over `s` steps, optional rotation `r`. |
| `\|` | `bd \| sd \| cp` | Random choice per cycle (seeded → deterministic). **Only at the top level of `[ ]` / `{ }`; not allowed inside `< >`.** |
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

### Combinators (variadic)

| Function | Aliases | Semantics |
| --- | --- | --- |
| `fastcat(...)` | `cat`, `sequence`, `seq` | Concatenate, one cycle total. |
| `slowcat(...)` | `cat` (in some contexts) | One pattern per cycle. |
| `stack(...)` | `polyrhythm` | Play patterns simultaneously. |
| `polymeter(...)` | `pm` | Stack with LCM step alignment. |

> Note: the alias `cat` overlaps between `fastcat` and `slowcat` in the source.
> Prefer the explicit `fastcat` / `slowcat` to avoid ambiguity.

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
| `irand(n)` | Integer random in `[0, n)`. |
| `run(n)` | Integer ramp `0..n` across the cycle. |

These are most useful piped into a control with `.range(lo, hi)` or
`.rangex(lo, hi)`.

## 4. Pattern methods

All chainable. Verified from `pattern.rs` (`#[strudel_method]` attributes).
Aliases inside `()`.

### Time / sequencing

`fast(n)`, `slow(n)`, `early(t)`, `late(t)`, `zoom(s, e)`, `rev`, `palindrome`,
`linger(t)`, `repeat_cycles(n)`, `replicate(n)`, `ply(n)`, `inside(n, fn)`,
`outside(n, fn)`, `within(start, end, fn)`, `chop(n)`, `segment(rate)` (`seg`).

### Conditionals

`every(n, fn)` (`firstOf`), `last_of(n, fn)`, `when(cond, fn)`, `always(fn)`,
`never`, `sometimes(fn)`, `sometimes_by(prob, fn)`, `often(fn)`, `rarely(fn)`,
`almost_always(fn)`, `almost_never(fn)`.

### Degradation

`degrade`, `degrade_by(prob)`, `mask(pat)`.

### Stereo & layering

`jux(fn)`, `jux_by(amount, fn)`, `off(time, fn)`, `superimpose(fn, ...)` (`sup`),
`layer(fn, ...)`, `tail(other)`.

### Structure

`with_structure(pat)` (mini-notation name: `struct`), `euclid(p, s, [rot])`
(`euclidRot`, `bjork`), `euclid_legato(p, s)`, `euclid_legato_rot(p, s, r)`.

### Selection / picking

All camelCase aliases are the **canonical** form when used from mini-notation
chains.

`pick(...)`, `pickmod(...)`, `pickOut(...)`, `pickmodOut(...)`,
`pickRestart(...)`, `pickmodRestart(...)`, `pickReset(...)`,
`pickmodReset(...)`, `inhabit(...)` (`pickSqueeze`),
`inhabitmod(...)` (`pickmodSqueeze`), `pickF(...)`, `pickmodF(...)`.

### Notes / pitch / scale

`note(pat)` (`n`), `sound(pat)` (`s`), `transpose(n)` (`trans`),
`scale_transpose(n)` (`scaleTrans`, `strans`), `scale("name")`,
`root_notes(octave)`, `voicing()`, `voicings(dict)`, `chord(pat)`,
`dictionary(name)` (`dict`), `unit(name)`.

### Math on values

`add(n)`, `sub(n)`, `mul(n)`, `div(n)`, `range(lo, hi)`, `rangex(lo, hi)`
(exponential), `range2(lo, hi)` (legacy alias of `range`).

### Stutter / echo

`stut(times, feedback, time)`, `stut_with(times, time, fn)` (`echoWith`),
`echo(times, time, feedback)`.

### ADSR envelope (note)

`attack(t)` (`att`), `decay(t)` (`dec`), `sustain(level)` (`sus`),
`release(t)` (`rel`), `duration(t)` (`dur`).

### Amplitude / panning

`gain(v)`, `amp(v)`, `velocity(v)` (`vel`), `pan(v)`.

### Low-pass filter

`cutoff(hz)` (`lpf`, `lp`), `resonance(q)` (`lpq`, `q`),
`lpenv(amount)` (`lpe`), `lpattack(t)` (`lpatt`), `lpdecay(t)` (`lpdec`),
`lpsustain(level)` (`lpsus`), `lprelease(t)` (`lprel`).

### High-pass filter

`hpf(hz)` (`hp`), `hresonance(q)` (`hpq`),
`hpenv(amount)` (`hpe`), `hpattack(t)` (`hpatt`), `hpdecay(t)` (`hpdec`),
`hpsustain(level)` (`hpsus`), `hprelease(t)` (`hprel`).

### Band-pass filter

`bpf(hz)` (`bp`), `bandq(q)` (`bpq`),
`bpenv(amount)` (`bpe`), `bpattack(t)` (`bpatt`), `bpdecay(t)` (`bpdec`),
`bpsustain(level)` (`bpsus`), `bprelease(t)` (`bprel`).

### Pitch envelope

`penv(amount)` (`pe`), `pattack(t)` (`patt`), `pdecay(t)` (`pdec`),
`psustain(level)` (`psus`), `prelease(t)` (`prel`).

### Delay

`delay(amount)`, `delaytime(t)` (`delayt`),
`delayfeedback(amount)` (`delayfb`).

### Reverb / room

`room(amount)`, `roomsize(size)` (`size`).

### Distortion & shaping

`dist(amount)` (`distort`, `distortion`), `shape(amount)`, `crush(bits)`,
`coarse(n)`, `clip(threshold)`.

### Pitch modulation / FM

`fmindex(v)` (`fmi`, `fm`), `fmratio(v)` (`fmh`),
`vib(rate)` (`vibrato`), `vibmod(depth)` (`vmod`),
`tremolo(rate)` (`trem`), `tremolodepth(depth)` (`tremdepth`),
`tremoloshape(s)` (`tremshape`), `detune(cents)` (`det`).

### Chorus

`chorus(depth)` (`choruspeed(rate)`) — short modulated delay (LFO depth 0–1,
rate in Hz). Depth also controls wet/dry mix. Alias: pass both together with
colon notation `chorus("0.5:1.2")`.

### Vowel filter

`vowel(v)` — three parallel bandpass filters approximating vocal formants.
`v` is 0=A, 1=E, 2=I, 3=O, 4=U (or a pattern cycling through them).

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

### Sample playback

`speed(v)`, `begin(0..1)`, `end(0..1)` (canonical name is `end`,
also reachable as `sample_end`), `cut(group)`, `bank(name)`, `loop_at(v)`,
`orbit(v)`, `duration(v)` (`dur`).

### Ducking / sidechain

`duck(v)`, `duckatt(t)` (`duckattack`), `duckdepth(v)`,
`duckons(v)` (`duckonset`), `duckrel(t)` (`duckrelease`), `duckorbit(v)`.

### Metadata (no audio effect)

`color(hex)`, `anchor(pos)`, `unit(name)`, `add_control(...)`,
`add_context(...)`, `set_context(...)`, `strip_context()`,
`filter_haps(fn)`, `filter_values(fn)`, `onsets_only()`,
`discrete_only()`.

### Per-pattern tempo

`bpm(n)`, `cpm(n)` — local tempo overrides on a pattern.

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
the Dirt-Samples drum kit (`bd sd sn hh cp oh ht mt lt cr cb rs` — see
`ui/sample-loader.ts`). Additional banks load on demand from the configured
URL. Sample indices select variants: `bd:3` picks the 4th sample in the bd
bank. Names are case-insensitive.

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
CDN fallback), so other GM instruments and the TR-808/909 kits still stream from
the network when referenced.

**Local sample folders (desktop):** users can load their own samples from disk
via the command palette → "Load Sample Folder…" (`ui/src/app.ts`
`loadSampleFolder` → Rust `scan_sample_folder` + `read_audio_file` in
`src-tauri/src/sounds.rs`). Each subfolder becomes a bank `s("<folder>")` (files
indexed alphabetically, `<folder>:1` etc.); loose audio files become one-shot
banks named after the file stem. Bank names are sanitized to ≤31 bytes. Loaded
bank names are reported to the agent via the `list_sounds` tool.

## 7. Notes, scales, chords

- Note names: `c`, `c#`, `db`, `cb`, `c##`, `cbb`, … with optional octave
  (`c3`, default `c4`). Numeric MIDI also accepted: `note("60 64 67")`.
- `chord("Cm7")` / `chord("F:maj7")` expands to constituent pitches.
- `scale("c minor")`, `scale("dorian")`, `scale("major pentatonic")` quantise
  numeric note values into the given scale.
- `transpose(n)` shifts in semitones; `scale_transpose(n)` shifts in scale
  degrees.

## 8. Gotchas the parser will reject

Common JS-strudel idioms that **don't** survive the strudel-rs parser:

- `setbpm 120` (no parens) — must be `setbpm(120);` with parens and a semicolon.
- `<a | b | c>` — `|` (random choice) doesn't compose inside `< >` slowcat
  brackets. Use space-separated `<a b c>` for per-cycle alternation, or move
  the choice outside the angle brackets.
- `bd(3,8,<0 1 2>)` — the Euclidean rotation argument must be a static number;
  a pattern there is rejected. Slowcat pre-rotated variants instead:
  `<bd(3,8) bd(3,8,1) bd(3,8,2)>`.
- Single-quoted strings (`'...'`) and template literals (`` `...` ``) — only
  double quotes work for mini-notation strings.
- Arrow functions with parens (`(x) => x.fast(2)`) — the DSL parser accepts
  the bare form `x => x.fast(2)` but not the parenthesised one.

## 9. Known gaps vs. web-strudel

Things that exist in JS-strudel but **don't** in strudel-rs (per source
inspection — re-check when upgrading):

- No inline JavaScript / arbitrary expressions inside patterns.
- No `$:` track / labelled section syntax.
- Spectral effects not implemented.
- No MIDI input (MIDI **file** parsing exists via `midi-to-strudel`).
- Sample registry is host-driven; the engine doesn't fetch samples itself.

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
