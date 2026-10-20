# Tank Field

`ui/src/viz/modes/tank-field.ts` is your tank on a BZFlag field, seen from a
chase camera just above and behind it. As in COCKPIT and FOREST DRIVE, distance
is musical time. Each hap sits at `onset × 50` world units, the camera advances
at `cycle × 50`, and every object reaches the firing line, 22 units ahead of
your tank, on its onset. The scheduler
already applies BPM, so a tempo change speeds up the drive without moving any
note.

The scene uses Cycletron's night-time instrument palette: a theme-tinted sky
and horizon haze, dark mountain silhouettes, a restrained ground grid, and
slate architectural solids. Track colors identify tanks, shots and musical
activity; the player's steel hull has a fine accent strip. The shared chase
HUD (`viz/modes/drive-hud.ts`) follows COCKPIT's thin borders, chamfered plates
and compact monospaced readouts. Everything is drawn procedurally.

| Signal | Object | On its onset |
| --- | --- | --- |
| Kick | Enemy tank ahead, at most 8 per track in view | Your turret swings onto it and the bolt lands: fireball, fragments, team-colored death ring |
| Snare / clap / toms | Pale superflag on a pole beside the lane | Grabbed: a white flash, and a BZFlag flag name top-right |
| Other percussion | Teleporter gate (steel frame, dark field) on the flanks | The field flashes in the team color as you pass |
| Hat / shaker / ride | Nothing until it sounds | A small spark on the grass |
| Short pitched note | Slate pyramid, height from pitch | Faces flash in the track color |
| Sustained note | Architectural box as long as the note (capped at a bar), height from pitch | Top and sides flash; you drive alongside it |

Bolts leave your barrel on a cycle-based lead that covers the muzzle-to-target
distance at BZFlag's shot speed (100 wu/s). The impact is always the scheduled onset,
including through tempo changes. At most 16 bolts are drawn and 40 bursts stay
alive. A burst rides along with the tank and closes slowly, so driving never
carries the eye into an explosion. Stopping or seeking clears bolts and bursts,
and nothing fires on a jump.

Objects are keyed by absolute onset. A query-clipped part that continues a
held note across a bar line extends the existing object instead of firing again.
Live edits fade removed objects, and an object that is fading can't fire.

## HUD

- **Header:** mode, live/idle sync state, hit count and bar.beat clock. The last
  grabbed flag appears below the clock.
- **Reticle:** fine theme-colored corner brackets, a small central square,
  heading and altitude tapes, and three shot meters. The next tank's bearing
  is marked in its track color.
- **Signal bank:** track labels and hit counts in a compact top-left plate.
- **Radar:** a forward-up scan in the lower-left corner, with range rings,
  buildings, tanks, flags, bolts and a heading marker.
- **Event log:** up to four recent events in a lower-right plate, leaving the
  player and firing line clear.

The signal bank hides below 860 CSS pixels wide or 420 tall, the event log
below 580 wide, and the reticle below 420 tall. Geometry is drawn at the
host's resolution, including DPR 2 and Stage Mode's fixed-resolution canvas
(scaled from a 1080 reference).

Every random choice comes from `hash32`/`rand01`. Sway is a function of the
camera position and the flag motion of accumulated time, so `npm run test:render`
matches across chunk seams.

Validation: `npm run build`, `npm run test:render`, then a visual review with
live drums plus melody, stopped playback, a tempo change mid-play, dense chords,
a narrow pane, and DPR 2.
