// Techno Loop - Simple but driving
// 130 BPM

setBpm(130)

stack(
  // Four-on-the-floor kick
  s("bd*4").gain(0.9),

  // Clap on 2 and 4
  s("~ cp ~ cp").gain(0.6),

  // 16th note hats with accent
  s("[hh hh hh oh]*4").gain(0.35),

  // Acid bass line
  note("c2 c2 c3 c2 eb2 c2 g2 c2")
    .s("sawtooth")
    .cutoff(400)
    .resonance(15)
    .gain(0.5),

  // Sub bass
  note("c1*4")
    .s("sine")
    .gain(0.4)
)
