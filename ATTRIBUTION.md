# Attribution — bundled third-party assets

Cycletron itself is licensed AGPL-3.0-or-later (see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE)). The audio assets vendored under `ui/public/` come from
third parties and keep their own licenses. Verbatim copies of every upstream
license/provenance text ship in [`licenses/`](licenses/).

## Default drum kit — `ui/public/samples/{bd,sd,sn,hh,cp,oh,ht,mt,lt,cr,cb,rs,cl,ma,lc,mc,hc,rd,rim,sh,tb,brk}/`

**Roland TR-808 sample set** recorded by **Michael Fischer (Technopolis, 1994)**
directly from a TR-808 (serial no. 103852) — see
[`licenses/TR808-Fischer-README.txt`](licenses/TR808-Fischer-README.txt).

- Source: https://github.com/tidalcycles/sounds-tr808-fischer
- License: **CC0-1.0** ([`licenses/TR808-Fischer-LICENSE.txt`](licenses/TR808-Fischer-LICENSE.txt)).
  Fischer's own note says the set is "ABSOLUTELY FREE"; the explicit CC0
  dedication was applied by the TidalCycles project when republishing.
- Every knob take is bundled. `s("bd")` is the original middle-tune/middle-decay
  hit; `s("bd:1")`… walk the rest of the 25 bass drums. Same pattern for
  `sd` (25), `cr` (25), `oh` (5), toms (5 each), and congas `lc`/`mc`/`hc`.
  Extra 808 voices: `cl` (claves), `ma` (maracas). Fischer's closed hat is a
  single file (`hh` index 0).

**uzu-drumkit** (Unlicense) supplies the voices Fischer cannot:
hats `hh:1`–`hh:5`, ride `rd`, extra rims on `rs`/`rim`, shaker `sh`,
tambourine `tb`, and amen-style `brk`.

- Source: https://github.com/tidalcycles/uzu-drumkit
- License: **Unlicense** ([`licenses/uzu-drumkit-LICENSE.txt`](licenses/uzu-drumkit-LICENSE.txt)).
- `rim` is registered as the same bank as `rs` (Fischer rimshot + two uzu rims).

## Percussion & texture colors — `ui/public/samples/{perc,click,metal,east,hand,industrial,space,arpy,tabla,jvbass}/`

**Versilian Community Sample Library (VCSL)** by Versilian Studios LLC and
contributors — **CC0** ([`licenses/VCSL-LICENSE.txt`](licenses/VCSL-LICENSE.txt)).

- Source: https://github.com/sgossner/VCSL
- The bundled copies are peak-normalized to −4 dB (and `space`/`jvbass`
  trimmed for one-shot use); the original recordings are upstream.

| Bank | VCSL instrument |
|---|---|
| `perc` | Cajon |
| `click` | Claves |
| `metal` | Anvil |
| `east` | Woodblock |
| `hand` | Conga |
| `industrial` | Brake Drum |
| `space` | Wine Glasses (sustain, trimmed) |
| `arpy` | Yamaha TX81Z — Clavisynth |
| `tabla` | Darbuka |
| `jvbass` | Yamaha TX81Z — FM Piano (low C, trimmed) |

## VCSL instruments — `ui/public/samples/{kalimba,marimba,vibraphone,glockenspiel,tubularbells,harp,ocarina,recorder_alto_sus,balafon,harmonica,steinway,strumstick,psaltery_pluck,dantranh,gong,timpani,didgeridoo,bongo,shaker_small,tambourine,agogo,guiro,sleighbells,triangles,framedrum,darbuka}/`

**Versilian Community Sample Library (VCSL)** by Versilian Studios LLC and
contributors — **CC0** ([`licenses/VCSL-LICENSE.txt`](licenses/VCSL-LICENSE.txt)).

- Source: https://github.com/sgossner/VCSL — the exact upstream recording
  behind every bundled file is listed in `ui/scripts/vcsl-sources.json`.
- 125 recordings, one velocity layer each, 5–10 notes per pitched
  instrument: trimmed to 4–8 s, faded, peak-normalised to −4 dB, downmixed to
  mono and MP3-encoded by `ui/scripts/vendor-vcsl.mjs` (3.7 MB in total).
  The full library, with every note and dynamic, is the downloadable `vcsl`
  sample set.

## Melodic & speech expansion — `ui/public/samples/{flbass,uke,cpluck,cbow,speech}/`

Short **CC0** slices from the Tidal [Clean-Samples](https://github.com/tidalcycles/Clean-Samples)
ecosystem. Bundled copies are mono 16-bit peak-normalized to −4 dB (same prep
as the VCSL color banks). Multi-variant: `s("flbass")`, `s("flbass:2")`, …

| Bank | Source | License text |
|---|---|---|
| `flbass` | [cleary/samples-flbass](https://github.com/cleary/samples-flbass) — fretless bass (finger/pick/palm shorts) | [`licenses/flbass-LICENSE.txt`](licenses/flbass-LICENSE.txt) |
| `uke` | [thgrund/samples-ukulele](https://github.com/thgrund/samples-ukulele) — Ortega Lizard uke | [`licenses/uke-LICENSE.txt`](licenses/uke-LICENSE.txt) |
| `cpluck` | [cleary/samples-cello-plucked](https://github.com/cleary/samples-cello-plucked) — plucked cello + body hit (Trevor Exter) | [`licenses/cpluck-LICENSE.txt`](licenses/cpluck-LICENSE.txt) |
| `cbow` | [cleary/samples-cello-bowed](https://github.com/cleary/samples-cello-bowed) — bowed cello shorts (Trevor Exter) | [`licenses/cbow-LICENSE.txt`](licenses/cbow-LICENSE.txt) |
| `speech` | [tidalcycles/sounds-repetition](https://github.com/tidalcycles/sounds-repetition) — synth-speech “repetition” chops (Alex McLean) | [`licenses/speech-LICENSE.txt`](licenses/speech-LICENSE.txt) |

These are **unpitched one-shots** (rhythm/timbre/ad-lib use). For chromatically
in-tune melodies prefer `gm_*` soundfonts or `wt_*` wavetables.

## Drum machines — `ui/public/machines/`

- **TR-808** (`RolandTR808_*`): Michael Fischer's CC0 set, as above.
- **TR-707** (`RolandTR707_*`): the 1990s hyperreal-archive sample set,
  distributed with an explicit public-domain note
  ([`licenses/TR707-README.txt`](licenses/TR707-README.txt)); obtained via
  https://github.com/fluid-music/open-drums.
- **LinnDrum** (`LinnDrum_*`): **BushDrum** by EwonRael — samples of an
  original LinnDrum LM-2, **CC0**
  ([`licenses/BushDrum-LICENSE.txt`](licenses/BushDrum-LICENSE.txt)).
  Source: https://github.com/EwonRael/BushDrum
- **TR-909 and Boss DR-55 are not bundled.** No cleanly licensed sample set of
  these machines is available, so Cycletron streams them at runtime from the
  upstream community collection
  (https://github.com/geikha/tidal-drum-machines, no stated license) and never
  redistributes the files. Offline, these two kits are unavailable.

## Soundfonts (General MIDI) — `ui/public/soundfonts/`

- **Fluid (R3) SoundFont** — Copyright © 2000-2002, 2008 **Frank Wen**.
  Released under the **MIT license**; Frank Wen's copyright notice and the MIT
  text are reproduced in [`licenses/FluidR3_GM.txt`](licenses/FluidR3_GM.txt).
  Bundled as WebAudioFont-format renderings (MP3/JS mechanical conversion ©
  2017 Sergey Surikov, MIT) from https://github.com/surikov/webaudiofontdata.
- **GeneralUser GS** by **S. Christian Collins** — *streamed at runtime only,
  not bundled*. Used under the GeneralUser GS License v2.0, which permits use
  in software projects and commercial use of music made with it.
  https://www.schristiancollins.com/generaluser.php

Only FluidR3_GM and GeneralUser GS variants are referenced by
`ui/soundfont-tables.ts`; both permit redistribution and end-user commercial
music.

## Linux AppImage: bundled GStreamer

The Linux AppImage bundles the GStreamer runtime and plugin set from Ubuntu
22.04 (via Tauri's `bundleMediaFramework`) so WebKitGTK can output audio on
any distro. These are unmodified LGPL/GPL binaries; their source is available
from the corresponding Ubuntu packages (packages.ubuntu.com). The plugin list
for each release is printed in the release workflow's `fix-appimage` job; the
GPL-incompatible "ugly" plugin set is excluded. The `.deb`/`.rpm` packages
bundle no GStreamer — they use the host's.

## Optional downloads: sample sets (not bundled)

The Samples manager can download sample sets — the strudel-rs/strudio
defaults, the strudel.cc defaults, and the single packs they are built from.
**None of these files ship with Cycletron or are redistributed by us** — the
user's machine fetches them from the upstream repositories (the same sources
the strudel-rs engine streams from) into the local app cache.

- **Versilian Community Sample Library (VCSL)** by Versilian Studios and
  contributors (https://github.com/sgossner/VCSL) — **CC0**. The `vcsl` and
  `strudel-cc` sets; ten of its one-shots are also bundled (above).
- **tidal-drum-machines** (https://github.com/ritchse/tidal-drum-machines),
  sample packs of 71 drum machines collected by ritchse — **no license file,
  mixed provenance**. The `drum-machines` and `strudel-cc` sets. Downloaded
  from upstream at user request only, never mirrored or redistributed.
- **Mridangam** samples © Arthur Carabott 2022, performed by Harishankar V
  Menon (https://github.com/yaxu/mrid, https://www.arthurcarabott.com/konnakkol/)
  — **CC-BY-SA**. The `mridangam` and `strudel-cc` sets.

- **Salamander Grand Piano** by **Alexander Holm** — **CC-BY-3.0**
  (<http://creativecommons.org/licenses/by/3.0/>). Fetched as the
  dough-samples `piano.json` renderings
  (https://github.com/felixroos/dough-samples); original recording:
  https://archive.org/details/SalamanderGrandPianoV3.
- **uzu drumkit** (https://github.com/tidalcycles/uzu-drumkit) — **Unlicense**.
  Supplies the default `bd`/`sd`/`hh`/… voices, matching strudel-rs.
- **uzu wavetables** (https://github.com/tidalcycles/uzu-wavetables) — mixed:
  the AKWF-derived `wt_vgame` tables are CC0; `wt_digital` (Glossing) carries
  no SPDX license. Downloaded from upstream at user request only.
- **Dirt-Samples** (https://github.com/tidalcycles/Dirt-Samples) — the classic
  SuperDirt pack; **no license file, mixed provenance**. Downloaded from
  upstream at user request only, never mirrored or redistributed.

## Trademarks

Roland, TR-808, TR-909, TR-707, and Boss DR-55 are trademarks of Roland
Corporation; LinnDrum is associated with Linn Electronics / inMusic Brands;
TX81Z is a trademark of Yamaha Corporation. Product names are used here solely
to identify the hardware the recordings were sampled from. Cycletron is not
affiliated with or endorsed by any of these companies.
