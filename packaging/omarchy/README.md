# Cycletron on Omarchy

[Omarchy](https://omarchy.org) 4 ("Quattro") runs its desktop as a single
Quickshell process where the bar, the panels, and the overlays are all plugins.
That makes it the one Linux desktop where Cycletron can sit *in* the shell
rather than beside it. This directory holds the pieces that go on the Omarchy
side of that.

Everything here is optional and additive — Cycletron needs none of it to run.

## Install Cycletron

Arch and Arch-derived systems build from the PKGBUILD one directory over:

```bash
cd packaging/aur && makepkg -si
```

That puts `cycletron` on your `PATH`, which is what the keybindings and the bar
widget below both drive.

## The bar widget

[`omarchy-cycletron`](https://github.com/nukleas/omarchy-cycletron) is a
first-party bar plugin: tempo and cycle position while a pattern runs, click to
play/pause, middle-click to hush, scroll to nudge the tempo.

```bash
omarchy plugin add https://github.com/nukleas/omarchy-cycletron.git --enable
omarchy bar move nukleas.cycletron center
```

It reads `$XDG_RUNTIME_DIR/cycletron/state.json`, which Cycletron keeps for
exactly as long as a session lives, and sends commands back through the
`cycletron` binary. It never touches audio.

You may not need it: Cycletron announces itself over MPRIS, so Omarchy's
built-in `omarchy.media` widget, the OSD, and the media keys already work.
The plugin exists for what MPRIS has no field for — tempo, cycle position,
and hush.

## Keybindings

[`bindings.lua`](bindings.lua) has a transport set to paste into
`~/.config/hypr/bindings.lua`. None of them raise the Cycletron window, which
is the point: a hotkey should change what you hear, not what you are looking
at.

| Binding | Does |
|---------|------|
| `SUPER + ALT + SPACE` | play / pause |
| `SUPER + ALT + H` | hush |
| `SUPER + ALT + ↑ / ↓` | tempo ± 2 BPM |
| `SUPER + ALT + C` | raise (or start) Cycletron |

## Theme

Cycletron can follow the Omarchy theme: turn on **Follow desktop theme** in
Preferences and it reads `~/.local/state/omarchy/current/theme/colors.toml`,
repainting itself whenever you switch themes. It is off by default — the neon
palette is Cycletron's own, and matching your desktop should be a choice rather
than something that happens to you.
