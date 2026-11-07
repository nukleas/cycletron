# cycletron.naderlabs.io: product site plan

A site for Cycletron itself: what it is, how to get it, what changed, how to
use it, and examples you can hear. It lives in this repo under `site/` and is
built from the files it describes, so it can't drift from the app.

naderlabs.io stays the portfolio. It keeps a Cycletron project card and
page, which tell the engineering story and link here.

## Principles

- **Describe the build people can download.** The site deploys when a release
  is published, from that release's tag. A draft or tagged-but-unpublished
  version never appears.
- **The repo is the content.** The changelog is `CHANGELOG.md` (every entry
  up to the version being built), the guide is
  `docs/USER_GUIDE.md`, the examples are what `src-tauri/src/demos.rs` seeds
  into `Demos/`. No copies, no sync script.
- **Plain, factual copy.** No counts used as selling points, no marketing
  adjectives. The AI assistant is mentioned once, as off by default. The
  not-affiliated-with-Strudel line sits under the first demo. Covers are
  credited to the original artist.
- **Static pages, and the app.** Site pages are plain HTML with one small
  script; everything interactive is Cycletron itself, at `/play`.
- **Its own look.** The site is themed after the app and its visualizers, not
  after naderlabs.io: the app's palette and type, and the visualizers
  themselves on the page wherever they can run (see Visuals).

## Pages

| Path | Content | Source |
| --- | --- | --- |
| `/` | Two sentences, the demo, download for the visitor's platform with the other three visible, links to examples and the guide (rules below) | written for the site; release data |
| `/download` | Every installer with size and signing (macOS signed and notarized, 10.15+; Windows unsigned, SmartScreen: More info → Run anyway); Linux AppImage and .deb (with its `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1` dependencies); Arch via `packaging/aur` (`makepkg -si`) until it is on the AUR; how updates work; the README's Privacy section; licence; a link to the guide's Troubleshooting | release assets; `src-tauri/tauri.conf.json`; README; `docs/USER_GUIDE.md` |
| `/changelog` | Every published release, newest first, one anchor per version | `CHANGELOG.md`, entries with a published release |
| `/guide` | The user guide | `docs/USER_GUIDE.md` |
| `/guide/shows`, `/guide/dialect` | Show files and the dialect notes | `docs/SHOW_FILES.md`, `docs/DIALECT.md` |
| `/examples` | Everything the app installs into `Demos/`: Songs, Shows, Techniques, Genres | `ui/songs`, `ui/shows`, `corpus/{rhythm,…}`, `corpus/genres` (the `demos.rs` mapping) |
| `/examples/<slug>` | One example: title, the `Demos/` path, BPM, "Play in Cycletron" (opens `/play`), the code | same |
| `/play` | The app itself, with the library in its file sidebar | `ui/` web build |
| `/demos` | Recordings from the NaderLabs YouTube channel | a hand-kept list (titles verbatim) |
| `/packs` | Each pack: description, a mode tour, its shows and songs (with each song's credit line) opening in `/play` | `../cycletron-packs` (`CYCLETRON_PACKS`); `docs/PACKS.md` |

No FAQ, troubleshooting or requirements pages: the guide has Troubleshooting
and `/download` states the requirements.

Links between docs: `./DIALECT.md` and `./SHOW_FILES.md` go to the site's own
pages; the rest (`./SAMPLE_PACKS.md`, `./STRUDEL_RS_SUPPORTED.md`) go to GitHub
at the tag. The changelog and guide render verbatim as markdown; the site does
not rewrite the repo's own docs.

## The app in the browser (`/play`)

The examples, shows and packs play in Cycletron itself, not a cut-down
player: `npm run build:web` in `ui/` (`vite build --mode web`, base `/play/`)
builds the real app, with the editor lighting notes as they play, the
visualizers, the sequence grid, Stage and shows. Verified in Chromium on
2026-11-06: Night Signal plays with Neon Circuit; the Christmas pack's Jingle
Bells show and the Harvest pack's mode tour play with the packs' own
visualizers; no console errors.

- **Backend commands in a browser.** Every desktop call goes through
  `ui/src/tauri.ts`. In the web build, `invoke` answers the read-only ones
  itself (`ui/src/web-backend.ts`): `get_library_root`, `list_library`,
  `open_file`, `read_song`, `read_text`, `list_library_songs`,
  `list_viz_packs`, `song_form`, `get_recents`, `get_current_file`. Anything
  else still throws "Tauri not available", as it does in a plain browser.
- **The library** is a read-only copy the site build writes to
  `/play/library/` with an `index.json`: `Demos/` exactly as `demos.rs` seeds
  it, and `Packs/<id>/` with each pack's songs, shows, built visualizers, and
  its probe show as a mode tour (only when every song the probe plays is
  published). The file sidebar browses it; `?open=<path>` opens a song or
  show, and the site's example and pack pages link that way.
- **Hidden in the web build** (`ui/web.css`): the File menu and saving, export
  and recording, MIDI, the AI panel, choosing a library folder, managing
  sample sets. Edits play but aren't saved.
- **Desktop browsers only.** It is the desktop layout; pages say so.

**Debt: the song form.** Shows need a song's section form, which the desktop
computes in Rust (`pickrestart_sections`, crates/cycletron-analysis/src/form.rs).
The web build has a TypeScript port (`songForm` in `ui/src/web-backend.ts`),
checked identical on all 154 library songs on 2026-11-06. Keep them in step,
or retire the port by exposing the Rust function from a WASM build.

**Cross-origin isolation.** The engine needs `SharedArrayBuffer`, so `/play`
is served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. Site pages are not, so `/` and
`/demos` can embed YouTube.

## Build

- **A build script, not a framework.** `site/build.mjs` reads `CHANGELOG.md`,
  the docs and the `demos.rs` paths, renders markdown with `marked` (already a
  `ui/` dependency), and writes static HTML with shared layout templates. If it
  grows layouts and plugins beyond that, move to Astro then.
- The app's web build (`ui/dist-web`) and the samples it loads are copied
  into the site output under `/play/`, with the library beside them.
- Release data (version, date, installer URLs and sizes) is read from the
  GitHub API at build time, for the tag being deployed.
- Look: the app's own palette and type (`ui/style.css` tokens: dark glass,
  cyan accent), so the site looks like what people download. No dependency on
  naderlabs.io's cyberdesign.

## Deploy

- A Vercel project `cycletron-site` with Git integration off (or every push
  to `master` deploys). `site/vercel.json` sets the isolation headers for
  `/play` and everything under it.
- A new workflow, `.github/workflows/site.yml`, `on: release: types:
  [published]` like `aur.yml`: check out that tag, build the app and the
  site, `vercel deploy --prod`. Not part of `release.yml`, which runs on the
  tag push and only creates a draft whose assets have no working download
  URLs yet. Needs `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
  The job sets `SITE_TAG` to the tag and passes `GITHUB_TOKEN` (the build
  reads the release from the GitHub API). `site/dist` is gitignored and the
  Vercel CLI honours `.gitignore`, so deploy the built output with
  `vercel build` then `vercel deploy --prebuilt --prod`, not a plain
  `vercel deploy`.
  The packs come from `nukleas/cycletron-packs` master, checked out next to
  this repo and built with `cycpack build` against the tag's viz SDK. Every
  pack on master is on the site; `_` folders stay out.
- Vercel: project `cycletron-site` (`prj_Vt3R3IHpb20vTdky2b3u8CluCs2Z`) in
  team `nader-heidaris-projects` (`team_5XiWyW9dSiDtzixPo72oCdmf`), created
  from the CLI with no Git connection; `cycletron.naderlabs.io` is attached.
- DNS: naderlabs.io's DNS is at Namecheap. `cycletron.naderlabs.io` CNAME
  `cname.vercel-dns.com`, as `music.naderlabs.io` is. Added by the maintainer.
- Preview: `npm run dev` in `site/` for local work; Vercel previews from the
  CLI when wanted.

## naderlabs.io after this

- The `/cycletron` section built on naderlabs.io's `feat/cycletron-section`
  is dropped; its signed-off copy and example layout move here.
- `/projects/cycletron` stays as the portfolio page (architecture,
  generators), with a prominent link to cycletron.naderlabs.io once it is
  live. The projects card and footer link there too.
- `/videos` keeps the whole channel.

## Phases

1. **Scaffold.** `site/build.mjs`, the layout and palette, `/`, `/download`,
   `/changelog`, `/guide`, `/guide/shows`, `/guide/dialect`. Runs locally.
2. **Examples.** `/examples`, `/examples/<slug>`. Done.
3. **Demos.** `/demos` with click-to-load posters. Done.
4. **The app in the browser.** `/play`, the web backend, the library in the
   sidebar, shows playing. Done.
5. **Packs.** `/packs` from `cycletron-packs`, playable in `/play`. Done.
   `cycletron-packs` is public; every pack on its master is on the site.
6. **Deploy.** Vercel project, `site.yml`, DNS. The first deploy is the first
   published release whose tag contains `site/` and the web build: merge, cut the
   next release from that commit, publish. No deploy from alpha.25 or
   alpha.26; neither tag has the web build.
7. **naderlabs.io links.** The projects card, footer and `/projects/cycletron`
   link to the site; no top-nav item. The portfolio page's lede becomes one
   sentence and the link.

## Home page rules

- First screen: the demo and the download for this platform. The text is at
  most two sentences: a desktop app for macOS, Linux and Windows; write
  Strudel-style patterns, press Cmd+Enter, edits take effect on the next
  evaluation, no compile step.
- The affiliation line once, under the demo: strudel-rs, not affiliated with
  Strudel.
- The AI assistant is one clause, off by default. No section.
- No feature grid, no "built for", no counts, no cyber / neon / jack in /
  matrix copy. The look carries the aesthetic; the words stay plain.
- All four installers on the page, the visitor's platform as the primary
  button. On a phone: "Cycletron is a desktop app" and the four links.
- The engineering story stays on naderlabs.io.

## Decided

- **First release on the site:** the first published tag containing `site/`
  and the web build, cut from current master (so alpha.26's 909 kits, Link and
  OSC are in it and the guide is true of it).
- **Covers in the examples:** the site shows the tag's `Demos/`; adding
  covers back is an app change and a release.
- **Platform detection:** user agent picks the primary button; all four are
  always listed, with sizes and signing on `/download`.
