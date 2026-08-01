# Publish readiness & brand notes

Living notes from the 2026-07 product audit. Update as gates close.

**Status snapshot:** ~70–75% ready for **private alpha** (docs + CI + license + CSP in place). Still blocked on updater keys, Apple signing, and a green CI run against a real `strudel-rs` token if the engine repo is private.

Related: [PLAN.md](../PLAN.md), [AGENT_FRICTION.md](./AGENT_FRICTION.md), [STRUDEL_RS_SUPPORTED.md](./STRUDEL_RS_SUPPORTED.md).

---

## 1. Scorecard

| Area | Score | Notes |
|------|------:|-------|
| Core product / features | **8/10** | Full Tauri app: editor, AI chat, MIDI Lab, export WIP, examples, corpus, viz |
| Ease of use (power users) | **7/10** | Palette, menus, shortcuts, empty state, quick prompts |
| Ease of use (new musicians) | **4/10** | Onboarding is setup, not teaching music or the AI workflow |
| Help / tutorials / docs | **6/10** | USER_GUIDE + DIALECT + in-app Help; progressive Examples; no video/tour yet |
| Quality / tests / CI | **7/10** | Unit tests + corpus-check + GitHub Actions; engine is a public git dep (no token/sibling); typecheck vs committed `ui/pkg`; no UI e2e |
| Security / privacy | **7/10** | Keychain; production CSP set; DevTools off; privacy blurb in About |
| Distribution / packaging | **5/10** | Bundle + licenseFile; **clean-clone build works** (git-dep engine + committed WASM); updater pubkey empty; signing not done |
| Legal / licensing | **7/10** | AGPL LICENSE file + About notice; sample-bank audit still open |
| Cross-platform | **5/10** | macOS-first; keyring now apple + secret-service + windows-native; Win/Linux installer smoke pending |
| Branding / marketing surface | **6/10** | Cycletron About/README; site/download page still open |

---

## 2. What’s already strong

### Product surface
- Desktop shell: Tauri v2, native menus, tray, file associations (`.strudel`, MIDI), drag-drop, autosave/session restore.
- AI-first workflow: multi-provider (Claude / Grok / OpenAI / local / custom), OS keychain keys, tool loop, corpus search, genre generation.
- Music UX: CodeMirror, transport, BPM/gain, metronome, MIDI input/monitor/pads, MIDI Lab, examples (~28), ambient viz, command palette (`⌘⇧P`).
- First-run: 4-step welcome (shortcuts → provider key → library root → done).
- Support primitives: Show Logs, diagnostic dump, About, updater hooks.
- Preferences: AI, audio, MIDI, notifications, global shortcuts, library root.
- Bundled samples (~8MB public assets for offline play).

### Engineering (dev-facing)
- Agent friction loop with concrete lint/critique fixes.
- `corpus-check` gates curated patterns.
- Substantial generator/analysis unit tests.
- Architecture: WASM owns audio; Rust owns AI/corpus/files.

---

## 3. P0 — must fix before public download

1. ~~LICENSE / user docs / privacy blurb / CSP / DevTools off / CI workflow~~ — **Stream D done.**
2. ~~**Cannot build from a clean public clone**~~ — **DONE.** `strudel-rs` is now a pinned
   git dependency (public Codeberg, `rev` in workspace `Cargo.toml`) and the prebuilt audio
   WASM is committed under `ui/pkg`, so a fresh clone builds with no sibling checkout and no
   nightly. `beforeDevCommand`/`prebuild` no longer rebuild the WASM.
3. **Release pipeline incomplete** — updater `pubkey: ""`, no Apple signing/notarization yet (see `docs/RELEASE.md`).
4. **Sample-bank license audit** — bundled Dirt-Samples / soundfonts before wide redistribution.
5. ~~**Green CI (STRUDEL_RS_TOKEN)**~~ — engine is a public git dep now, so CI needs no token /
   sibling checkout; the WASM-type stub is gone (typecheck runs against the committed `ui/pkg`).
   Still: confirm the first green run on GitHub.
6. **Ship only from a clean tag** — exclude scratch / WIP from release notes.

Cross-platform note: `keyring` now enables `apple-native` + `sync-secret-service` (Linux) +
`windows-native`. Installer/keyring smoke tests on Windows/Linux still pending.

---

## 4. P1 — high-priority product gaps

### Onboarding
| Present | Missing |
|---------|---------|
| Welcome setup wizard | Guided first-song wizard (Play → Lesson 1 → AI → save) |
| Empty editor: Open / New / Examples | — |
| Help → User Guide / Shortcuts / Dialect | Video / interactive tour |
| Progressive Examples (lessons → patterns → showcase + techniques/songs/genres) | ~~Wire Agency + songs + curated corpus into library `Demos/` at install~~ done |
| AI welcome copy (Play first) | Clearer empty state when no API key |

### Help system (target)
1. Product user guide (AI operator, eval/play, library, MIDI, export).
2. Keyboard shortcuts modal.
3. Troubleshooting (no sound, API errors, keychain).
4. Honest DSL scope vs web-strudel (supported surface, human-readable).
5. Report a bug (diagnostic dump → issue template).
6. Privacy / data: what leaves the machine vs stays local.

### Quality / trust
- Frontend smoke tests (none today).
- Residual agent friction (genre recipes lag generator; effects discoverability).
- Commit `Cargo.lock` for application reproducibility (currently gitignored).
- Tighten CSP; disable production DevTools.
- Plain-language error toasts (many failures only `console.warn`).

### Distribution (macOS-first)
- [ ] Apple signing + notarization  
- [ ] Updater pubkey + signed `latest.json`  
- [ ] Pin/vendor `strudel-rs` for CI  
- [ ] Windows/Linux keyring + installer smoke  
- [ ] CHANGELOG + download page  

---

## 5. Ship gates

### Gate A — Private alpha
1. ~~Root README~~  
2. ~~LICENSE + About attribution + privacy~~  
3. ~~User quickstart (`docs/USER_GUIDE.md` / in-app Help)~~  
4. Signed macOS build (updater optional) — **owner**  
5. Tag `v0.1.0-alpha` from clean tree — **owner**  
6. ~~CI workflow (test + corpus-check + UI typecheck)~~ — confirm green  
7. ~~Privacy one-liner~~

### Gate B — Public beta
1. In-app 3–5 step tutorial that makes sound.
2. Help → Shortcuts + Troubleshooting.
3. Working auto-updater.
4. Document/vendor `strudel-rs` build.
5. Production CSP + no DevTools.
6. Bug-report path with diagnostic dump.
7. Known limitations (DSL ≠ full web Strudel).

### Gate C — 1.0
1. Windows/Linux installers.
2. A11y + cold-start polish.
3. Stable export; sample license audit; recipe coverage.
4. Optional website, demo video, opt-in crash reporting.
5. Support channel.

### Who can use it today?

| Persona | Ready? |
|---------|--------|
| Power users / author | Yes |
| Friends via private alpha DMG | Almost (needs install + key notes) |
| Musicians new to live coding | No (no tutorial path) |
| OSS contributors from GitHub | No (README + monorepo story) |
| Random public download | No |

---

## 6. Branding & naming

### Decision (locked working title)

| Layer | Name | Role |
|-------|------|------|
| Studio / creator home | **NaderLabs** · [naderlabs.io](https://www.naderlabs.io/) | Portfolio, blog, music side-quest hub |
| Desktop product | **Cycletron** | What users install and say aloud |
| GitHub / handle (cross-project) | **nukleas** (and related) | Org/username — not the consumer app name |
| Pattern engine (About/docs) | **strudel-rs** | Technical credit only |
| Pattern dialect (docs) | Strudel-compatible mini-notation | Interop label, not product brand |
| Legacy codename | Robostrudel | Retired — crates renamed to `cycletron-*` |

**Working taglines**

- Public: **Cycletron** — AI-native live coding  
- Subline: A [NaderLabs](https://www.naderlabs.io/) project · engine: strudel-rs  
- Kinetic read: cycles in, patterns out — a machine for accelerating musical ideas  

**NaderLabs placement (site)**

- Home already has `side-quests → music/` — Cycletron lives under **music**, not as a rename of NaderLabs.
- Suggested URLs (pick one primary when shipping):
  - `https://www.naderlabs.io/music/cycletron` (docs, download, screenshots)
  - optional vanity later: `cycletron.ai` / `cycletron.app` → redirect to NaderLabs page
- About box / README footer: **Cycletron · a NaderLabs project**
- Do **not** put “Strudel” in the nav title or download headline.

### Why not Cyclotron / Robostrudel

- **Cyclotron** — `cyclotron.com` is an active enterprise AI consultancy; npm/pypi/GitHub noise; bad twin for an AI music app.
- **Robostrudel** — AI + “strudel” invites anti-AI scene friction; keep strudel-rs as engine credit only.
- **Cycletron** — cycle + -tron (live-coding time + instrument/machine); freer brand surface; `.com` parked/for sale, alternates (`.ai` / `.app` / `getcycletron.com`) looked open as of 2026-07-26 (re-check before buy).

### Separation of concerns

| Layer | Name | Public rule |
|-------|------|-------------|
| Pattern language | mini-notation / Strudel-compatible dialect | Technical docs only |
| Engine | strudel-rs | About + README “powered by” |
| Product | **Cycletron** | Menu bar, DMG, marketing |
| Studio | NaderLabs | Parent site, “a NaderLabs project” |
| Bundle id (target) | `com.nukleas.cycletron` or `io.naderlabs.cycletron` | Freeze before first signed public build |
| File extension | keep `.strudel` for interop | Optional later dual ext |
| Keychain service | `cycletron` | Old builds used `robostrudel` — re-enter keys once |

### Availability snapshot (2026-07-26)

| Asset | Cycletron | Notes |
|-------|-----------|--------|
| cycletron.com | Taken (Sedo parking / for sale) | Negotiate only if price is sane |
| cycletron.io | Taken | — |
| cycletron.ai / .fm / getcycletron.com | Likely free | Confirm at registrar |
| cycletron.app / .dev | Possibly free | Confirm at registrar |
| GitHub user `cycletron` | Free | Claim early |
| npm / pypi `cycletron` | Free | Claim if publishing packages |
| cyclotron.* | Avoid | Conflicting AI consultancy brand |

### Rename surface

**Done (Streams A + E):** user-visible Cycletron everywhere; crates `cycletron-{core,agent,corpus,gen,analysis}` + `cycletron-app`; log targets `cycletron::*`; keychain `cycletron`; bundle id `com.nukleas.cycletron`.

**Historical only:** `_references/` research notes may mention the old codename; keychain migration from service `robostrudel`.

### Messaging cheat-sheet

- **Cycletron** is an original AI composition environment from **NaderLabs** — not an official strudel.cc product.
- Pattern engine: **strudel-rs** (separate Rust implementation).
- Dialect: Strudel-compatible mini-notation where accurate.
- Do not engage culture-war threads; point to license, repo, and technical docs.

### Decision log

| Date | Decision | Notes |
|------|----------|-------|
| 2026-07-26 | Product rename under consideration | Avoid Strudel* consumer brand; keep strudel-rs |
| 2026-07-26 | **Working product name: Cycletron** | Not Cyclotron (consultancy collision). Parent: **NaderLabs** / naderlabs.io music side-quest. Nukleas stays handle/org, not app name. |
| 2026-07-26 | Domains | Prefer naderlabs.io/music/cycletron as canonical; optional cycletron.* vanity → redirect. Grab alternates if cheap. |
| 2026-07-26 | **GitHub home: `nukleas/cycletron`** | Product branding + README; private repo under @nukleas. Bundle id `com.nukleas.cycletron`. |
| 2026-07-26 | **Stream E: crate rename** | `robostrudel-*` → `cycletron-*` (dirs, packages, Rust crate ids, docs). |

---

## 7. Immediate next work (suggested order)

1. ~~Stream A~~ brand freeze  
2. ~~Stream B~~ materials / Help  
3. ~~Stream D / Gate A plumbing~~ LICENSE, privacy, CSP, DevTools off, Cargo.lock, CI, RELEASE.md, strudel-rs API fix  
4. Generate updater keypair + paste pubkey; Apple sign alpha DMG  
5. Confirm CI green (strudel-rs token if private)  
6. Vendor/document strudel-rs for clean clones  
7. Gate B+: guided tour, working auto-updater, sample license audit  
8. ~~Stream E~~ crate rename `robostrudel-*` → `cycletron-*`

---

## 8. Changelog of this doc

| Date | Change |
|------|--------|
| 2026-07-26 | Initial audit notes + branding/naming section from publish-readiness review |
| 2026-07-26 | Locked working product name **Cycletron** under **NaderLabs**; availability + site placement notes |
| 2026-07-26 | **Stream A:** fixed `build:wasm` out-dir → `cycletron/ui/pkg`; tray/MIDI/log branding; CLAUDE/AGENTS aligned; PLAN.md archived banner; frontmatter test tag match |
| 2026-07-26 | **Stream B:** `docs/USER_GUIDE.md` + `DIALECT.md`; in-app Help modal; progressive Examples (lessons/patterns/showcase); .js songs → .strudel; DnB dedupe; About → CYCLETRON |
| 2026-07-26 | **Stream D:** AGPL `LICENSE`; About privacy; CSP + `devtools: false`; track `Cargo.lock`; CI workflow; `docs/RELEASE.md`; restore `execute` cascade for current strudel-rs |
| 2026-07-26 | **Stream E:** full crate/path rename `robostrudel-*` → `cycletron-*` |
| 2026-07-31 | **AI co-editor arc:** `list_methods` tool; track-aware surgical editing (`list_parts`/`upsert_track`/`mute_track`); genre-recipe coverage 12 → 65; transport skip ±5 cycles; auto full-loop export length (+ pickRestart-length fix). |
| 2026-07-31 | **Engine migration (P0 #2 resolved):** `strudel-rs` path deps → pinned public Codeberg git dep; audio WASM rebuilt from main + committed to `ui/pkg`; clean clone builds with no sibling/nightly. README + CI updated (no `STRUDEL_RS_TOKEN`, no WASM stub); keyring cross-platform. |
