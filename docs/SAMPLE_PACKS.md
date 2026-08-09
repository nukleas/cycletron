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

## Not in v1

- Install-from-folder wizard (use a hand-built pack layout for now)
- Remote download
- Agent `list_packs` / `enable_pack` tools
- Pitched multisample metadata

## Example: enable a hand-built pack

1. Create `{library}/Packs/my-pack/` with `pack.json`, `LICENSE`, and wavs.
2. Palette → Sample Packs… → enable **my-pack**.
3. Play: `s("my_bank my_bank:1")` (use the bank names from the pack).
