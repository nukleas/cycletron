# Cycletron — release & packaging

How releases are built, signed, and published.

## Prerequisites

- The **strudel-rs** engine is a pinned git dependency (Codeberg) and the prebuilt
  audio WASM is committed under `ui/pkg` — a fresh clone builds with no sibling
  checkout and no nightly toolchain.
- Rust (workspace edition 2024), Node 22+. `wasm-pack` + nightly are needed only to
  rebuild the audio WASM (see README).

## Build (unsigned local)

```bash
# from cycletron/ — cargo tauri build runs npm install + vite build for you.
cargo tauri build
```

Artifacts land under the workspace-root `target/release/bundle/`.

### DevTools while developing

`tauri.conf.json` ships with `"devtools": false` for release safety. For local
debugging, temporarily set `"devtools": true` or inspect via the platform
WebView tools. Do not ship with DevTools enabled.

## Auto-updater

Update manifests are signed with a Tauri updater keypair:

- The **public key** is committed in `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey`.
- The private key is held offline by the maintainer and provided to CI as the
  secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  It is never committed.

Endpoint: `https://github.com/nukleas/cycletron/releases/latest/download/latest.json`
(served from the latest published GitHub release).

## Cutting a release

`.github/workflows/release.yml` runs on a `v*` tag and produces a **draft**
pre-release with signed bundles + `latest.json`, across three platforms:

| Platform | Artifact | Signing |
|----------|----------|---------|
| macOS | universal `.dmg` + `.app` | Developer ID + notarized (app **and** dmg) |
| Linux | `.AppImage`, `.deb`, `.rpm` | unsigned (n/a) |
| Windows | NSIS `.exe` | intentionally unsigned for alpha — SmartScreen "More info → Run anyway" |

macOS signing/notarization runs only for the maintainer: the signing
certificate lives in a `release` environment restricted to `v*` tags, and the
remaining Apple credentials are repo secrets. Forks without these secrets can
still produce unsigned builds.

Nothing is public until the draft is reviewed on GitHub and **published**.

```bash
# clean tree, green CI
git tag -a v0.1.0-alpha.6 -m "Cycletron alpha 6"
git push origin v0.1.0-alpha.6
```

Ship notes should mention: AGPL, API key / Ollama requirement for AI, Play-first
audio arming, and dialect ≠ full web Strudel.

## Privacy (user-facing copy)

> Prompts and pattern text go to the AI provider you choose. API keys stay in
> the local secrets store (keychain in release builds). Logs and agent stats remain on this machine.

## Legal

- Application license: **AGPL-3.0-or-later** (`LICENSE`).
- Pattern engine: strudel-rs (separate project; credit in About).
- Bundled audio: all CC0 / MIT / public-domain — per-bank provenance in
  `ATTRIBUTION.md`, license texts in `licenses/`.
