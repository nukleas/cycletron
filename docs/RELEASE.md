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

## Auto-updater keys — done

Signing keypair generated with `cargo tauri signer generate`:

- **Public key** is committed in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- **Private key** is at `~/.tauri/cycletron-updater.key` (password in
  `~/.tauri/cycletron-updater.pw`) and is set as repo secrets
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

> ⚠️ **Back up the private key + password offline.** If they are lost you cannot
> ship an update that existing installs will accept — every user would have to
> reinstall. Never commit the `.key` (gitignored).

Endpoint: `https://github.com/nukleas/cycletron/releases/latest/download/latest.json`.
The repo is **private**, so that URL isn't publicly reachable yet — auto-update
begins working once the repo (or a public releases mirror) serves the assets.
Until then the build/sign/publish pipeline is validated via **draft** releases.

## Apple Developer ID signing + notarization

`.github/workflows/release.yml` signs + notarizes when these repo secrets exist.
Create them once (macOS Keychain → export **Developer ID Application** cert as a
`.p12`):

```bash
base64 -i cycletron-devid.p12 | pbcopy   # value for APPLE_CERTIFICATE

gh secret set APPLE_CERTIFICATE          --repo nukleas/cycletron   # base64 of the .p12
gh secret set APPLE_CERTIFICATE_PASSWORD --repo nukleas/cycletron   # the .p12 export password
gh secret set APPLE_SIGNING_IDENTITY     --repo nukleas/cycletron   # "Developer ID Application: Name (TEAMID)"
gh secret set APPLE_ID                   --repo nukleas/cycletron   # your Apple ID email
gh secret set APPLE_PASSWORD             --repo nukleas/cycletron   # app-specific password (appleid.apple.com)
gh secret set APPLE_TEAM_ID              --repo nukleas/cycletron   # 10-char team id
```

Without these the workflow still builds, but ships **unsigned** (testers
right-click → Open past Gatekeeper once).

## CI secrets — current state

| Name | Set? | Purpose |
|------|------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | ✅ | Updater signature |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | ✅ | Updater key password |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | ⬜ you | Developer ID cert (.p12, base64) |
| `APPLE_SIGNING_IDENTITY` | ⬜ you | Signing identity string |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | ⬜ you | Notarization |

The engine is a public Codeberg git dependency and the audio WASM is committed,
so CI needs no engine token and no sibling checkout.

## Cutting a release

`.github/workflows/release.yml` runs on a `v*` tag and produces a **draft**
pre-release (macOS universal) with signed bundles + `latest.json`. Nothing is
public until you review the draft on GitHub and hit **Publish**.

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
