# Changelog

Each release's notes, newest first. Add to `Unreleased` as changes land; rename it to the version when tagging.

## Unreleased

### What's New
- **After an update, Cycletron shows what changed** in every release since the version you last ran. It's shown once, and not on a fresh install.
- **Help → What's New** has the notes for every release. It's also in the command palette and About.
- **The update prompt shows the new release's notes** before you install. On deb and AUR installs it shows them with a link to the releases page.

### Fixed
- Linux: animated labels in NEON CIRCUIT, MARBLE CORE, MARBLE DROP, PLASMA and TUNNEL held the frame rate to about 35 fps, because WebKitGTK loaded a new font size every frame. They now run at full speed.
- tokio 1.54.1, which fixes a race in its interval timer, plus routine dependency updates.
- Ableton Link, OSC output, Reload Corpus, the show pane's song suggestions and the after-update What's New were blocked by the app's command permissions and did nothing. They work now.

## 0.1.0-alpha.25 (2026-10-21)

Show files are easier to write, and a round of fixes, several of which stopped work being lost.

### Shows
- **Suggestions in the show pane.** As you type, the pane suggests the keys that fit where you are, and their values: modes, palettes, camera moves, transitions, the song's section names, and songs in your library for `source`. ⌃Space opens them anywhere.
- **Hover a key** to see what it does and the values it takes.
- **Help → Shows** has the full show-file guide in the app.
- **Misspellings suggest a fix:** `pallete` gives "did you mean 'palette'?".
- **New shows.** In the file tree, New File with a name ending `.show.toml` makes a show that plays the open song.
- **A show with a mistake opens** with the mistake marked, and starts playing once it's fixed.

### Fixed: losing work
- Saving reloaded the file about a second later, which could start playback or offer to discard what you'd typed since.
- After a restart, unsaved edits came back marked as saved, so opening another file dropped them without asking.
- Saving rewrote a song's frontmatter (name, tags, created date), and added a header to `.js` files.
- MIDI import could let Save write over the song that was open before.
- MP3 export deleted a `.wav` of the same name beside it.
- Edits to a set's playing song in its last bars were discarded when the next song started; they're saved.

### Fixed: other
- The volume slider was ignored when audio started; it played at 100%.
- Mixer: the M and S buttons are centered; mutes made while paused apply on Resume; after an AI edit the mixer no longer shows mutes that were cleared.
- ⌘↩ while paused carries on from where it paused, instead of restarting.
- Opening a show asks about unsaved edits before stopping anything.
- The sample set in use can't be deleted.
- Deleted demos stay deleted.
- MP3 export checks for ffmpeg before rendering, and one export runs at a time.
- Renaming a file to change only its case works on macOS.
- With AI on but no key set, chat says so instead of "AI is off".

## 0.1.0-alpha.24 (2026-10-21)

This release adds show files, which play songs as music videos, and moves the engine to strudel-rs 0.2.0.

### Shows
- **Show files.** A `*.show.toml` lists songs and what each of their sections shows: the mode, its palette, the camera, title cards, and how the code follows. Open one and it plays in Stage, section by section.
- **Cut like a video.** A section can change shots every few bars, enter each with a cut, flash, fade, glitch or black, strobe on the kick or snare, put lines and cards on screen at set times, and type its code in or fold the form beside the visuals. Letterbox, grain and scanlines can be added on top.
- **Setlists.** Several songs play back to back, each starting on the downbeat at its own tempo, with the next one loaded ahead.
- **The show pane.** The show file opens beside the song. Edits apply after a short pause; a mistake is marked on its line while the last good show keeps playing.
- **Demos.** Three shows ship in `Demos/Shows`: the Agency album as a music video, a tour of every show setting, and the Cycletron trailer, with its score in `Demos/Songs`. The format is documented in `docs/SHOW_FILES.md`.

### Visuals
- **TANK FIELD** drives a tank across a BZFlag-style field, and **STAR ROAD** races a kart down a rainbow road in space. In both, every note is placed at its onset and reached on it.
- **LOGO** draws the Cycletron icon and wordmark in ASCII, with the screen showing the spectrum, the antennae flaring on kicks and snares, and the grille following the lows, mids and highs.
- **Fixed:** code typed in by a section now lights its notes once it has typed in.

### Sound
- **strudel-rs 0.2.0.** Smoother sample playback (4-point interpolation instead of linear), `wt_` instruments that sound distinct from each other, a real-time-safe sample buffer, and a memory-safety fix in the audio engine. The engine now comes from crates.io.

### Linux
- The AppImage carries AppStream metadata with screenshots, and update info, so AppImageUpdate can update it in place.

### Also
- **Fixed:** the BPM readout shows the pattern's tempo, and the tempo readouts stay in step.

## 0.1.0-alpha.23 (2026-10-04)

Linux packaging fixes.

### Fixed
- The AppImage is packed with readable directory modes, so it runs for users other than the one who extracted it.

## 0.1.0-alpha.22 (2026-10-03)

The original visualizer modes, rebuilt to follow the music, and sample sets that finish when the internet has moved a file.

### Visuals
- **The early modes, brought up to date.** KALEIDOSCOPE, ASCII SCOPE, LISSAJOUS, PLASMA, NEON CIRCUIT, TUNNEL, MATRIX RAIN, MARBLE CORE, MARBLE DROP, FLAME GRAPH, WAVE TERRAIN, ATTRACTOR, ISO CITY and SPOT FIELD now read the schedule instead of guessing from the spectrum: flat fills and fine outlines in theme colours, sized to the canvas, and a resize no longer restarts the mode.
- **NEON CIRCUIT** is an isometric circuit board: one package per track, chosen by what it plays, with pulses that land on the input pin on the onset.
- **TUNNEL** shows notes approaching from two bars out and landing on the gate on their onset. **LISSAJOUS** locks to the bass note.
- **Fixed:** KALEIDOSCOPE left half its wedges empty. ASCII SCOPE and LISSAJOUS went blank when the analyser stalled; they now rebuild the beam from the schedule.

### Sounds
- **Sample sets survive dead links.** A file that is gone upstream (a 404) no longer sinks the whole set. It is dropped, the rest of the set goes active, and the Samples window names the banks that were lost. Network errors still leave the set resumable. The strudel.cc defaults now install with 1,900 of 1,908 files instead of failing outright.

### Under the hood
- Tauri 2.11.6 and updater plugin 2.12, plus routine dependency updates.

## 0.1.0-alpha.21 (2026-09-22)

### Fixed
- Visuals froze on macOS 15 and earlier. That WebKit has no `AudioContext.outputLatency`, and the missing value made every visual's position NaN. Audio was unaffected.

## 0.1.0-alpha.20 (2026-09-17)

A cockpit you fly the schedule through, a browser for every sound you have, and a way to turn a downloaded zip into banks you can play.

### Visuals
- **COCKPIT.** A vector flight display you sit inside. Distance is musical time: an event is planted two bars out and reaches the glass exactly on its onset, so you watch the beat coming rather than watching it arrive. Two forward cannons lead each target and destroy it on the downbeat. The rail beneath reads the mix — SIGNAL BANK is one row per track, so a part that drops out goes flat where you are already looking, and CYCLE SCAN sweeps once per *cycle*, which lands four-on-the-floor at 0/90/180/270.

### Sounds
- **Sound Browser.** A searchable catalogue of every bank you have, virtualized so it stays usable past a thousand entries. Drum machines browse as machines rather than as concatenated voice names — `RolandTR909` opens into its voices, which is the unit you actually type. 683 flat rows become 71.
- **Sample-pack import.** Drop a `.zip`, review the bank mapping it inferred, then commit it. Flat folders group into banks instead of one bank per file, and a curated list of free sources is built in.
- A set's download state is stated outright in the manager instead of implied by a dim label beside a disabled radio.

### The assistant
- **Editor-aware analysis.** `inspect_pattern`, `analyze_arrangement`, `critique_pattern` and `critique_form` default to the editor document when no code is passed, so the agent stops analysing toy snippets instead of your actual track.
- **Chain-suffix edits.** Tracks can be addressed by index and edited with a chain suffix rather than re-streaming a whole dump.
- **A real level model.** Levels account for gain x velocity x distortion output trim, pinned against the engine's own formula, so balance findings read modelled loudness rather than raw gain. A `shape()` that `dist()` renders dead is now flagged.
- **Fixed:** `append_chain` could land its suffix inside a trailing comment — commenting the edit out while still reporting success.

### Fixes
- Each sample source gets its own cache directory; a truncated name could previously collide two sources onto one.
- Editor completions carried the wrong `clip` signature: it is a note-length multiplier, not a clipper.

## 0.1.0-alpha.19 (2026-09-13)

Two visualizer modes, and an assistant that knows when to stop editing.

### Visuals
- **FOREST DRIVE.** A night drive down a country road where every hap plants a tree: pitch sets the height, duration the canopy, the track its species and colour. The headlights flash as you pass each one.
- **LENS BENCH, rebuilt.** Traces five pupil-aimed field points through real prescriptions — a Cooke triplet and a Double Gauss from the Zemax sample library — plus a 4x riflescope and a telephoto. Field angles stay physical; the music opens and closes the pupil.

### The assistant
- **Rewrite budget.** Each section, track or binding can be rewritten at most twice per request. Telemetry showed one "make the drop harder" request rewriting its sections five times across nine turns; the third take is now refused so it plays what is there and lets you judge.
- **`[note]` findings are advisory** — observations to report, not defects to chase. Only `[warn]` needs fixing before play.
- **Fixed:** a closing `play()` after surgical edits could silently revert the whole request by falling back to the pre-edit reviewed buffer.

### Sounds
- Multi-variant default kit: Fischer 808 takes for bd/sd/oh/cr/toms/congas, plus hats, ride, rim, shaker and tambourine, so `s("hh:2")` and `s("rd")` work offline. Index 0 of every bank is unchanged.
- MIDI Lab gains optional re-trigger merge and grid snap, off by default. Drums are never merged.

### Fixes
- Radios, checkboxes and select menus are themed instead of falling through to OS chrome.
- Transport and header glyphs are SVG now, so Linux stops drawing them as yellow emoji tiles.

## 0.1.0-alpha.18 (2026-09-06)

The assistant learns to hear, and shows its work. Plus a new vector visualizer mode, a chat fix, and the Linux packaging groundwork from the last few days.

### The assistant shows its work
- **Tool rows in the chat.** Every tool the assistant calls now appears as a small collapsed row above its reply: the tool, a one-line result, a red category chip when it failed, and how long it took. Open a row for the exact input and the full result. Rows are restored with the session.
- **Typed results under the hood.** Every tool now returns a structured outcome (ok, category, retryable) that reaches the model on every provider, including OpenAI-compatible and local ones that previously lost the error flag. Fail-closed writes, the review budget and the full-rewrite guard are real failures with a category now, so the assistant retries with different input instead of re-reading prose.

### The assistant can hear
- **`hear_pattern`.** The assistant can render a pattern offline through the real engine and measure it: an FFT of the mix and of each stem, per band, next to the symbolic estimate the review makes without listening. It reports a pink-weighted level per band (the view a spectrum analyser shows), centroid, peak, rms, crest, clipping, and a verdict from the render itself: dull, top-heavy, low-heavy, hollow, no sub, quiet, clipping. It is budgeted to two renders per request and the assistant is told to use it after a review raised balance notes or when you say the mix sounds off, not on every edit.
- Rendering uses the same sample set live playback does, so what it hears is what you hear.

### Visuals
- **VECTOR NEXUS.** A new ambient mode in the vector-display idiom: an instrument reticle of rings and ticks, a mirrored spectrum sweep, three counter-rotating arcs, and an icosahedral wireframe that breathes with the bass, stretches on the mids and ripples on the treble. No particles, no blur, allocation-free per frame.

### Fixes
- **Clear AI Session** (chat New, Edit menu, palette) now clears only the conversation. It used to forget the open file too and draw the "No file open" overlay over your code.
- **Linux:** the X11 program class now matches the Wayland app id, so bars and launchers pair the window with its desktop entry either way. The AppImage pins its GStreamer sinks and the build asserts they shipped.
- The updater feed for alpha.17 pointed at a re-uploaded asset; the feed is regenerated cleanly on each release now.

### Packaging
- Publishing `cycletron-bin` to the AUR is wired into the release workflow (`packaging/aur/`). It stamps and validates the PKGBUILD on every publish; the push to the AUR itself starts once the AUR deploy key is in place. Until then, `cd packaging/aur && makepkg -si` builds the current release on Arch.

## 0.1.0-alpha.17 (2026-09-05)

A performance release: a fullscreen Stage Mode built for recording and streaming a set, a real master bus so captures come out clean, launch quantization with a mixer, Ableton Link and OSC, an engine bump, and instruments that work offline.

### Stage Mode (⌘⇧F)
- **One clean frame.** The visualizer full-bleed with your pattern drawn on top of it, at a locked 1080p / 1440p / 4K output letterboxed into the window. Resizing only moves the black bars, so an OBS window capture stays a stable 16:9. Notes glow in the code as they fire; a small readout shows mode, BPM and cycle.
- **Code size** has four steps (Visuals menu, or ⌘+ / ⌘− live on stage). Smaller text narrows the code column and hands the frame back to the visuals.
- **Follow the Music.** A long-form pattern (`pickRestart`, `arrange`) no longer needs scrolling to show the audience what is playing. Two ways to show it, switchable live: **Fold Idle Sections** collapses every section that isn't sounding to one dim row and keeps the playing one near the top; **Playing Section Only** shows a breadcrumb of the form with the current section bracketed, then just that section's code. The section you are editing stays on screen too.

### Playing with others
- **Launch quantization.** A **Q** button in the transport holds each evaluate until the next 1/2/4/8-bar boundary instead of swapping mid-phrase, with a countdown while a swap is parked.
- **Mixer.** A sidebar panel listing the `$:` tracks in the buffer with mute and solo per track; moves follow the launch grid and the buffer is never modified.
- **Ableton Link** tempo and phase sync, and **OSC output** of events for visual rigs and external instruments.

### Recording
- **Master bus.** The volume slider now drives monitoring downstream of the capture tap, so a recording is always at unity no matter where your monitors sit. The metronome moved to a cue bus, so a click never ends up in a VOD.
- **Lossless streaming capture** writes as it goes, so long takes no longer run out of memory.

### Linux desktop
- Transport verbs from the tray, global shortcuts, and `cycletron play|pause|toggle|stop|tempo N` on the command line, without raising the window. **MPRIS** exposes playback state to bars and media keys, and the palette can follow the desktop theme. Built with Omarchy's Quickshell bar in mind.

### Engine: strudel-rs 07b4550
- Stepwise family (`pace`, `expand`, `contract`; `fast`/`hurry` keep step counts), `arp` with Tidal's named orderings (`up`, `down`, `updown`, `converge`, `pinkyup`, …), `ribbon`, `beat`, `press`/`pressBy`, PWM (`width`/`pw`, `pwmrate`, `pwmdepth`) and `phaser`/`phaserdepth`.
- MIDI import auto-resolution is robust to humanized timing.
- The AI system prompt was corrected for the dialect (arrow parameters in parentheses parse, commas inside `< >` split slots, `setcpm`, `arrange`) and taught the new engine surface.

### Sounds
- **Sample sets** in the Samples manager now match strudel.cc: `strudel-cc`, `drum-machines` (71 kits), `vcsl` (128 instruments) and `mridangam`, downloaded per source and shared between sets. The sound catalog carries the full General MIDI map.
- **26 VCSL instruments ship in the app** (CC0, 3.7 MB) and work offline: kalimba, marimba, vibraphone, glockenspiel, tubular bells, balafon, harp, ocarina, recorder, harmonica, a Steinway, gong, timpani, hand percussion and more. Pitched banks are note-mapped, so `note("c4 e4 g4").s("kalimba")` plays in tune.

### Visualizer
- **LENS BENCH** now focuses. Focal length, f-number and the image plane are derived from the ray trace rather than typed in; the fast condenser images at the circle of least confusion, the diverging lens shows its virtual focus, and the Keplerian pair marks its internal focus.

## 0.1.0-alpha.16 (2026-08-23)

A visuals release: two new immersive modes, a livelier ISO CITY, and an editor fix that makes autosave work the way you assumed it already did.

### Two new visualizer modes
- **LENS BENCH** — a blueprint-style optical bench that ray-traces real lens designs (a Fraunhofer achromat, a Cooke triplet, and a Kingslake double Gauss) live on screen. Your pattern drives it: notes travel the rays as light pulses, kicks flare the focal point, bass widens the beam fan, and the trace splits into chromatic color fringes as the highs come up. Designs rotate every 16 bars.
- **SPOT FIELD** — every track becomes a cloud of ray spots orbiting the optical axis, smeared into spirals by long-exposure trails. Hits burst the clouds open, kicks defocus the whole field and fire rings from the center.

### ISO CITY, now with traffic worth watching
The streets are drawn as glowing conduits with light packets streaming along them in time with the beat, and the cars finally look like they're going somewhere: comet trails, per-drum classes (kicks send heavy magenta freight at street level, hats send small cyan couriers on a raised lane), and the occasional flickering broken-neon glider.

### Editor fixes
- Dirty-file marking, autosave, and the "No file open" overlay all listened to an editor hook that never fired. Typing now marks the file dirty and triggers autosave as intended, and the overlay no longer covers a restored session.

## 0.1.0-alpha.15 (2026-08-21)

Two fixes that matter most when you're actually playing.

### Live coding feels right again
- **No more stumble on evaluate.** Every code update — including live keystroke evaluation — was flushing the audio engine's ~300ms lookahead buffer and skipping notes until the next scheduler tick, even when the tempo hadn't changed. Edits now hot-swap gap-free, and a genuine tempo change refills the queue within milliseconds instead of leaving a hole.

### Updates that actually restart
- **The updater now relaunches the new version.** On macOS, installing an update moves the running app aside before dropping the new one in place — and the old relaunch path booted that stale copy from its temp folder (if alpha.14 seemed to "stop at restarting", this was it). The app now reopens the installed bundle directly. If you're on alpha.14, this update may still restart into the old copy one last time — just quit and reopen from Applications.
- Linux deb/rpm installs are now correctly detected as package-manager-owned and point you at the releases page instead of failing silently.

## 0.1.0-alpha.14 (2026-08-21)

Downloadable sample sets and a city that plays your music.

### Sample sets
- **Downloadable sample sets**: pick between the bundled Cycletron kit, the classic Strudel sources (Dirt-Samples, tidal-drum-machines, EmuSP12, and friends), or your own manifest list — downloaded straight from upstream to your machine, with resume and progress.
- **Live and export finally agree**: playback and WAV/MP3 export now resolve sounds from the same active set's manifests, so what you hear is what you render.
- Switch sets from Preferences or the command palette; missing banks lazy-load as your pattern references them.
- Unpitched samples now repitch from an assumed C3 root when used with `note()` (superdough parity), courtesy of an engine update.

### ISO CITY visualizer
- New ambient mode: an **isometric neon city built from your pattern**. Every sound gets its own district — kicks are heavy slabs, snares are wedges, hats are antennas, and melodic tracks raise towers as tall as their notes.
- Buildings light up in sync with the schedule (not FFT guesswork), districts rise as you add sounds and demolish when you delete them, and bass/mids/highs drive the floor grid, street traffic, and skyline glow.
- Respects your pattern's `.color()` hints for district colors. Cycle to it with `]` or the Visuals menu.

### Also in this release
- Eight new genre demo songs (2-step garage, acid house, amapiano, ambient, dub techno, liquid DnB, synthwave, trip-hop) with matching gated corpus examples.
- Sturdier visualizer internals: the sequence grid no longer shares query state with other visualizations.

## 0.1.0-alpha.13 (2026-08-17)

The biggest update yet: a new engine, smarter MIDI import, and a much faster assistant.

### Engine upgrade (strudel-rs, 68 commits)
- **New pattern engine core** — allocation-eliminating combinator chains and mini-notation parser speedups across the board.
- **Reworked randomness** — `rand`/`degrade`-flavored patterns sample more evenly (and will sequence differently than in alpha.12, by design).
- **Interleaved sample playback** and **negative `speed()`** support (reverse sample playback).

### MIDI import, cleaned up
- **Note cleanup before conversion** (on by default, source `.mid` never touched): drops sub-1/32-beat ghost notes, removes duplicate/overlapping hits, and tames wild velocities — with a per-import report of what was cleaned.
- **MIDI Lab analysis strip**: duration, note count, pitch range, polyphony, channels, and GM programs at a glance, plus per-track pitch ranges.

### Export that knows how long your song is
- The WAV/MIDI export dialogs now detect **one full play-through** — section forms (`pickRestart`), long loops (up to 1024 cycles), or "play to the end" — and label how they decided.

### A faster, sharper assistant
- **Pattern reviews are ~3× faster** (the review pipeline now evaluates your pattern once instead of up to seven times) and corpus search is ~3× faster too.
- Expanded **house** recipe (deep/Chicago sections) and a new chicago-house showcase piece; corpus now at 297 gated examples.

### Under the hood
- Major dependency refresh (TypeScript 7, Vite 8, reqwest 0.13, toml 1.x among others) and a large internal restructuring with stricter CI (clippy/fmt gates, full workspace tests, criterion benchmarks).

## 0.1.0-alpha.12 (2026-08-17)

### Fixes
- **UI polish pass** (thanks to fusion for the reports) — styled, accessible tooltips replace the clipped native ones; scrollbars are consistent across the sidebar, editor, menus, and panels; and the visualizer no longer bounces when swapping songs.
- **Song-swap correctness** — switching songs mid-play can no longer paint the old pattern's note highlights onto the new file, and a stale keystroke timer can't revert playback to the previous pattern.
- **Shortcut fix** — the focus-window shortcut moved off `Cmd+Shift+R` (which shadowed the system-wide hard refresh) to `Cmd+Shift+Comma`.
- **Tighter house percussion** — generated house patterns use grid-anchored click percussion instead of floating euclids that drifted off the beat.

### Security
- Dependency bumps past npm audit high advisories (vite, postcss, nanoid). Dependabot is now enabled on the repo to keep this automatic.

## 0.1.0-alpha.11 (2026-08-12)

### Fixes
- **Audio startup watchdog** — if audio init stalls, you now get an error screen instead of a silent hang.
- **Windows dev setup works out of the box** — the frontend build commands no longer assume a POSIX shell, and a bin/lib artifact name collision warning on MSVC is gone. Thanks to fusion for the report.
- **Better genre percussion** — the assistant no longer pads every genre with generic percussion banks; patterns stay true to the genre recipe.

### Performance (Linux especially)
- **Native Wayland by default** when a compositor is present — smoother frame pacing than XWayland. `CYCLETRON_FORCE_X11=1` is the escape hatch.
- **GPU tile painting** on WebKitGTK 2.48+ instead of burning a CPU core on raster threads.
- **Visualizations run at full frame rate** (previously capped at 30fps when ambient), and pause entirely when not visible.

## 0.1.0-alpha.10 (2026-08-11)

### Fixed
- The AppImage played no sound. It now bundles the GStreamer media framework that WebKitGTK uses for audio output.

## 0.1.0-alpha.9 (2026-08-10)

### Fixed
- The AppImage crashed on startup on rolling distros. Its bundled Wayland libraries shadowed the system ones that Mesa needs; they're removed.

## 0.1.0-alpha.8 (2026-08-10)

### Updates
- A progress toast shows while an update downloads and installs.
- deb, rpm and pacman installs can't update themselves. The app now says an update is available and links to the releases page instead of failing silently.

### Packaging
- Arch: `cycletron-bin` AUR package.

## 0.1.0-alpha.7 (2026-08-10)

### Fixed
- Linux: audio never started, because WebKitGTK keeps SharedArrayBuffer behind a runtime flag. The app turns it on at launch.

## 0.1.0-alpha.6 (2026-08-10)

First public build: the strudel-rs live-coding editor with transport, visuals, a file library, MIDI import and an opt-in AI assistant.
