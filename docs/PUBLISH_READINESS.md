# Publish readiness & brand notes

Living notes from the 2026-07 product audit. Update as gates close.

**Status snapshot:** ~55–65% ready for private/alpha release; not yet ready for a broad public “download and use it” launch.

Related: [PLAN.md](../PLAN.md), [AGENT_FRICTION.md](./AGENT_FRICTION.md), [STRUDEL_RS_SUPPORTED.md](./STRUDEL_RS_SUPPORTED.md).

---

## 1. Scorecard

| Area | Score | Notes |
|------|------:|-------|
| Core product / features | **8/10** | Full Tauri app: editor, AI chat, MIDI Lab, export WIP, examples, corpus, viz |
| Ease of use (power users) | **7/10** | Palette, menus, shortcuts, empty state, quick prompts |
| Ease of use (new musicians) | **4/10** | Onboarding is setup, not teaching music or the AI workflow |
| Help / tutorials / docs | **2/10** | Almost no end-user docs; Help → external Strudel docs only |
| Quality / tests / CI | **5/10** | ~134 Rust unit tests + corpus-check; no CI, no UI tests |
| Security / privacy | **5/10** | Keychain good; CSP off; no privacy policy; agent telemetry local-only |
| Distribution / packaging | **3/10** | Bundle config exists; signing/updater/keys incomplete; hard local deps |
| Legal / licensing | **3/10** | AGPL in Cargo.toml; no LICENSE file, no in-app notice |
| Cross-platform | **4/10** | macOS-first; Windows/Linux keyring not enabled |
| Branding / marketing surface | **4/10** | Icons, about modal; no README, site, or release notes |

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

1. **No public product docs** — no root README, user guide, FAQ, keyboard reference, install page. `learning/` empty. Help is setup/logs + external docs only.
2. **Cannot build from a clean public clone** — hard path deps on sibling `../strudel-rs`; UI WASM needs nightly + that tree.
3. **Release pipeline incomplete** — version `0.1.0`, updater `pubkey: ""`, `devtools: true`, `csp: null`, no signing/notarization pipeline documented.
4. **Legal surface missing** — AGPL in Cargo.toml only; no LICENSE file, About attribution, sample-bank notices, privacy blurb (LLM traffic, local telemetry).
5. **No CI** — no automated `cargo test` / corpus-check / UI build / release artifacts.
6. **Working tree not release-clean** — large WIP (export/rewrite/optimize), scratch files; ship only from a clean tag.

Cross-platform note: `keyring` is `apple-native` only until Windows/Linux features are enabled.

---

## 4. P1 — high-priority product gaps

### Onboarding
| Present | Missing |
|---------|---------|
| Welcome setup wizard | Guided first song (Play → prompt → edit → save) |
| Empty editor: Open / New / Examples | In-app tutorial / “what is this language?” |
| AI quick chips | Clear AI-panel empty state (key required / local model) |
| Shortcut list in welcome | Persistent Help → Keyboard Shortcuts |
| Examples list | Progressive lessons on supported DSL only |

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
1. Root README (what / screenshots / API key or Ollama / first 60s).
2. LICENSE + About attribution.
3. User quickstart (`docs/USER_GUIDE.md` or in-app Help).
4. Signed macOS build (updater optional).
5. Tag `v0.1.0-alpha` from clean tree.
6. CI: test + corpus-check + UI typecheck/build.
7. Privacy one-liner: patterns/prompts go to chosen AI provider; keys in keychain.

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
| Legacy codename | Robostrudel | Internal / old repo strings until rename lands |

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
| Keychain service (target) | `cycletron` | Migrate with settings if changing from `robostrudel` |

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

### Rename surface (when implementing)

**User-visible:** `productName`, window title, About, welcome, menus, updater, notifications, tray, AI welcome copy.

**Technical (harder later):** crate names (`robostrudel-*` → optional later), bundle `identifier`, keychain service, app data dir, updater GitHub URL, repo name (redirects OK).

**Low urgency:** prompts, corpus READMEs, AGENTS.md.

Prefer freezing **display name + bundle id + keychain** before Gate A signed alpha. Internal crate paths can lag.

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
| 2026-07-26 | **GitHub home: `nukleas/cycletron`** | Product branding + README; private repo under @nukleas. Legacy `nukleas/robostrudel` may remain as archive. Bundle id `com.nukleas.cycletron`. |

---

## 7. Immediate next work (suggested order)

1. **Brand freeze follow-through:** claim free Cycletron handles/domains if desired; sketch naderlabs.io/music/cycletron page.  
2. Gate A docs under Cycletron name: README, LICENSE, USER_GUIDE, privacy one-liner.  
3. Build story: document or vendor strudel-rs; CI green.  
4. Signed private alpha as **Cycletron** (display name at minimum).  
5. Gate B tutorial + help + updater.  
6. Code rename pass (UI strings → bundle id) when ready — not blocking private alpha if display name is Cycletron.

---

## 8. Changelog of this doc

| Date | Change |
|------|--------|
| 2026-07-26 | Initial audit notes + branding/naming section from publish-readiness review |
| 2026-07-26 | Locked working product name **Cycletron** under **NaderLabs**; availability + site placement notes |
