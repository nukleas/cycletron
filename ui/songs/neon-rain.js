// Neon Rain - Synthwave (WASM Version)
// Simplified for pure Rust/WASM playback
// Original: F# minor, 118 BPM

setBpm(118)

// Section patterns using pickRestart
const sections = "<0@4 1@4 2@8 3@4 4@8 5@4 6@4>"

stack(
  // Drums - punchy 80s style
  sections.pickRestart([
    s("bd ~ ~ ~").gain(0.5),
    s("bd ~ bd ~, ~ ~ ~ hh").gain(0.6),
    s("bd ~ bd ~, ~ sd ~ sd, hh*8").gain(0.7).bank("RolandTR707"),
    s("~ ~ ~ sd, hh*4").gain(0.5).bank("RolandTR707"),
    s("bd ~ bd ~, ~ sd ~ sd, hh*8").gain(0.75).bank("RolandTR707"),
    s("bd*4, ~ sd ~ sd, hh*16").gain(0.8).bank("RolandTR707"),
    s("bd ~ ~ ~, ~ ~ ~ hh").gain(0.5).bank("RolandTR707")
  ]),

  // Sub bass - F# minor root
  sections.pickRestart([
    silence,
    note("f#1 ~ ~ ~").s("sine").gain(0.4),
    note("f#1 ~ f#1 ~").s("sine").gain(0.45),
    note("f#1 ~ ~ ~").s("sine").gain(0.35),
    note("f#1 ~ f#1 ~ e1 ~ f#1 ~").s("sine").gain(0.5),
    note("f#1 f#1 e1 f#1").s("sine").gain(0.55),
    note("f#1 ~ ~ ~").s("sine").gain(0.3)
  ]).cutoff(100),

  // Bass synth - driving sawtooth
  sections.pickRestart([
    silence,
    silence,
    note("f#2 ~ f#2 ~ e2 ~ f#2 ~").s("sawtooth").cutoff(400).resonance(10).gain(0.4),
    note("f#2 ~ ~ ~").s("sawtooth").cutoff(250).gain(0.3),
    note("f#2 ~ a2 ~ e2 ~ f#2 b2").s("sawtooth").cutoff(600).resonance(12).gain(0.45),
    note("f#2 a2 e2 f#2 b2 a2 f#2 e2").s("sawtooth").cutoff(900).resonance(14).gain(0.5),
    note("f#2 ~ ~ ~").s("sawtooth").cutoff(300).gain(0.3)
  ]),

  // Arpeggio - classic synthwave supersaw
  sections.pickRestart([
    note("f#4 a4 c#5 f#5 c#5 a4 f#4 a4").s("supersaw").gain(0.15).cutoff(1500).attack(0.02).decay(0.15),
    note("f#4 a4 c#5 f#5 c#5 a4 f#4 a4").s("supersaw").gain(0.18).cutoff(1800).attack(0.02).decay(0.15),
    note("f#4 a4 c#5 f#5 e5 c#5 a4 f#4").fast(2).s("supersaw").gain(0.2).cutoff(2200).attack(0.01).decay(0.1),
    note("f#4 ~ c#5 ~ a4 ~ ~ ~").s("supersaw").gain(0.15).cutoff(1600),
    note("f#4 a4 c#5 e5 f#5 e5 c#5 a4").fast(2).s("supersaw").gain(0.22).cutoff(2800).attack(0.01).decay(0.1),
    note("f#4 c#5 a4 f#5 e5 a4 c#5 f#4").fast(2).s("supersaw").gain(0.25).cutoff(3200),
    note("f#4 a4 c#5 f#5 c#5 a4 f#4 ~").s("supersaw").gain(0.12).cutoff(1200)
  ]),

  // Lead melody - soaring supersaw
  sections.pickRestart([
    silence,
    silence,
    note("c#5 ~ a4 ~ f#4 ~ ~ ~").s("supersaw").gain(0.3).cutoff(2500).attack(0.05).decay(0.3),
    note("f#5 ~ ~ e5 ~ ~ ~ ~").s("supersaw").gain(0.25).cutoff(2000).attack(0.1).decay(0.4),
    note("c#5 ~ e5 ~ f#5 ~ e5 c#5").s("supersaw").gain(0.32).cutoff(3000).attack(0.03).decay(0.25),
    note("f#5 ~ a5 ~ f#5 e5 c#5 ~").s("supersaw").gain(0.35).cutoff(3500).attack(0.02).decay(0.2),
    note("c#5 ~ ~ ~ ~ ~ ~ ~").s("supersaw").gain(0.2).cutoff(1800).attack(0.2).decay(0.5)
  ]),

  // Pad - atmospheric chords
  sections.pickRestart([
    note("[f#3,a3,c#4]").s("supersaw").attack(1.0).decay(0.5).sustain(0.5).release(2.0).cutoff(1200).gain(0.1),
    note("[f#3,a3,c#4]").s("supersaw").attack(0.8).decay(0.4).sustain(0.5).release(1.5).cutoff(1400).gain(0.12),
    silence,
    note("[f#3,a3,c#4,e4]").s("sine").attack(1.5).decay(0.6).sustain(0.6).release(2.5).gain(0.15),
    silence,
    silence,
    note("[f#3,a3,c#4]").s("supersaw").attack(2.0).decay(0.8).sustain(0.4).release(3.0).cutoff(1000).gain(0.08)
  ])
)
