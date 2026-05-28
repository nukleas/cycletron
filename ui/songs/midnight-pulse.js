// Midnight Pulse - Dark Techno (WASM Version)
// Simplified for pure Rust/WASM playback
// Key: E minor, 122 BPM

setBpm(122)

// Drum elements
const kick1 = s("bd ~ ~ bd ~ ~ bd ~").gain(0.95)
const kick2 = s("bd ~ bd ~ bd ~ bd ~").gain(0.95)
const kick4 = s("bd*4").gain(0.95)
const clap = s("~ ~ ~ ~ cp ~ ~ ~").gain(0.5)
const hats = s("hh*16").gain(0.2)

// Bass patterns
const bass1 = note("e2 e2 ~ e3 ~ e2 g2 ~").s("sawtooth").cutoff(200).resonance(14).gain(0.45)
const bass2 = note("e2 ~ g2 ~ a2 ~ b2 ~").s("sawtooth").cutoff(500).resonance(18).gain(0.45)
const bass3 = note("e2 e2 e3 ~ g2 ~ d3 e3").s("sawtooth").cutoff(900).resonance(22).gain(0.45)
const bassSparse = note("e2 ~ ~ ~ ~ ~ ~ ~").s("sawtooth").cutoff(150).resonance(10).gain(0.4)

// Melodic elements
const stab1 = note("~ ~ b4 ~ ~ ~ a4 ~").s("triangle").gain(0.2).attack(0.02).decay(0.3)
const stab2 = note("~ e4 ~ g4 ~ a4 ~ b4").s("triangle").gain(0.22).attack(0.02).decay(0.3)
const pad = note("[e3,g3,b3]").s("sine").attack(1.0).decay(0.5).sustain(0.6).release(2.0).gain(0.12)
const sub = note("e1").s("sine").gain(0.35)

// Sections
const intro = stack(kick1, hats.gain(0.1), bass1)
const build = stack(kick1, hats.gain(0.15), bass2, stab1)
const main = stack(kick2, clap, hats, bass2, stab1, sub)
const peak = stack(kick4, clap, hats, bass3, stab2, sub)
const breakdown = stack(hats.gain(0.08), pad, bassSparse)
const outro = stack(kick1, hats.gain(0.12), bass1.gain(0.35))

// Arrangement using pickRestart
const arrangement = "<0@4 1@4 2@8 3@4 4@4 5@4 6@4>"
arrangement.pickRestart([intro, build, main, peak, breakdown, peak, outro])
