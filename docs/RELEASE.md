# Cycletron — release & packaging

Steps for private alpha and public builds. Product readiness scorecard:
[PUBLISH_READINESS.md](./PUBLISH_READINESS.md).

## Prerequisites

- The **strudel-rs** engine is a pinned git dependency (Codeberg) and the prebuilt
  audio WASM is committed under `ui/pkg` — a fresh clone builds with no sibling
  checkout and no nightly toolchain.
- Rust (workspace edition 2024), Node 22+. `wasm-pack` + nightly are needed only to
  rebuild the audio WASM (see README).
- macOS for signed desktop alpha (recommended first target).

## Gate A checklist (private alpha)

| Item | Status / how |
|------|----------------|
| Display name Cycletron | `tauri.conf.json` `productName` / menus |
| LICENSE (AGPL-3.0-or-later) | root `LICENSE` |
| User docs | `docs/USER_GUIDE.md`, in-app Help |
| Dialect docs | `docs/DIALECT.md` |
| Privacy one-liner | About modal + Help → User Guide |
| `Cargo.lock` tracked | yes (reproducible builds) |
| Production CSP | `app.security.csp` object in `tauri.conf.json` |
| DevTools off in config | `app.windows[0].devtools: false` |
| CI | `.github/workflows/ci.yml` |
| Updater pubkey | **you** generate and paste (below) |
| Apple signing / notarization | **you** with Apple developer account |

## Build (unsigned local)

```bash
# from cycletron/ — cargo tauri build runs npm install + vite build for you.
cargo tauri build
```

Artifacts land under `src-tauri/target/release/bundle/`.

### DevTools while developing

`tauri.conf.json` ships with `"devtools": false` for release safety. For local
debugging, temporarily set `"devtools": true` or inspect via the platform
WebView tools. Do not ship with DevTools enabled.

## Auto-updater keys

Updater is configured but **`pubkey` is empty** until you generate a keypair.

```bash
# install CLI if needed: cargo install tauri-cli --version "^2"
cargo tauri signer generate -w ~/.tauri/cycletron.key
```

1. Put the **public** key string into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`.
2. Keep the **private** key offline / in CI secrets only (`TAURI_SIGNING_PRIVATE_KEY`).
3. Never commit `*.pem` / `*.key` (already gitignored).
4. Release workflow should upload `latest.json` + signed bundles to
   `https://github.com/nukleas/cycletron/releases/...` (endpoint already set).

Until the pubkey is set, in-app “Check for Updates” cannot verify packages —
that is expected for pre-alpha.

## CI secrets / vars

The engine is a **public** Codeberg git dependency and the audio WASM is committed,
so CI needs no engine token and no sibling checkout — it builds from a single clone.

| Name | Purpose |
|------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Updater signing (release job, later) |
| `APPLE_*` | Notarization (later) |

## Tagging a private alpha

```bash
# clean tree, green CI
git tag -a v0.1.0-alpha.1 -m "Cycletron private alpha 1"
git push origin v0.1.0-alpha.1
```

Ship notes should mention: AGPL, API key / Ollama requirement for AI, Play-first
audio arming, and dialect ≠ full web Strudel.

## Privacy (user-facing copy)

> Prompts and pattern text go to the AI provider you choose. API keys stay in
> the local secrets store (keychain in release builds). Logs and agent stats remain on this machine.

## Legal

- Application license: **AGPL-3.0-or-later** (`LICENSE`).
- Pattern engine: strudel-rs (separate project; credit in About).
- Sample banks / soundfonts: audit before wide public redistribution
  (bundled Dirt-Samples / WebAudioFont usage — see `ui/public/`).
