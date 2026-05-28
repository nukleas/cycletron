// Ambient Drift - Atmospheric pads
// Slow, evolving textures
// 80 BPM

setBpm(80)

stack(
  // Deep drone
  note("[c2,g2]")
    .s("sine")
    .attack(2.0)
    .decay(1.0)
    .sustain(0.8)
    .release(3.0)
    .gain(0.2),

  // Main pad - C major 7
  note("<[c4,e4,g4,b4] [g3,b3,d4,f#4] [a3,c4,e4,g4] [f3,a3,c4,e4]>/2")
    .s("triangle")
    .attack(1.5)
    .decay(0.8)
    .sustain(0.6)
    .release(2.5)
    .cutoff(1200)
    .gain(0.25),

  // High shimmer
  note("<e5 g5 b5 d6>/4")
    .s("sine")
    .attack(0.5)
    .decay(0.3)
    .sustain(0.3)
    .release(1.5)
    .gain(0.1),

  // Subtle pulse
  note("c3 ~ g3 ~")
    .s("triangle")
    .attack(0.1)
    .decay(0.4)
    .sustain(0.2)
    .release(0.8)
    .cutoff(600)
    .gain(0.15)
)
