# Cycletron v0.1.0-alpha.1

**AI-native live coding for music** — a desktop instrument with an AI operator.
A [NaderLabs](https://www.naderlabs.io/) project.

First public alpha. Cycletron is a Tauri v2 desktop app: a WASM live-coding
REPL powered by [strudel-rs](https://codeberg.org/nukleas/strudel-rs), a file
library, MIDI tools, and an opt-in chat-driven AI operator that writes and
rewrites patterns with you.

## Highlights

- **Live coding first.** Evaluate patterns in the editor (⌘↩), transport, BPM,
  metronome, visuals. Audio runs entirely in WASM (AudioWorklet) — press
  **Play** once to arm audio, then evaluate away.
- **AI is opt-in.** Cycletron is a fully usable instrument with AI off. Enable
  it in Preferences → AI with your own provider: Claude, Grok, OpenAI, or a
  local OpenAI-compatible endpoint (Ollama, LM Studio). Keys stay in your OS
  keychain; prompts and pattern text go only to the provider you choose.
- **MIDI.** Import, lab conversion, keyboard input, pads.
- **Library.** Save patterns, recents, snapshots, sample packs, export.
- **Curated corpus + genre recipes** ground the AI in patterns that actually
  validate and make sound.

## Know before you play

- **The dialect is a subset of web Strudel.** The exact supported surface is
  documented in [`docs/STRUDEL_RS_SUPPORTED.md`](docs/STRUDEL_RS_SUPPORTED.md);
  common footguns in [`docs/DIALECT.md`](docs/DIALECT.md). Patterns from
  strudel.cc may need small adjustments.
- **AI features require your own API key or a local model.** Nothing is
  bundled, and nothing leaves your machine until you enable a provider.
- **Alpha.** macOS-first. Auto-update is not wired yet — grab new builds from
  the releases page. Windows/Linux builds are untested.

## License

Cycletron is free software: **AGPL-3.0-or-later** — free as in freedom. It
builds on and adapts [Strudel](https://codeberg.org/uzu/strudel) and
[strudel-rs](https://codeberg.org/nukleas/strudel-rs) (both AGPL-3.0-or-later);
see [`NOTICE`](NOTICE) for derivation credits and corresponding-source details,
and [`ATTRIBUTION.md`](ATTRIBUTION.md) for bundled audio (all CC0/MIT/PD).
Cycletron is not affiliated with or endorsed by strudel.cc.
