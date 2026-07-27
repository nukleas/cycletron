# Sounds & samples — current state + desktop opportunities

Research into how Strudel proper handles instruments/samples vs. how cycletron does today,
and where **desktop power** (Tauri = local filesystem, native decoding, bundling, no CORS)
changes what's possible. Captured 2026-06-05.

Sources: strudel.cc [Samples](https://strudel.cc/learn/samples/),
[Sounds](https://strudel.cc/learn/sounds/); engine source in `../strudel-rs`; cycletron
`ui/` + `docs/STRUDEL_RS_SUPPORTED.md` §5–6.

---

## 1. What cycletron has today

### Synths (15, pure-Rust DSP) — solid
Defined in `../strudel-rs/crates/strudel-dsp/src/lib.rs` (`SynthKind`, ~L266–319), rendered in
`voice.rs::trigger_synth` via `oscillators.rs` / `noise.rs`:

`sine triangle sawtooth square pulse fm supersaw supersquare superpwm superzow white pink
brown crackle sbd`

Good oscillator coverage (anti-aliased PolyBLEP, FM, supersaws, noise, one drum synth `sbd`).
The gap is **melodic/acoustic instruments** — there are no piano/strings/guitar/etc. synths.

### Samples — minimal, HTTP-sourced
- Engine bundles only **bd/sd/hh/cp** `.wav` (`strudel-audio/assets/samples/`, `include_bytes!`).
- cycletron loads **12 drum names on startup** (`bd sd sn hh cp oh ht mt lt cr cb rs`) over
  HTTP from `raw.githubusercontent.com/tidalcycles/Dirt-Samples` — `ui/sample-loader.ts`
  (`loadEssentialDrums`, also `loadTR808`/`loadTR909`), called from `ui/src/app.ts` startup.
- Sample name → sound: `SoundId::classify()` treats any non-synth name as a sample bank;
  missing samples **fall back to a sine** (`engine.rs`). `bd:3` selects a variant by index.

### The transfer pipeline already works (this is the good news)
`fetch → audioContext.decodeAudioData → audioManager.sendSampleBatch → WASM allocAudioSample →
staging buffer → commitBatch` (`ui/audio-manager.ts` ~L406–497). It already carries everything
a real sampler needs per slot: stereo PCM, `sampleRate`, `midiNote`, `loopStart/loopEnd`,
**`keyRangeLow/High` (soundfont zones)**, `baseDetuneCents`. So the hard part — getting decoded
audio into the DSP engine with pitch/loop/zone metadata — is **done**.

### Soundfonts — engine support exists, UI not wired
`../strudel-rs/crates/strudel-soundfont` + `patternhandle.queryMissingBanks()` support SF2/WAF,
but **cycletron never loads the SF2/WAF data** (per DSL doc §6). This is the single biggest
latent capability.

---

## 2. How Strudel proper does it

- **`samples(url)`** loads a `strudel.json` sample map. Format:
  ```json
  {
    "_base": "https://.../Dirt-Samples/master/",
    "bassdrum": "bd/BT0AADA.wav",
    "snaredrum": ["sd/rytm-01-classic.wav", "sd/rytm-00-hard.wav"],   // variants → bd:0, bd:1
    "moog": { "g3": "moog/...G3.wav", "g4": "moog/...G4.wav" }        // pitched: closest note auto-picked
  }
  ```
- **GitHub shorthand**: `samples('github:tidalcycles/dirt-samples')` → expects `strudel.json` at
  repo root (`github:<user>/<repo>/<branch>`, default `main`).
- **Local**: either the REPL's *import-sounds* folder picker (zero-based alphabetical indexing),
  or `npx @strudel/sampler` serving a folder at `localhost:5432` then `samples('http://localhost:5432/')`.
- **Drum machines**: `tidal-drum-machines` provides classic kits; select with `.bank("RolandTR909")`.
- **Soundfonts**: the `@strudel/soundfonts` package registers **thousands of General MIDI
  instruments** into the `s()` namespace, generated from `GeneralUserGS.sf2` / `FluidR3.sf2`.
  This is how web-strudel gets piano, strings, brass, etc.

cycletron's loader already mirrors the `strudel.json` → decode → register flow, so it can
consume the same maps **today** with minimal work.

---

## 3. Desktop power — what Tauri unlocks that the web REPL can't

| # | Opportunity | Why desktop wins | Effort | Status |
|---|-------------|------------------|--------|--------|
| **A** | **Wire the existing soundfont support** — bundle a GM `.sf2` (FluidR3 / GeneralUserGS), load via `queryMissingBanks()` → thousands of melodic instruments in `s()` | Engine support already exists; ship the SF2 in-app → instant, offline, no per-instrument HTTP. **Biggest instrument win.** | Medium | **✅ DONE** — 21 common GM WebAudioFonts bundled in `ui/public/soundfonts/` (offline), CDN fallback for the rest |
| **B** | **Bundle full sample libraries locally** (Dirt-Samples, tidal-drum-machines) as app resources | No CORS, no network, no cold-start latency; works offline. Web REPL must stream from GitHub. | Low–Med | **✅ DONE (2026-06-05)** — default drum kit bundled in `ui/public/samples/`; loaders are offline-first with remote fallback |
| **C** | **Load the user's own sample folders from disk** — Tauri folder picker + recursive scan → build a strudel.json-equivalent map in Rust | No `localhost:5432` server, no upload; direct FS access. A real "point at my drum folder" UX. | Medium | **✅ DONE (2026-06-05)** |
| **D** | **Native Rust audio decoding** (e.g. `symphonia`) for wav/ogg/mp3/flac/aiff in the backend, then hand PCM to the existing `sendSampleBatch` | Broader format support + faster than browser `decodeAudioData`; decode off the audio thread. | Medium | open (still using webview `decodeAudioData`) |
| **E** | **Persistent sample index + agent awareness** — scan/cache a library manifest; expose a `list_sounds` / `search_sounds` tool so the AI knows what instruments exist before it writes `s(...)` | Stops the agent guessing sample names that fall back to sine. Pairs with the corpus work. | Low–Med | **✅ DONE (2026-06-05)** — `list_sounds` agent tool |

### Offline bundling (added 2026-06-05)
Assets are vendored into `ui/public/` and served **same-origin** by the app (Vite in dev; the
embedded `FrontendAssets`/hyper server in prod — `src-tauri/src/lib.rs`), so they work with no
network. The default drum kit (`ui/public/samples/`) and 21 common GM WebAudioFonts
(`ui/public/soundfonts/`, ~6 MB total) are bundled. `ui/sample-loader.ts` is offline-first via
`fetchFirstOk([localUrl, remoteUrl])`: it tries the bundled same-origin path, then falls back to
the CDN for anything not vendored (other GM instruments, TR-808/909 kits). Follow-ups: bundle a
full GM `.sf2` for *all* 128 instruments, and bundle tidal-drum-machines kits.

### Recommended path (highest leverage first)
1. **A — Soundfonts. ✅ DONE (2026-06-05).** Wired General MIDI WebAudioFont loading on demand:
   `ui/scheduler.ts` (`onMissingBanks` + `queryMissingBanks` lookahead) → `ui/src/app.ts`
   (`_loadMissingBanks` reads the missing-GM bitsets) → `ui/sample-loader.ts`
   (`loadWebAudioFont` parses the WAF JS, decodes zones, `sendSampleBatch`) using
   `ui/soundfont-tables.ts` (GM_FONT_FILES / GM_BANK_NAMES). `s("gm_piano")` etc. now stream in
   from the felixroos WebAudioFont CDN on first reference. Ported from strudel-rs www/wasm-repl;
   the engine's key-zone pipeline was already built. NOTE: still **CDN-streamed**, not yet
   bundled locally — the desktop-power follow-up is to ship the WAF/SF2 data as app resources
   (offline + instant) and/or decode natively in Rust.
2. **B — Bundle a drum library.** Ship Dirt-Samples (or Clean-Samples, licence-safe) + a couple
   of `tidal-drum-machines` kits as Tauri resources; switch `sample-loader.ts` to load from the
   bundled path instead of `raw.githubusercontent`. Offline + instant.
3. **E — Tell the agent what exists.** A `list_sounds` tool (synth names + loaded sample banks +
   SF2 instruments) so AI `s(...)` choices land on real sounds, not the sine fallback.
4. **C/D — User folders + native decode.** The "pro" desktop feature: folder picker → Rust scan
   → `symphonia` decode → register. Do after the bundled wins prove the pipeline.

### Watch-outs
- **Licensing/size**: Dirt-Samples is large and mixed-licence; Clean-Samples is the
  redistribution-safe set (see `_references/02`). A full GM SF2 (FluidR3 ~140MB; smaller GM SF2s
  exist) affects bundle size — consider an on-first-run download vs. bundling.
- **`.bank()` support**: confirm whether strudel-rs's DSL accepts `.bank("…")`; if not, banks are
  selected purely by the loaded sample name. (Check against `docs/STRUDEL_RS_SUPPORTED.md`.)
- **Soundfont crate API**: confirm exactly what `strudel-soundfont` + `queryMissingBanks()` expect
  (SF2 bytes? a parsed zone list?) before wiring — that determines whether decoding is Rust-side
  or JS-side.
