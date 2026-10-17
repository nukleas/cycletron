# Star Road

`ui/src/viz/modes/star-road.ts` is a kart race on a rainbow ribbon in deep
space, in the spirit of the N64-era rainbow roads. Everything is original: no
game characters, logos or textures. Distance is musical time. Each hap sits at
`onset × 56` meters (28 m/s at 120 BPM), the camera advances at `cycle × 56`,
and your kart reaches every object on its onset. The scheduler already applies
BPM.

The road is a dark prismatic ribbon with blended spectral bands, a subtle
central reflection, continuous cyan/magenta edge lights and sparse amber star
markers. It bends and climbs as a fixed function of distance, and the camera
banks into the bends. A sparse layered starfield, soft nebulae and restrained
neon signs sit behind the course. Road haze, rails and HUD accents follow the
show palette. Karts use shaded metal bodies and illuminated trim; item boxes
use dark tinted glass with fine colored edges.

| Signal | On the road | On its onset |
| --- | --- | --- |
| Kick | Dash panel: amber field, pale chevrons sliding forward | Boost: exhaust flame, wider field of view, speed lines, the star fence pulses |
| Snare / clap / toms | Item box: spinning tinted-glass cube with a `?` | Shatters; the item slot rolls and lands on a star, bolt, shield or arrow; the neon signs flare |
| Hat / shaker / ride | Coin on your line | Collected; the coin count goes up |
| Other percussion | Rainbow ring standing over the road | You drive through it; it flashes |
| Pitched note | Tile in the track color, placed across the road by pitch (low on the left), as long as the note | Lights up |
| Held note (half a bar or more) | Drift | Sparks climb blue, orange, purple with time held; when the note ends, the tier reached fires a mini-turbo |

Your kart takes a smooth line through the panels and boxes ahead, and coins are
laid on that line. The chase camera follows the road, lagging a little behind
the kart. Each unpitched drum track is a rival kart in its track color. It
holds a loose position near you and surges ahead when its track plays, so the
place readout follows the mix.

## HUD

The shared chase HUD (`viz/modes/drive-hud.ts`) uses the same chamfered plates,
fine borders and monospaced readouts as TANK FIELD:

- **Header:** mode, sync state, lap count and elapsed musical time.
- **Top left:** a compact running order, with the player row highlighted.
- **Top centre:** a small item slot with the original roulette glyphs.
- **Bottom left:** position, coin count and drift/boost charge.
- **Bottom right:** a quiet course trace with colored racer dots.
- **Final lap:** a small transient plate below the item slot.

The running order hides below 580 CSS pixels wide or 420 tall. Views below
480 wide or 380 tall use a single compact footer for position, coins and
charge, and hide the map. The item slot hides below 300 tall.

Sparks, flames, speed lines, coin spin and sign blinks are functions of time
and `hash32`. Bursts and the kart's state come from onsets. `npm run test:render`
matches across chunk seams.

The schedule comes from `viz/hap-field.ts`, shared with TANK FIELD: two bars
of haps keyed by absolute onset, with held notes extended across bar lines
instead of firing again.

Validation: `npm run build`, `npm run test:render`, then a visual review with
drums plus melody, held bass notes (drift tiers), stopped playback, a narrow
pane, and DPR 2.
