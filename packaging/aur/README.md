# AUR packaging

`PKGBUILD` here is the source of truth for the AUR `cycletron-bin` package —
a binary repack of the released `.deb` (issue #5). Until the AUR pipeline is
automated, an Arch user can build it directly:

```sh
cd packaging/aur && makepkg -si
```

## Publishing to the AUR (one-time setup, then automated)

1. AUR account with an SSH key → create the `cycletron-bin` package repo
   (`ssh://aur@aur.archlinux.org/cycletron-bin.git`).
2. Add the private key as a repo secret (e.g. `AUR_SSH_PRIVATE_KEY`).
3. Add a release-workflow job (e.g. `KSXGitHub/github-actions-deploy-aur`)
   that, on publish: rewrites `_tag`/`pkgver` from the tag, recomputes
   `sha256sums` from the uploaded `.deb`, regenerates `.SRCINFO`, and pushes.

Notes:
- AUR `pkgver` cannot contain hyphens: tag `0.1.0-alpha.N` → `0.1.0alpha.N`.
- Updates then flow through `yay -Syu` (which Omarchy's package TUI wraps),
  and the in-app updater stays notify-only on package installs.
