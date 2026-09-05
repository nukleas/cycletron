# AUR packaging

`PKGBUILD` here is the source of truth for the AUR `cycletron-bin` package —
a binary repack of the released `.deb` (issue #5). An Arch user can build it
directly without touching the AUR:

```sh
cd packaging/aur && makepkg -si
```

## Publishing to the AUR

`.github/workflows/aur.yml` does this on every **published** release: it
stamps `_tag`/`pkgver`/`sha256sums` from the release's `.deb`, regenerates
`.SRCINFO` with `makepkg` in an Arch container, pushes to the AUR, and syncs
the stamped `PKGBUILD` back to `master` so the copy above never drifts behind
a release.

It runs on publish rather than on the tag push, because release.yml leaves a
draft for review and a draft's assets have no working
`releases/download/<tag>/…` URL — the only kind a PKGBUILD can carry.

### One-time setup

Until this is done the workflow still stamps and validates the `PKGBUILD` on
each release; it just skips the push, and says so.

1. An AUR account with an SSH key, and the `cycletron-bin` package repo
   (`ssh://aur@aur.archlinux.org/cycletron-bin.git`). It does not need to
   exist first — the AUR creates a package on its first push.
2. Add that private key as the repo secret `AUR_SSH_PRIVATE_KEY`.

`workflow_dispatch` takes a tag, for re-running a publish by hand.

Notes:
- AUR `pkgver` cannot contain hyphens: tag `0.1.0-alpha.N` → `0.1.0alpha.N`.
  `_tag` keeps the real tag for the download URL.
- Updates then flow through `yay -Syu` (which Omarchy's package TUI wraps),
  and the in-app updater stays notify-only on package installs.
