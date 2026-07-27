// Progressive examples + showcase — validated against strudel-rs surface.
// Only uses features confirmed working (see docs/STRUDEL_RS_SUPPORTED.md).

export type ExampleSection = 'lessons' | 'patterns' | 'showcase';

export interface Example {
    title: string;
    code: string;
    tags: string[];
    complexity: string;
    tempo: number | null;
    section: ExampleSection;
    /** Lesson order (1-based) when section === 'lessons' */
    lesson?: number;
    blurb?: string;
}

export const EXAMPLES: Example[] = [
    // ── Lessons (play first, then load in order) ──────────────────────────
    {
        title: 'First Steps',
        lesson: 1,
        section: 'lessons',
        blurb: 'A short melody. Press Play, then load this.',
        code: `note("c4 e4 g4 c5").s("sine")`,
        tags: ['synth', 'beginner'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Basic Beat',
        lesson: 2,
        section: 'lessons',
        blurb: 'Kick, clap, hats — mini-notation drums.',
        code: `s("bd*4, ~ cp ~ cp, hh*8")`,
        tags: ['drums', 'beginner'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Filtered Saw',
        lesson: 3,
        section: 'lessons',
        blurb: 'Synth + filter + resonance.',
        code: `note("c3 eb3 g3 bb3")
  .s("sawtooth")
  .cutoff(600)
  .resonance(10)
  .gain(0.5)`,
        tags: ['synth', 'effects'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Scale Run',
        lesson: 4,
        section: 'lessons',
        blurb: 'Numeric degrees + scale("root:mode").',
        code: `note("0 1 2 3 4 5 6 7")
  .scale("C4:major")
  .s("sine")
  .fast(2)`,
        tags: ['synth', 'tonal'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Euclidean Kick',
        lesson: 5,
        section: 'lessons',
        blurb: 'Euclid rhythms: bd(hits, steps).',
        code: `s("bd(3,8), hh*8, ~ cp ~ cp")`,
        tags: ['drums', 'euclidean'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Stacked Groove',
        lesson: 6,
        section: 'lessons',
        blurb: 'stack() layers drums and bass.',
        code: `stack(
  s("bd*4"),
  s("~ sd ~ sd").gain(0.6),
  s("hh*8").gain(0.3),
  note("c2 ~ eb2 ~")
    .s("sawtooth").cutoff(400).gain(0.5)
)`,
        tags: ['drums', 'synth', 'multi-track'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Slowcat Sections',
        lesson: 7,
        section: 'lessons',
        blurb: 'Alternate whole patterns each cycle.',
        code: `slowcat(
  s("bd*4, hh*8"),
  s("bd sd bd sd, hh*4")
)`,
        tags: ['drums', 'arrangement'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Full Track Sketch',
        lesson: 8,
        section: 'lessons',
        blurb: 'Drums + bass + lead in one stack.',
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
        tags: ['drums', 'synth', 'multi-track'],
        complexity: 'advanced',
        tempo: null,
    },

    // ── Patterns ──────────────────────────────────────────────────────────
    {
        title: 'Supersaw Pad',
        section: 'patterns',
        code: `note("<c3 eb3 g3 bb3>")
  .s("supersaw")
  .gain(0.2)
  .room(0.8)
  .attack(0.5)
  .release(1)`,
        tags: ['synth', 'ambient'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Minor Melody',
        section: 'patterns',
        code: `note("0 1 2 3 4 5 6 7")
  .scale("A3:minor")
  .s("triangle")
  .room(0.3)`,
        tags: ['synth', 'tonal'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Dorian Scale',
        section: 'patterns',
        code: `note("0 1 2 3 4 5 6 7")
  .scale("D4:dorian")
  .s("triangle")
  .slow(2)
  .room(0.4)`,
        tags: ['synth', 'tonal'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Arpeggiated Delay',
        section: 'patterns',
        code: `note("c4 e4 g4 b4 c5 b4 g4 e4")
  .s("triangle")
  .fast(2)
  .delay(0.3)
  .room(0.4)
  .gain(0.5)`,
        tags: ['synth', 'effects'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Acid Bass',
        section: 'patterns',
        code: `note("c2 c2 eb2 c2 f2 c2 g2 c2")
  .s("sawtooth")
  .cutoff(800)
  .resonance(15)
  .gain(0.6)`,
        tags: ['synth', 'acid'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Jux Mirror',
        section: 'patterns',
        code: `note("c4 e4 g4 b4")
  .s("sine")
  .jux(x => x.rev())
  .delay(0.2)
  .room(0.5)`,
        tags: ['synth', 'stereo', 'effects'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Every 3rd Fast',
        section: 'patterns',
        code: `s("bd sd hh cp")
  .every(3, x => x.fast(2))`,
        tags: ['drums', 'generative'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Palindrome Melody',
        section: 'patterns',
        code: `note("c4 d4 e4 f4 g4 a4 b4 c5")
  .s("sine")
  .palindrome()
  .delay(0.25)
  .room(0.4)`,
        tags: ['synth', 'generative'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Layered Sine',
        section: 'patterns',
        code: `note("c4 e4 g4")
  .s("sine")
  .layer(
    x => x,
    x => x.fast(2).gain(0.3)
  )`,
        tags: ['synth', 'layered'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Superimpose Octave',
        section: 'patterns',
        code: `note("c4 e4 g4")
  .s("sine")
  .superimpose(x => x.transpose(12))
  .room(0.5)`,
        tags: ['synth', 'layered'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Echo Drums',
        section: 'patterns',
        code: `s("bd cp")
  .echo(3, 0.125, 0.5)
  .room(0.3)`,
        tags: ['drums', 'effects'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Chopped Kick',
        section: 'patterns',
        code: `s("bd")
  .chop(8)
  .rev()
  .room(0.4)`,
        tags: ['drums', 'effects', 'generative'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'FM Bell',
        section: 'patterns',
        code: `note("c5 e5 g5 c6")
  .s("fm")
  .gain(0.4)
  .room(0.6)
  .delay(0.3)`,
        tags: ['synth', 'effects'],
        complexity: 'beginner',
        tempo: null,
    },
    {
        title: 'Euclidean Polyrhythm',
        section: 'patterns',
        code: `stack(
  s("bd(3,8)"),
  s("sd(5,8)").gain(0.5),
  s("hh(7,8)").gain(0.3)
)`,
        tags: ['drums', 'euclidean'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Sometimes Glitch',
        section: 'patterns',
        code: `s("bd*4, hh*8")
  .sometimes(x => x.speed(2))
  .room(0.3)`,
        tags: ['drums', 'generative'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Off Beat Harmony',
        section: 'patterns',
        code: `note("c4 e4 g4 b4")
  .s("sine")
  .off(0.125, x => x.transpose(7))
  .room(0.4)`,
        tags: ['synth', 'harmonic'],
        complexity: 'advanced',
        tempo: null,
    },
    {
        title: 'Ply Stutter',
        section: 'patterns',
        code: `s("bd sd hh cp")
  .ply(3)
  .gain(0.5)`,
        tags: ['drums', 'generative'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'ADSR Shape',
        section: 'patterns',
        code: `note("c3 eb3 g3 bb3")
  .s("sawtooth")
  .attack(0.01)
  .decay(0.2)
  .sustain(0.3)
  .release(0.4)
  .cutoff(1200)`,
        tags: ['synth', 'sound-design'],
        complexity: 'intermediate',
        tempo: null,
    },
    {
        title: 'Dark Ambient',
        section: 'patterns',
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
        tags: ['synth', 'ambient', 'multi-track'],
        complexity: 'advanced',
        tempo: null,
    },
    {
        title: 'Techno Minimal',
        section: 'patterns',
        code: `stack(
  s("bd*4").gain(0.8),
  s("~ cp ~ cp").gain(0.5),
  s("hh(3,8)").gain(0.25).hpf(6000),
  note("c2(5,8)")
    .s("square")
    .cutoff(400)
    .gain(0.4)
)`,
        tags: ['drums', 'synth', 'euclidean'],
        complexity: 'advanced',
        tempo: null,
    },

    // ── Showcase ──────────────────────────────────────────────────────────
    {
        title: 'House Opener',
        section: 'showcase',
        blurb: 'Live-set style house groove · 128 BPM',
        code: `setbpm(128);

stack(
  s("bd*4").gain(0.9),
  s("~ hh*2 ~ hh*3").gain(0.5),
  note("<c2 c2 eb2 g2>/4")
    .s("sawtooth")
    .cutoff(400)
    .gain(0.7),
  note("<[c4,eb4,g4] [c4,eb4,g4] [eb4,g4,bb4] [g4,bb4,d5]>")
    .s("triangle")
    .cutoff(800)
    .attack(0.2)
    .decay(0.3)
    .sustain(0.5)
    .gain(0.3)
)`,
        tags: ['house', 'showcase'],
        complexity: 'intermediate',
        tempo: 128,
    },
    {
        title: 'Techno Loop',
        section: 'showcase',
        blurb: 'Four-on-the-floor + acid bass · 130 BPM',
        code: `setbpm(130);

stack(
  s("bd*4").gain(0.9),
  s("~ cp ~ cp").gain(0.6),
  s("[hh hh hh oh]*4").gain(0.35),
  note("c2 c2 c3 c2 eb2 c2 g2 c2")
    .s("sawtooth")
    .cutoff(400)
    .resonance(15)
    .gain(0.5),
  note("c1*4")
    .s("sine")
    .gain(0.4)
)`,
        tags: ['techno', 'showcase'],
        complexity: 'intermediate',
        tempo: 130,
    },
    {
        title: 'Ambient Drift',
        section: 'showcase',
        blurb: 'Slow pads and shimmer · 80 BPM',
        code: `setbpm(80);

stack(
  note("[c2,g2]")
    .s("sine")
    .attack(2.0)
    .decay(1.0)
    .sustain(0.8)
    .release(3.0)
    .gain(0.2),
  note("<[c4,e4,g4,b4] [g3,b3,d4,f#4] [a3,c4,e4,g4] [f3,a3,c4,e4]>/2")
    .s("triangle")
    .attack(1.5)
    .decay(0.8)
    .sustain(0.6)
    .release(2.5)
    .cutoff(1200)
    .gain(0.25),
  note("<e5 g5 b5 d6>/4")
    .s("sine")
    .attack(0.5)
    .release(1.5)
    .gain(0.1),
  note("c3 ~ g3 ~")
    .s("triangle")
    .attack(0.1)
    .cutoff(600)
    .gain(0.15)
)`,
        tags: ['ambient', 'showcase'],
        complexity: 'intermediate',
        tempo: 80,
    },
    {
        title: 'Agency · Legacy System (excerpt)',
        section: 'showcase',
        blurb: 'OST motif: dark ambient boot · 56 BPM',
        code: `// Agency OST — 01 Legacy System (excerpt)
// Motif degrees 0 2 4 6 · 7 4 2 0 — full tracks in ui/songs/agency/
setbpm(56);

stack(
  note("c#1").s("sine").slow(4).attack(4).release(12).gain(0.55),
  note("c#2").s("sine").slow(4).attack(6).release(12).detune(9).gain(0.26),
  note("0 2 4 6 7 4 2 0")
    .scale("C#4:minor")
    .s("sine")
    .slow(2)
    .attack(0.05)
    .release(0.8)
    .room(0.85)
    .gain(0.22)
).room(0.9)`,
        tags: ['agency', 'ambient', 'showcase'],
        complexity: 'advanced',
        tempo: 56,
    },
    {
        title: 'Small Drum & Bass (intro)',
        section: 'showcase',
        blurb: 'F minor half-time intro · 174 BPM · full form in ui/songs/',
        code: `setbpm(174);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~").lpf(500).gain(0.72),
  s("hh*8").hpf(5000).gain(0.14),
  note("<f1 f1 d#1 c#1>")
    .s("sine").attack(0.02).release(0.45).gain(0.52),
  note("<[f3,g#3,c4] [d#3,g3,a#3] [c#3,f3,g#3] [c3,d#3,g3]>")
    .s("wt_pad").attack(0.8).release(1.4).lpf(1000).room(0.6).gain(0.2)
)`,
        tags: ['dnb', 'showcase'],
        complexity: 'advanced',
        tempo: 174,
    },
];

export const SECTION_LABELS: Record<ExampleSection, string> = {
    lessons: 'Lessons',
    patterns: 'Patterns',
    showcase: 'Showcase',
};

export const SECTION_ORDER: ExampleSection[] = ['lessons', 'patterns', 'showcase'];
