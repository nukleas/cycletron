# Halloween, 8-bit

Graveyard is a Ghosts 'n Goblins / Castlevania yard: three terraces, grid tombs, bone sprites that climb out and cycle two or four dance frames on the beat. Held notes are Boo ghosts. Hats are two-frame bats, snares are staircase bolts, kicks hop the ground.

Haunted house is a NES mansion. Floors are registers and windows are pitch slots, each with a two-frame silhouette. Kicks open the door, hats light porch pumpkins, held notes puff chimney ghosts, the vane steps eight ways.

Ghost fog is a swamp screen with no trailFade. Pac-Man ghosts wear the track colour and leave two dim afterimages taken from their own motion. Hats are wisps, kicks are pixel ripples, snares catch the moon in the water.

All three paint a 320×180 buffer and blit it with smoothing off. Colour is a handful of solids baked from the theme (bg, a few mixes, the accent pool): no alpha and no gradients. Dither is a 2×2 checker. A 3×5 status strip is stamped in screen space along the bottom, so camera drift does not crop it, and it stays clear of the top captions.

Sprites are small bitmaps: skeletons, tombs, bats, the moon, pumpkins, ghosts. Spawns and followers run in update(); render only reads state.
