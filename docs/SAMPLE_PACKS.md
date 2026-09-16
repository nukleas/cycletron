# Sample packs

Optional sample libraries under `{library_root}/Packs/`. The app bundle keeps a
small core kit; everything else is installed and enabled by the user.

See also [ATTRIBUTION.md](../ATTRIBUTION.md) for bundled (core) audio.

## Layout

```
{library_root}/Packs/
  enabled.json          # { "version": 1, "enabled": ["demo-pack"] }
  demo-pack/
    pack.json
    LICENSE
    banks/
      demo_pluck/
        00.wav
        01.wav
```

Folder name must equal `pack.json` → `id`.

## pack.json

```json
{
  "schema": 1,
  "id": "demo-pack",
  "name": "Demo pluck",
  "version": "1.0.0",
  "description": "Short CC0 one-shots.",
  "spdx": "CC0-1.0",
  "license_file": "LICENSE",
  "tags": ["pluck", "cc0"],
  "banks": [
    {
      "name": "demo_pluck",
      "files": [
        "banks/demo_pluck/00.wav",
        "banks/demo_pluck/01.wav"
      ]
    }
  ]
}
```

| Field | Notes |
|-------|--------|
| `schema` | Must be `1` |
| `id` | `[a-z0-9][a-z0-9_-]{0,62}`, matches directory name |
| `spdx` | Or `license` alias. Allowlist for enable: `CC0-1.0`, `MIT`, `Apache-2.0`, `LicenseRef-PublicDomain`, `LicenseRef-UserProvided` |
| `license_file` | Relative path; required on disk |
| `banks[].name` | `s("name")` token, ≤31 chars; must not collide with core drums/colors/machines |
| `banks[].files` | Relative paths; order is sample index (`name:0`, `name:1`, …) |

Paths cannot escape the pack directory.

## UI

Command palette → **Sample Packs…**

- Toggle enable (persists to `enabled.json`, loads banks immediately)
- **Open Packs Folder** / **Reload Enabled**
- Enabled packs also load at app startup after the core kit

Disable removes the id from `enabled.json`; banks stay in the engine until restart
(v1 does not unload).

## Bank name policy

Core banks (`bd`, `perc`, `RolandTR808_bd`, …) always win. A pack bank with the
same name is skipped. Prefer distinct names for expansion packs
(`flbass_full`, not `flbass` if core already owns it).

## Commands (Tauri)

| Command | Role |
|---------|------|
| `list_packs` | Installed packs + enabled flag, with each bank's files |
| `enable_pack` / `disable_pack` | Persist + return load paths |
| `load_enabled_packs` | Startup batch |
| `packs_dir` | Absolute Packs path |
| `preview_pack_import` | Stage a folder or `.zip`, propose a bank mapping |
| `commit_pack_import` | Copy the reviewed mapping into `Packs/<id>/` |
| `cancel_pack_import` | Discard the staging directory |

## Import samples

Palette → **Import Sample Pack (Folder)…** or **(.zip)…**, the Samples manager's
Import buttons, or drop a `.zip` or a folder onto the window.

Importing is a two-step flow: Cycletron stages the source and *proposes* a bank
mapping, you review it, and only then is anything copied into your library.

### How banks are derived

Each immediate subfolder is a bank, as before. Loose audio at the root goes
through a three-rung ladder, because that is how hardware sample packs actually
ship — flat, with the voice type in the filename:

1. **Leading tag** — the run before the first `-`, `_` or space.
   `BD-dx200-909ishKick-768kbps.wav` → `bd`, `SNARE 3.wav` → `snare`.
2. **Trailing index** — a trailing number stripped from the stem.
   `BD0050.WAV` → `bd`.
3. **Single bank** — everything in one indexed bank named after the folder.

A rung is rejected if it produces more than 64 banks or if most banks would hold
a single file, since that means the convention isn't really there. Files within
a bank are natural-sorted (`BD 2` before `BD 10`), and that order *is* the `:n`.

### The review step

- Bank names are shown **after** core-collision renaming (`bd` → `bd_<pack id>`),
  so what you read is what you will type.
- Rename a bank, drop one, reorder or remove a sample.
- Audition anything before committing — staged files are real files on disk.
- File count and size are shown up front against the 8000 file / 768 MB caps.
- Cancelling (or Escape, or the backdrop) removes the staging directory. Staging
  lives in the app cache and is swept at startup, so a crash leaves nothing.

### Archive handling

Only audio is extracted. Path traversal and symlink entries are refused,
`__MACOSX` and dotfiles are skipped, and the caps are enforced from the declared
sizes *before* extraction as well as during it. A `LICENSE`/`README` in the
archive is reported by name and never extracted — Cycletron tells you terms
exist, it does not read or grant them.

Imported packs are written with `spdx: LicenseRef-UserProvided` and a `LICENSE`
recording the source path. That marker means "the user supplied this"; it is not
a grant.

## Where to get more samples

The Samples manager links to free sources (Legowelt, Freesound, the Internet
Archive, SampleRadar, 99Sounds, and VCSL — which is already a built-in set).

**Cycletron does not host, mirror, or license any of that audio.** Each entry
quotes the publisher's own stated terms, which can change; check them before
releasing anything made with them. Several of those sources grant use in
productions but not redistribution, which is exactly why they are links rather
than downloadable sample sets.

## Sample sets (Samples manager)

Separate from Packs: downloadable **sample sets**, registry-style. A set is an
ordered list of `strudel.json` manifest sources; the order is the mapping —
the first manifest owning a bank name wins, exactly strudio's registration
semantics. The active set drives **both live playback and audio export**, so
they always sound the same.

Built in:

- **cycletron** (default) — the bundled set. Export renders it via
  `ui/public/cycletron.strudel.json`, generated from `ui/sample-tables.ts`,
  so export always matches live playback.
- **strudel** — the exact sources `strudio play`/`render` registers
  (dough-samples piano, uzu drumkit, uzu wavetables, Dirt-Samples). Active,
  Cycletron sounds identical to strudel-rs.
- **strudel-cc** — what strudel.cc loads at startup, in its order: piano,
  VCSL, tidal-drum-machines, uzu drumkit, uzu wavetables, mridangam, then
  Dirt-Samples (the site loads a ten-bank Dirt subset; we list all of Dirt
  last, so every shared bank keeps the same owner). The largest set.
- **drum-machines** — the 71 tidal-drum-machines kits on their own:
  `s("bd sd").bank("RolandTR909")`, `AkaiMPC60`, `LinnDrum`, `OberheimDMX`,
  `YamahaRX5`… The agent's `list_sounds` lists every machine with its voices
  while this set (or `strudel-cc`) is active.
- **vcsl** — the Versilian Community Sample Library (CC0): 128 pitched and
  percussion instruments.
- **mridangam** — South Indian mridangam strokes (CC-BY-SA).

Downloads are stored per *source* under `{app_cache}/sample-sets/sources/`,
so sets that share a source share one download: after `vcsl`, activating
`strudel-cc` only fetches what is missing, and deleting a set only removes
sources no other set lists. (Installs from before this layout are moved over
automatically.)

Define your own sets in `{app_data}/sample-sets.json`:

```json
[
  {
    "id": "my-breaks",
    "label": "My breaks",
    "sources": [
      "github:user/breaks-pack",
      "https://example.com/kits/strudel.json"
    ]
  }
]
```

`github:user/repo[/branch]` resolves to the repo's `strudel.json` on
raw.githubusercontent.com, like the engine's `samples()` shortcut. Sets appear
in the Samples manager (⌘⇧P → "Samples…", the Sounds panel's Manage button,
or Preferences → Samples → Manage) with their own Download/Delete buttons; a
set must be fully downloaded before it can be activated. Downloads resume
(finished files are kept). Switching sets — from the manager or the command
palette's "Sample Set: …" entries — reloads the audio engine with the new
set immediately (export always follows the setting). The manager also holds
the Packs list, so all sample management lives in one place.

Known gap (all sets): enabled Packs are **live-only — audio export does not load
them**, so a pattern using a pack bank exports with that part silent. This is
now the only live/export divergence left. GM soundfonts stream from the
WebAudioFont data during export.

## Not yet

- Pack-aware audio export (see the known gap above)
- Remote download of Packs (sample sets above have their own downloader)
- Agent `list_packs` / `enable_pack` tools
- Pitched multisample metadata

## Example: hand-built pack

1. Create `{library}/Packs/my-pack/` with `pack.json`, `LICENSE`, and wavs.
2. Palette → Sample Packs… → enable **my-pack**.
3. Play: `s("my_bank my_bank:1")`.
