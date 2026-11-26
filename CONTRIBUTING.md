# Contributing to Cycletron

Thanks for your interest! Cycletron is an alpha-stage project; issues, pattern
contributions, and PRs are all welcome.

## Building

```bash
cargo tauri dev     # dev app — installs UI deps and starts Vite for you
cargo tauri build   # production bundle
```

You need Rust (workspace edition 2024), Node 22+, and the Tauri CLI
(`cargo install tauri-cli --version "^2"`); on Linux also the system packages
CI installs (see `.github/workflows/ci.yml`). The strudel-rs engine is a
pinned crates.io dependency and the audio WASM is prebuilt under `ui/pkg`, so no
nightly toolchain or sibling checkout is needed.

## Before you open a PR

- Run the same Rust and UI checks CI runs:

  ```bash
  cargo fmt --all --check
  cargo clippy --workspace --all-targets --locked -- -D warnings
  cargo test --workspace --locked
  cd ui && npm run typecheck && npm run lint && npm test
  ```

- If you touch anything under `corpus/` (or `ui/songs/`), run the corpus gate:

  ```bash
  cargo run -p corpus-check
  ```

  It runs every example through the same strudel-rs execute pipeline the
  agent's `validate_pattern` uses, plus corpus-only gates: each pattern must
  emit at least one event within the first 8 cycles (a window, so songs that
  open on a rest aren't false-failed), must not contain unvoiced chords or
  unknown sounds, and the documented engine behaviors must still hold.

- To review a whole song the way the agent does, run the app binary's `check`:

  ```bash
  cargo run -q -p cycletron-app --bin cycletron -- check song.strudel
  ```

- To render a show file (`docs/SHOW_FILES.md`) from the checkout, run its
  `render` the same way, with `npm run dev` running in `ui/`: a debug build
  loads the render page from vite. Needs ffmpeg on the PATH.

## The DSL is a documented subset

The set of mini-notation operators, functions, and effects strudel-rs accepts
is **exactly** what `docs/STRUDEL_RS_SUPPORTED.md` says — web-strudel docs
diverge. Use that file as ground truth for anything you write or validate;
`docs/DIALECT.md` lists where the engine differs from web Strudel and what fails silently.

## Contributing patterns and corpus examples

Curated examples live in `corpus/{rhythm,melody,harmony,form,timbre,motion}/`
and genre recipes in `corpus/genres/`. Everything must pass `corpus-check`.
Only submit original work — no transcriptions of copyrighted songs, and any
audio must be CC0/MIT/public-domain with provenance recorded in
`ATTRIBUTION.md` and a license text in `licenses/`.

## License

Cycletron is **AGPL-3.0-or-later**. By contributing you agree your
contributions are licensed under the same terms.
