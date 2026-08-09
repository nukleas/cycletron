# Attribution — bundled third-party assets

Cycletron itself is licensed AGPL-3.0-or-later (see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE)). The audio assets vendored under `ui/public/` come from
third parties and keep their own licenses. Verbatim copies of every upstream
license/provenance text ship in [`licenses/`](licenses/).

## Default drum kit — `ui/public/samples/{bd,sd,sn,hh,cp,oh,ht,mt,lt,cr,cb,rs}/`

**Roland TR-808 sample set** recorded by **Michael Fischer (Technopolis, 1994)**
directly from a TR-808 (serial no. 103852) — see
[`licenses/TR808-Fischer-README.txt`](licenses/TR808-Fischer-README.txt).

- Source: https://github.com/tidalcycles/sounds-tr808-fischer
- License: **CC0-1.0** ([`licenses/TR808-Fischer-LICENSE.txt`](licenses/TR808-Fischer-LICENSE.txt)).
  Fischer's own note says the set is "ABSOLUTELY FREE"; the explicit CC0
  dedication was applied by the TidalCycles project when republishing.

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

## Trademarks

Roland, TR-808, TR-909, TR-707, and Boss DR-55 are trademarks of Roland
Corporation; LinnDrum is associated with Linn Electronics / inMusic Brands;
TX81Z is a trademark of Yamaha Corporation. Product names are used here solely
to identify the hardware the recordings were sampled from. Cycletron is not
affiliated with or endorsed by any of these companies.
