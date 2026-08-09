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

`.github/workflows/release.yml` follows the **same convention as `opensauna`**
(one Apple Developer account signs every app), so the secret *values* are shared
across repos — Cycletron just needs its own copies. The workflow imports the
cert into a temp keychain, **auto-detects** the Developer ID identity (no
`APPLE_SIGNING_IDENTITY` secret), notarizes the `.app` via Tauri, then
**separately notarizes + staples the `.dmg`** (Tauri skips the DMG wrapper).

Secret placement matches opensauna: the cert lives in a **`release`
environment** whose deployment policy permits only `v*` tags (so the key is
unreachable from PRs/branches); the rest are ordinary repo secrets.

| Secret | Scope | Value (same as opensauna) |
|--------|-------|---------------------------|
| `APPLE_CERTIFICATE_BASE64` | **`release` env** | `base64 -i ~/Code/Certificates.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | repo | the `.p12` export password |
| `APPLE_ID` | repo | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | repo | app-specific password (account.apple.com) |
| `APPLE_TEAM_ID` | repo | `8832K8LBLC` |

Most were copied from the shared Apple account already. **Only one remains** —
the `.p12` export password (the same value as opensauna's
`APPLE_CERTIFICATE_PASSWORD`); it isn't stored in any local file:

```bash
gh secret set APPLE_CERTIFICATE_PASSWORD --repo nukleas/cycletron   # the ~/Code/Certificates.p12 password
```

> Re-export gotchas (learned on opensauna): must be a **Developer ID Application**
> cert (not *Apple Distribution*); the `.p12` export must include the **private
> key** (Keychain Access → expand cert → select cert **and** key → *Export 2
> items*), or you get "0 valid identities".

## CI secrets — current state

| Name | Set on cycletron? | Purpose |
|------|------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | ✅ | Updater signature |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | ✅ | Updater key password |
| `APPLE_TEAM_ID` | ✅ | Apple team id (`8832K8LBLC`) |
| `APPLE_CERTIFICATE_BASE64` | ✅ (`release` env) | Developer ID cert (.p12 base64) |
| `APPLE_ID` | ✅ | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | ✅ | app-specific password |
| `APPLE_CERTIFICATE_PASSWORD` | ⬜ **you** | `.p12` password (last one) |

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
