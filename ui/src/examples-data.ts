// 28 examples — all validated against strudel-rs (parse + eval + event generation)
// Only uses features confirmed working in the parity check

export interface Example {
    title: string;
    code: string;
    tags: string[];
    complexity: string;
    tempo: number | null;
}

export const EXAMPLES: Example[] = [
  {
    title: "First Steps",
    code: `note("c4 e4 g4 c5").s("sine")`,
    tags: ["synth", "beginner"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Basic Beat",
    code: `s("bd*4, ~ cp ~ cp, hh*8")`,
    tags: ["drums", "beginner"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Filtered Saw",
    code: `note("c3 eb3 g3 bb3")
  .s("sawtooth")
  .cutoff(600)
  .resonance(10)
  .gain(0.5)`,
    tags: ["synth", "effects"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Supersaw Pad",
    code: `note("<c3 eb3 g3 bb3>")
  .s("supersaw")
  .gain(0.2)
  .room(0.8)
  .attack(0.5)
  .release(1)`,
    tags: ["synth", "ambient"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Euclidean Kick",
    code: `s("bd(3,8), hh*8, ~ cp ~ cp")`,
    tags: ["drums", "euclidean"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Scale Run",
    code: `note("0 1 2 3 4 5 6 7")
  .scale("C4:major")
  .s("sine")
  .fast(2)`,
    tags: ["synth", "tonal"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Stacked Groove",
    code: `stack(
  s("bd*4"),
  s("~ sd ~ sd").gain(0.6),
  s("hh*8").gain(0.3),
  note("c2 ~ eb2 ~")
    .s("sawtooth").cutoff(400).gain(0.5)
)`,
    tags: ["drums", "synth", "multi-track"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Arpeggiated Delay",
    code: `note("c4 e4 g4 b4 c5 b4 g4 e4")
  .s("triangle")
  .fast(2)
  .delay(0.3)
  .room(0.4)
  .gain(0.5)`,
    tags: ["synth", "effects"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Acid Bass",
    code: `note("c2 c2 eb2 c2 f2 c2 g2 c2")
  .s("sawtooth")
  .cutoff(800)
  .resonance(15)
  .gain(0.6)`,
    tags: ["synth", "acid"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Minor Melody",
    code: `note("0 1 2 3 4 5 6 7")
  .scale("A3:minor")
  .s("triangle")
  .room(0.3)`,
    tags: ["synth", "tonal"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Jux Mirror",
    code: `note("c4 e4 g4 b4")
  .s("sine")
  .jux(x => x.rev())
  .delay(0.2)
  .room(0.5)`,
    tags: ["synth", "stereo", "effects"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Every 3rd Fast",
    code: `s("bd sd hh cp")
  .every(3, x => x.fast(2))`,
    tags: ["drums", "generative"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Palindrome Melody",
    code: `note("c4 d4 e4 f4 g4 a4 b4 c5")
  .s("sine")
  .palindrome()
  .delay(0.25)
  .room(0.4)`,
    tags: ["synth", "generative"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Layered Sine",
    code: `note("c4 e4 g4")
  .s("sine")
  .layer(
    x => x,
    x => x.fast(2).gain(0.3)
  )`,
    tags: ["synth", "layered"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Superimpose Octave",
    code: `note("c4 e4 g4")
  .s("sine")
  .superimpose(x => x.transpose(12))
  .room(0.5)`,
    tags: ["synth", "layered"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Echo Drums",
    code: `s("bd cp")
  .echo(3, 0.125, 0.5)
  .room(0.3)`,
    tags: ["drums", "effects"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Chopped Kick",
    code: `s("bd")
  .chop(8)
  .rev()
  .room(0.4)`,
    tags: ["drums", "effects", "generative"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "FM Bell",
    code: `note("c5 e5 g5 c6")
  .s("fm")
  .gain(0.4)
  .room(0.6)
  .delay(0.3)`,
    tags: ["synth", "effects"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Slowcat Sections",
    code: `slowcat(
  s("bd*4, hh*8"),
  s("bd sd bd sd, hh*4")
)`,
    tags: ["drums", "arrangement"],
    complexity: "beginner",
    tempo: null,
  },
  {
    title: "Full Track",
    code: `stack(
  s("bd*4"),
  s("~ cp ~ cp").gain(0.6),
  s("hh*8").gain(0.3).hpf(5000),
  note("<c2 ~ c2 ~> <~ eb2 ~ g2>")
    .s("sawtooth").cutoff(500).gain(0.5),
  note("c4 eb4 g4 bb4").fast(2)
    .s("triangle")
    .delay(0.3).room(0.3).gain(0.4)
)`,
    tags: ["drums", "synth", "multi-track"],
    complexity: "advanced",
    tempo: null,
  },
  {
    title: "Euclidean Polyrhythm",
    code: `stack(
  s("bd(3,8)"),
  s("sd(5,8)").gain(0.5),
  s("hh(7,8)").gain(0.3)
)`,
    tags: ["drums", "euclidean"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Sometimes Glitch",
    code: `s("bd*4, hh*8")
  .sometimes(x => x.speed(2))
  .room(0.3)`,
    tags: ["drums", "generative"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Off Beat Harmony",
    code: `note("c4 e4 g4 b4")
  .s("sine")
  .off(0.125, x => x.transpose(7))
  .room(0.4)`,
    tags: ["synth", "harmonic"],
    complexity: "advanced",
    tempo: null,
  },
  {
    title: "Ply Stutter",
    code: `s("bd sd hh cp")
  .ply(3)
  .gain(0.5)`,
    tags: ["drums", "generative"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "ADSR Shape",
    code: `note("c3 eb3 g3 bb3")
  .s("sawtooth")
  .attack(0.01)
  .decay(0.2)
  .sustain(0.3)
  .release(0.4)
  .cutoff(1200)`,
    tags: ["synth", "sound-design"],
    complexity: "intermediate",
    tempo: null,
  },
  {
    title: "Dark Ambient",
    code: `stack(
  note("<c2 bb1 ab1 g1>")
    .s("sawtooth")
    .cutoff(300)
    .room(0.9)
    .gain(0.3),
  note("<eb4 d4 c4 bb3>")
    .s("sine")
    .gain(0.15)
    .room(0.8)
    .delay(0.4)
)`,
    tags: ["synth", "ambient", "multi-track"],
    complexity: "advanced",
    tempo: null,
  },
  {
    title: "Techno Minimal",
    code: `stack(
  s("bd*4").gain(0.8),
  s("~ cp ~ cp").gain(0.5),
  s("hh(3,8)").gain(0.25).hpf(6000),
  note("c2(5,8)")
    .s("square")
    .cutoff(400)
    .gain(0.4)
)`,
    tags: ["drums", "synth", "euclidean"],
    complexity: "advanced",
    tempo: null,
  },
  {
    title: "Dorian Scale",
    code: `note("0 1 2 3 4 5 6 7")
  .scale("D4:dorian")
  .s("triangle")
  .slow(2)
  .room(0.4)`,
    tags: ["synth", "tonal"],
    complexity: "beginner",
    tempo: null,
  },
];
