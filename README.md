# Cycletron

**AI-native live coding for music** — a desktop instrument with an AI operator.

A [NaderLabs](https://www.naderlabs.io/) project · by [@nukleas](https://github.com/nukleas)

> Patterns run on **strudel-rs** (Rust). The dialect is Strudel-compatible mini-notation. Cycletron is not affiliated with strudel.cc.

---

## What it is

Cycletron is a Tauri v2 desktop app: a WASM live-coding REPL, file library, MIDI tools, and a chat-driven AI operator that writes and rewrites patterns with you.

- **Play** — evaluate patterns in the editor (⌘↩), transport, BPM, visuals
- **Compose with AI** — Claude / Grok / OpenAI / local (Ollama, LM Studio)
- **MIDI** — import, lab conversion, keyboard input, pads
- **Library** — save patterns, recents, snapshots, export (evolving)

---

## Status

Early private development (`0.1.0`). Not a public 1.0 yet.

- **User guide:** [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) (also Help → User Guide in-app)
- **Dialect footguns:** [`docs/DIALECT.md`](docs/DIALECT.md) (Help → Cycletron Dialect)
- **Supported DSL:** [`docs/STRUDEL_RS_SUPPORTED.md`](docs/STRUDEL_RS_SUPPORTED.md)
- **Release readiness:** [`docs/PUBLISH_READINESS.md`](docs/PUBLISH_READINESS.md)

---

## Requirements (dev)

- Rust (edition 2024 toolchain as in workspace)
- Node.js + npm (UI)
- Sibling **strudel-rs** checkout at `../strudel-rs` (path deps + WASM package)
- Nightly + `wasm-pack` for `ui` WASM rebuilds
- Optional: API key for your AI provider (`ANTHROPIC_API_KEY` / `XAI_API_KEY` / `OPENAI_API_KEY`, or Preferences)

```bash
# from this repo
cargo tauri dev          # desktop app (runs Vite UI)
```

```bash
cd ui && npm run build:wasm   # rebuild strudel-audio-wasm (needs nightly)
```

---

## License

**AGPL-3.0-or-later** — see [`LICENSE`](LICENSE) and workspace `Cargo.toml`.

## Privacy

Prompts and pattern text go to the AI provider you choose. API keys stay in the
local secrets store (keychain in release builds). Logs and agent stats remain on this machine.

## Releasing

See [`docs/RELEASE.md`](docs/RELEASE.md) (updater keys, signing, CI, tags).

---

## Links

| | |
|--|--|
| Studio | [naderlabs.io](https://www.naderlabs.io/) |
| GitHub | [github.com/nukleas/cycletron](https://github.com/nukleas/cycletron) |
| Engine | strudel-rs (path dependency today) |
