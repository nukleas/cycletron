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
| `list_packs` | Installed packs + enabled flag |
| `get_pack` | Full manifest |
| `enable_pack` / `disable_pack` | Persist + return load paths |
| `load_enabled_packs` | Startup batch |
| `packs_dir` | Absolute Packs path |

## Install from folder

Palette → **Install Sample Pack…** (or Sample Packs → **Install from Folder…**).

Picks a Strudel-style folder (subfolder = bank, or loose audio at root), copies
it into `Packs/<id>/`, writes `pack.json` + `LICENSE` (`LicenseRef-UserProvided`),
and enables the pack.

- Pack id defaults from the folder name (`Dirt-Samples` → `dirt-samples`)
- Core bank name collisions are renamed: `bd` → `bd_dirt_samples`
- Caps: 8000 files, 768 MB (thin large libraries first)
- Source path is recorded in `pack.json` for provenance; audio is **copied**, not linked

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
  (dough-samples piano, uzu drumkit, uzu wavetables, Dirt-Samples), fetched
  from upstream into `{app_cache}/sample-sets/strudel/`. Active, Cycletron
  sounds identical to strudel-rs.

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

Known gaps (all sets): enabled Packs are live-only — export does not load
them; GM soundfonts stream from the WebAudioFont data during export.

## Not yet

- Remote download of Packs (sample sets above have their own downloader)
- Agent `list_packs` / `enable_pack` tools
- Pitched multisample metadata

## Example: hand-built pack

1. Create `{library}/Packs/my-pack/` with `pack.json`, `LICENSE`, and wavs.
2. Palette → Sample Packs… → enable **my-pack**.
3. Play: `s("my_bank my_bank:1")`.
