// AUTO-GENERATED from docs/STRUDEL_RS_SUPPORTED.md — do not edit by hand.
// Regenerate with `npm run gen:dsl`. Sourced from the ground-truth DSL surface
// so completions/hover can never drift from what the validator accepts.

export type DslKind = 'function' | 'method' | 'sound' | 'keyword';

export interface DslSymbol {
    /** Identifier to complete / look up on hover. */
    label: string;
    /** Signature, e.g. "every(n, fn)". Equals `label` when it takes no args. */
    detail: string;
    /** One-line description (section-specific where the doc had one). */
    info: string;
    kind: DslKind;
}

export const DSL_SYMBOLS: DslSymbol[] = [
    {
        "label": "add",
        "detail": "add(n)",
        "info": "Math on values",
        "kind": "method"
    },
    {
        "label": "adsr",
        "detail": "adsr(a, d, s, r)",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "almostAlways",
        "detail": "almostAlways(fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "almostNever",
        "detail": "almostNever(fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "always",
        "detail": "always(fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "amp",
        "detail": "amp(v)",
        "info": "Amplitude / panning",
        "kind": "method"
    },
    {
        "label": "anchor",
        "detail": "anchor(pos)",
        "info": "Metadata (no audio effect)",
        "kind": "method"
    },
    {
        "label": "arp",
        "detail": "arp(pat)",
        "info": "Arpeggiate each chord. pat is an index pattern (arp(\"0 2 1 3\"), rebased per chord) or a Tidal ordering name: up, down, updown, downup, up&down, down&up, converge, diverge, disconverge, pinkyup, pinkyupdown, thumbup, thumbupdown. Names and indices mix in one pattern; an unknown name is silence, not a fallback to up.",
        "kind": "method"
    },
    {
        "label": "arrange",
        "detail": "arrange(...)",
        "info": "Section combinator: arrange([bars, pat], …) plays each pattern for bars cycles at its native rate, then loops.",
        "kind": "function"
    },
    {
        "label": "att",
        "detail": "att",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "attack",
        "detail": "attack(t)",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "bandq",
        "detail": "bandq(q)",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bank",
        "detail": "bank(name)",
        "info": "Sample playback",
        "kind": "method"
    },
    {
        "label": "beat",
        "detail": "beat(positions, div)",
        "info": "Place the source at the given slots of a cycle divided into div: beat(\"0 4\", 8). Positions wrap modulo div; div is a plain number.",
        "kind": "method"
    },
    {
        "label": "begin",
        "detail": "begin(0..1)",
        "info": "Sample playback",
        "kind": "method"
    },
    {
        "label": "bjork",
        "detail": "bjork",
        "info": "Structure",
        "kind": "method"
    },
    {
        "label": "bp",
        "detail": "bp",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpatt",
        "detail": "bpatt",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpattack",
        "detail": "bpattack(t)",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpdec",
        "detail": "bpdec",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpdecay",
        "detail": "bpdecay(t)",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpe",
        "detail": "bpe",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpenv",
        "detail": "bpenv(amount)",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpf",
        "detail": "bpf(hz)",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpq",
        "detail": "bpq",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bprel",
        "detail": "bprel",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bprelease",
        "detail": "bprelease(t)",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpsus",
        "detail": "bpsus",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "bpsustain",
        "detail": "bpsustain(level)",
        "info": "Band-pass filter",
        "kind": "method"
    },
    {
        "label": "brown",
        "detail": "brown",
        "info": "Brown noise",
        "kind": "sound"
    },
    {
        "label": "chop",
        "detail": "chop(n)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "chord",
        "detail": "chord(pat)",
        "info": "Expand chord symbols (e.g. \"Cm7\" → constituent notes).",
        "kind": "function"
    },
    {
        "label": "chorus",
        "detail": "chorus(\"0.5:1.2\")",
        "info": "Chorus",
        "kind": "method"
    },
    {
        "label": "choruspeed",
        "detail": "choruspeed",
        "info": "Effect quick-list (chainable)",
        "kind": "method"
    },
    {
        "label": "clip",
        "detail": "clip(threshold)",
        "info": "Distortion & shaping",
        "kind": "method"
    },
    {
        "label": "coarse",
        "detail": "coarse(n)",
        "info": "Distortion & shaping",
        "kind": "method"
    },
    {
        "label": "color",
        "detail": "color(hex)",
        "info": "Metadata (no audio effect)",
        "kind": "method"
    },
    {
        "label": "contract",
        "detail": "contract(factor)",
        "info": "Divide the step count; see expand.",
        "kind": "method"
    },
    {
        "label": "cosine",
        "detail": "cosine",
        "info": "Cosine.",
        "kind": "function"
    },
    {
        "label": "crackle",
        "detail": "crackle",
        "info": "Granular crackle",
        "kind": "sound"
    },
    {
        "label": "crush",
        "detail": "crush(bits)",
        "info": "Distortion & shaping",
        "kind": "method"
    },
    {
        "label": "ctf",
        "detail": "ctf(hz)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "cut",
        "detail": "cut(group)",
        "info": "Sample playback",
        "kind": "method"
    },
    {
        "label": "cutoff",
        "detail": "cutoff(hz)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "dec",
        "detail": "dec",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "decay",
        "detail": "decay(t)",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "degrade",
        "detail": "degrade",
        "info": "Degradation",
        "kind": "method"
    },
    {
        "label": "degradeBy",
        "detail": "degradeBy(prob)",
        "info": "Degradation",
        "kind": "method"
    },
    {
        "label": "delay",
        "detail": "delay(amount)",
        "info": "Delay",
        "kind": "method"
    },
    {
        "label": "delayfb",
        "detail": "delayfb",
        "info": "Delay",
        "kind": "method"
    },
    {
        "label": "delayfeedback",
        "detail": "delayfeedback(amount)",
        "info": "Delay",
        "kind": "method"
    },
    {
        "label": "delayt",
        "detail": "delayt",
        "info": "Delay",
        "kind": "method"
    },
    {
        "label": "delaytime",
        "detail": "delaytime(t)",
        "info": "Delay",
        "kind": "method"
    },
    {
        "label": "det",
        "detail": "det",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "detune",
        "detail": "detune(cents)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "dict",
        "detail": "dict",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "dictionary",
        "detail": "dictionary(name)",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "dist",
        "detail": "dist(amount)",
        "info": "Distortion & shaping",
        "kind": "method"
    },
    {
        "label": "distort",
        "detail": "distort",
        "info": "Distortion & shaping",
        "kind": "method"
    },
    {
        "label": "distortion",
        "detail": "distortion",
        "info": "Distortion & shaping",
        "kind": "method"
    },
    {
        "label": "div",
        "detail": "div(n)",
        "info": "Math on values",
        "kind": "method"
    },
    {
        "label": "duck",
        "detail": "duck(v)",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckatt",
        "detail": "duckatt(t)",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckattack",
        "detail": "duckattack",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckdepth",
        "detail": "duckdepth(v)",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckons",
        "detail": "duckons(v)",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckonset",
        "detail": "duckonset",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckorbit",
        "detail": "duckorbit(v)",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckrel",
        "detail": "duckrel(t)",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "duckrelease",
        "detail": "duckrelease",
        "info": "Ducking / sidechain",
        "kind": "method"
    },
    {
        "label": "dur",
        "detail": "dur",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "duration",
        "detail": "duration(t)",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "early",
        "detail": "early(t)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "echo",
        "detail": "echo(times, time, feedback)",
        "info": "Stutter / echo",
        "kind": "method"
    },
    {
        "label": "echoWith",
        "detail": "echoWith",
        "info": "Stutter / echo",
        "kind": "method"
    },
    {
        "label": "end",
        "detail": "end(0..1)",
        "info": "Sample playback",
        "kind": "method"
    },
    {
        "label": "euclid",
        "detail": "euclid(p, s, [rot])",
        "info": "Structure",
        "kind": "method"
    },
    {
        "label": "euclidLegato",
        "detail": "euclidLegato(p, s)",
        "info": "Structure",
        "kind": "method"
    },
    {
        "label": "euclidLegatoRot",
        "detail": "euclidLegatoRot(p, s, r)",
        "info": "Structure",
        "kind": "method"
    },
    {
        "label": "euclidRot",
        "detail": "euclidRot",
        "info": "Structure",
        "kind": "method"
    },
    {
        "label": "every",
        "detail": "every(n, fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "expand",
        "detail": "expand(factor)",
        "info": "Multiply the step count without moving events. Audible only once pace reads it back.",
        "kind": "method"
    },
    {
        "label": "fast",
        "detail": "fast(n)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "fastcat",
        "detail": "fastcat(...)",
        "info": "Concatenate, one cycle total.",
        "kind": "function"
    },
    {
        "label": "firstOf",
        "detail": "firstOf",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "fm",
        "detail": "fm",
        "info": "2-op FM (fmindex, fmratio)",
        "kind": "method"
    },
    {
        "label": "fma",
        "detail": "fma",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmattack",
        "detail": "fmattack(t)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmd",
        "detail": "fmd",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmdecay",
        "detail": "fmdecay(t)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fme",
        "detail": "fme",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmenv",
        "detail": "fmenv(amount)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmh",
        "detail": "fmh",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmi",
        "detail": "fmi",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmindex",
        "detail": "fmindex(v)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmr",
        "detail": "fmr",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmratio",
        "detail": "fmratio(v)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmrelease",
        "detail": "fmrelease(t)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fms",
        "detail": "fms",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "fmsustain",
        "detail": "fmsustain(level)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "gain",
        "detail": "gain(v)",
        "info": "Amplitude / panning",
        "kind": "method"
    },
    {
        "label": "grain",
        "detail": "grain",
        "info": "Effect quick-list (chainable)",
        "kind": "method"
    },
    {
        "label": "grainsize",
        "detail": "grainsize(ms)",
        "info": "Effect quick-list (chainable)",
        "kind": "method"
    },
    {
        "label": "hp",
        "detail": "hp",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpatt",
        "detail": "hpatt",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpattack",
        "detail": "hpattack(t)",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpdec",
        "detail": "hpdec",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpdecay",
        "detail": "hpdecay(t)",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpe",
        "detail": "hpe",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpenv",
        "detail": "hpenv(amount)",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpf",
        "detail": "hpf(hz)",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpq",
        "detail": "hpq",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hprel",
        "detail": "hprel",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hprelease",
        "detail": "hprelease(t)",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpsus",
        "detail": "hpsus",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hpsustain",
        "detail": "hpsustain(level)",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hresonance",
        "detail": "hresonance(q)",
        "info": "High-pass filter",
        "kind": "method"
    },
    {
        "label": "hurry",
        "detail": "hurry(n)",
        "info": "fast(n) plus a matching sample-speed change.",
        "kind": "method"
    },
    {
        "label": "hush",
        "detail": "hush",
        "info": "Silence everything.",
        "kind": "keyword"
    },
    {
        "label": "inhabit",
        "detail": "inhabit(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "inhabitmod",
        "detail": "inhabitmod(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "inside",
        "detail": "inside(n, fn)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "ir",
        "detail": "ir(v)",
        "info": "Effect quick-list (chainable)",
        "kind": "method"
    },
    {
        "label": "irand",
        "detail": "irand(n)",
        "info": "Integer random in [0, n).",
        "kind": "function"
    },
    {
        "label": "isaw",
        "detail": "isaw",
        "info": "Sawtooth ramps; isaw = inverted.",
        "kind": "function"
    },
    {
        "label": "jux",
        "detail": "jux(fn)",
        "info": "Stereo & layering",
        "kind": "method"
    },
    {
        "label": "juxBy",
        "detail": "juxBy(amount, fn)",
        "info": "Stereo & layering",
        "kind": "method"
    },
    {
        "label": "lastOf",
        "detail": "lastOf(n, fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "late",
        "detail": "late(t)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "layer",
        "detail": "layer(fn, ...)",
        "info": "Stereo & layering",
        "kind": "method"
    },
    {
        "label": "linger",
        "detail": "linger(t)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "loop",
        "detail": "loop(v)",
        "info": "Sample playback",
        "kind": "method"
    },
    {
        "label": "lp",
        "detail": "lp",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpatt",
        "detail": "lpatt",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpattack",
        "detail": "lpattack(t)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpdec",
        "detail": "lpdec",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpdecay",
        "detail": "lpdecay(t)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpe",
        "detail": "lpe",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpenv",
        "detail": "lpenv(amount)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpf",
        "detail": "lpf",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpq",
        "detail": "lpq",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lprel",
        "detail": "lprel",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lprelease",
        "detail": "lprelease(t)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpsus",
        "detail": "lpsus",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "lpsustain",
        "detail": "lpsustain(level)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "mask",
        "detail": "mask(pat)",
        "info": "Degradation",
        "kind": "method"
    },
    {
        "label": "mini",
        "detail": "mini(str)",
        "info": "Parse a string as mini-notation (rarely needed; string literals already parse).",
        "kind": "function"
    },
    {
        "label": "mul",
        "detail": "mul(n)",
        "info": "Math on values",
        "kind": "method"
    },
    {
        "label": "n",
        "detail": "n",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "never",
        "detail": "never",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "noise",
        "detail": "noise",
        "info": "White noise",
        "kind": "sound"
    },
    {
        "label": "note",
        "detail": "note(pat)",
        "info": "Reinterpret values as MIDI notes.",
        "kind": "function"
    },
    {
        "label": "off",
        "detail": "off(time, fn)",
        "info": "Stereo & layering",
        "kind": "method"
    },
    {
        "label": "often",
        "detail": "often(fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "orbit",
        "detail": "orbit(v)",
        "info": "Sample playback",
        "kind": "method"
    },
    {
        "label": "outside",
        "detail": "outside(n, fn)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "pace",
        "detail": "pace(steps)",
        "info": "Refit the pattern to that many steps per cycle. Identity when the pattern carries no step count.",
        "kind": "method"
    },
    {
        "label": "palindrome",
        "detail": "palindrome",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "pan",
        "detail": "pan(v)",
        "info": "Amplitude / panning",
        "kind": "method"
    },
    {
        "label": "patt",
        "detail": "patt",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "pattack",
        "detail": "pattack(t)",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "pdec",
        "detail": "pdec",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "pdecay",
        "detail": "pdecay(t)",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "pe",
        "detail": "pe",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "penv",
        "detail": "penv(amount)",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "ph",
        "detail": "ph",
        "info": "Sweep a notch through the signal. Rate alone engages it with a default depth.",
        "kind": "method"
    },
    {
        "label": "phasdp",
        "detail": "phasdp",
        "info": "How far the notch travels.",
        "kind": "method"
    },
    {
        "label": "phaser",
        "detail": "phaser(hz)",
        "info": "Sweep a notch through the signal. Rate alone engages it with a default depth.",
        "kind": "method"
    },
    {
        "label": "phaserdepth",
        "detail": "phaserdepth(v)",
        "info": "How far the notch travels.",
        "kind": "method"
    },
    {
        "label": "phaserrate",
        "detail": "phaserrate",
        "info": "Sweep a notch through the signal. Rate alone engages it with a default depth.",
        "kind": "method"
    },
    {
        "label": "phd",
        "detail": "phd",
        "info": "How far the notch travels.",
        "kind": "method"
    },
    {
        "label": "pick",
        "detail": "pick(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickF",
        "detail": "pickF(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickmod",
        "detail": "pickmod(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickmodF",
        "detail": "pickmodF(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickmodOut",
        "detail": "pickmodOut(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickmodReset",
        "detail": "pickmodReset(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickmodRestart",
        "detail": "pickmodRestart(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickmodSqueeze",
        "detail": "pickmodSqueeze",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickOut",
        "detail": "pickOut(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickReset",
        "detail": "pickReset(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickRestart",
        "detail": "pickRestart(...)",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pickSqueeze",
        "detail": "pickSqueeze",
        "info": "Selection / picking",
        "kind": "method"
    },
    {
        "label": "pink",
        "detail": "pink",
        "info": "Pink noise",
        "kind": "sound"
    },
    {
        "label": "ply",
        "detail": "ply(n)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "polymeter",
        "detail": "polymeter(...)",
        "info": "Stack with LCM step alignment.",
        "kind": "function"
    },
    {
        "label": "prel",
        "detail": "prel",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "prelease",
        "detail": "prelease(t)",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "press",
        "detail": "press",
        "info": "Push every event into the second half of its own span.",
        "kind": "method"
    },
    {
        "label": "pressBy",
        "detail": "pressBy(r)",
        "info": "Shift each event r of the way into its span (r may be a pattern). 0 is identity; outside 0–1 is silence.",
        "kind": "method"
    },
    {
        "label": "psus",
        "detail": "psus",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "psustain",
        "detail": "psustain(level)",
        "info": "Pitch envelope",
        "kind": "method"
    },
    {
        "label": "pulse",
        "detail": "pulse",
        "info": "Variable-width pulse (width 0..1)",
        "kind": "sound"
    },
    {
        "label": "pure",
        "detail": "pure(value)",
        "info": "One event per cycle holding value.",
        "kind": "function"
    },
    {
        "label": "pw",
        "detail": "pw",
        "info": "Pulse width 0–1. Setting it on a plain sine / tri / saw / square voice promotes it to a pulse oscillator. Colon form pw(\"0.3:2:0.4\") sets width, rate and depth at once.",
        "kind": "method"
    },
    {
        "label": "pwmdepth",
        "detail": "pwmdepth(v)",
        "info": "Depth of the pulse-width LFO.",
        "kind": "method"
    },
    {
        "label": "pwmrate",
        "detail": "pwmrate(hz)",
        "info": "Rate of the pulse-width LFO.",
        "kind": "method"
    },
    {
        "label": "pwr",
        "detail": "pwr",
        "info": "Rate of the pulse-width LFO.",
        "kind": "method"
    },
    {
        "label": "pwrate",
        "detail": "pwrate",
        "info": "Rate of the pulse-width LFO.",
        "kind": "method"
    },
    {
        "label": "pws",
        "detail": "pws",
        "info": "Depth of the pulse-width LFO.",
        "kind": "method"
    },
    {
        "label": "pwsweep",
        "detail": "pwsweep",
        "info": "Depth of the pulse-width LFO.",
        "kind": "method"
    },
    {
        "label": "q",
        "detail": "q",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "rand",
        "detail": "rand",
        "info": "Uniform random 0..1, deterministic per cycle.",
        "kind": "function"
    },
    {
        "label": "range",
        "detail": "range(lo, hi)",
        "info": "Math on values",
        "kind": "method"
    },
    {
        "label": "rangex",
        "detail": "rangex(lo, hi)",
        "info": "Math on values",
        "kind": "method"
    },
    {
        "label": "rarely",
        "detail": "rarely(fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "red",
        "detail": "red",
        "info": "Brown noise",
        "kind": "sound"
    },
    {
        "label": "rel",
        "detail": "rel",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "release",
        "detail": "release(t)",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "repeatCycles",
        "detail": "repeatCycles(n)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "replicate",
        "detail": "replicate(n)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "resonance",
        "detail": "resonance(q)",
        "info": "Low-pass filter",
        "kind": "method"
    },
    {
        "label": "rev",
        "detail": "rev",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "rib",
        "detail": "rib",
        "info": "Loop the window of that many cycles starting at offset, for as long as the pattern plays. Fractional lengths work.",
        "kind": "method"
    },
    {
        "label": "ribbon",
        "detail": "ribbon(offset, cycles)",
        "info": "Loop the window of that many cycles starting at offset, for as long as the pattern plays. Fractional lengths work.",
        "kind": "method"
    },
    {
        "label": "room",
        "detail": "room(amount)",
        "info": "Reverb / room",
        "kind": "method"
    },
    {
        "label": "roomdamp",
        "detail": "roomdamp(amount)",
        "info": "Reverb / room",
        "kind": "method"
    },
    {
        "label": "roomsize",
        "detail": "roomsize(size)",
        "info": "Reverb / room",
        "kind": "method"
    },
    {
        "label": "rootNotes",
        "detail": "rootNotes(octave)",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "run",
        "detail": "run(n)",
        "info": "Integer ramp 0..n across the cycle.",
        "kind": "function"
    },
    {
        "label": "s",
        "detail": "s",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "saw",
        "detail": "saw",
        "info": "Sawtooth ramps; isaw = inverted.",
        "kind": "function"
    },
    {
        "label": "saw2",
        "detail": "saw2",
        "info": "Sawtooth ramps; isaw = inverted.",
        "kind": "function"
    },
    {
        "label": "sawtooth",
        "detail": "sawtooth",
        "info": "Sawtooth oscillator",
        "kind": "sound"
    },
    {
        "label": "sbd",
        "detail": "sbd",
        "info": "Subtractive bass-drum synth",
        "kind": "sound"
    },
    {
        "label": "scale",
        "detail": "scale(\"name\")",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "scaleTrans",
        "detail": "scaleTrans",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "scaleTranspose",
        "detail": "scaleTranspose(n)",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "scatter",
        "detail": "scatter(v)",
        "info": "Effect quick-list (chainable)",
        "kind": "method"
    },
    {
        "label": "seg",
        "detail": "seg",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "segment",
        "detail": "segment(rate)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "setbpm",
        "detail": "setbpm(N)",
        "info": "Beats per minute. Conversion: cps = bpm / 240. Assumes 4 beats per cycle.",
        "kind": "keyword"
    },
    {
        "label": "setcpm",
        "detail": "setcpm(N)",
        "info": "Cycles per minute. cps = cpm / 60.",
        "kind": "keyword"
    },
    {
        "label": "setcps",
        "detail": "setcps(N)",
        "info": "Cycles per second, raw.",
        "kind": "keyword"
    },
    {
        "label": "shape",
        "detail": "shape(amount)",
        "info": "Distortion & shaping",
        "kind": "method"
    },
    {
        "label": "silence",
        "detail": "silence()",
        "info": "Empty pattern.",
        "kind": "function"
    },
    {
        "label": "sin",
        "detail": "sin",
        "info": "Sine oscillator",
        "kind": "sound"
    },
    {
        "label": "sine",
        "detail": "sine",
        "info": "Sine, single / double-frequency.",
        "kind": "function"
    },
    {
        "label": "sine2",
        "detail": "sine2",
        "info": "Sine, single / double-frequency.",
        "kind": "function"
    },
    {
        "label": "size",
        "detail": "size",
        "info": "Reverb / room",
        "kind": "method"
    },
    {
        "label": "slow",
        "detail": "slow(n)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "slowcat",
        "detail": "slowcat(...)",
        "info": "One pattern per cycle.",
        "kind": "function"
    },
    {
        "label": "sometimes",
        "detail": "sometimes(fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "sometimesBy",
        "detail": "sometimesBy(prob, fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "sound",
        "detail": "sound(pat)",
        "info": "Reinterpret values as sound names.",
        "kind": "function"
    },
    {
        "label": "speed",
        "detail": "speed(v)",
        "info": "Sample playback",
        "kind": "method"
    },
    {
        "label": "sq",
        "detail": "sq",
        "info": "Square oscillator",
        "kind": "sound"
    },
    {
        "label": "square",
        "detail": "square",
        "info": "Square wave.",
        "kind": "function"
    },
    {
        "label": "square2",
        "detail": "square2",
        "info": "Square wave.",
        "kind": "function"
    },
    {
        "label": "stack",
        "detail": "stack(...)",
        "info": "Play patterns simultaneously.",
        "kind": "function"
    },
    {
        "label": "strans",
        "detail": "strans",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "struct",
        "detail": "struct(pat)",
        "info": "Structure",
        "kind": "method"
    },
    {
        "label": "stut",
        "detail": "stut(times, feedback, time)",
        "info": "Stutter / echo",
        "kind": "method"
    },
    {
        "label": "stutWith",
        "detail": "stutWith(times, time, fn)",
        "info": "Stutter / echo",
        "kind": "method"
    },
    {
        "label": "sub",
        "detail": "sub(n)",
        "info": "Math on values",
        "kind": "method"
    },
    {
        "label": "sup",
        "detail": "sup",
        "info": "Stereo & layering",
        "kind": "method"
    },
    {
        "label": "superimpose",
        "detail": "superimpose(fn, ...)",
        "info": "Stereo & layering",
        "kind": "method"
    },
    {
        "label": "superpwm",
        "detail": "superpwm",
        "info": "Detuned pulse-width-modulation stack",
        "kind": "sound"
    },
    {
        "label": "supersaw",
        "detail": "supersaw",
        "info": "Detuned saw stack",
        "kind": "sound"
    },
    {
        "label": "supersquare",
        "detail": "supersquare",
        "info": "Detuned square stack",
        "kind": "sound"
    },
    {
        "label": "superzow",
        "detail": "superzow",
        "info": "Detuned \"zow\" saw/square hybrid stack",
        "kind": "sound"
    },
    {
        "label": "sus",
        "detail": "sus",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "sustain",
        "detail": "sustain(level)",
        "info": "ADSR envelope (note)",
        "kind": "method"
    },
    {
        "label": "trans",
        "detail": "trans",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "transpose",
        "detail": "transpose(n)",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "trem",
        "detail": "trem",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "tremdepth",
        "detail": "tremdepth",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "tremolo",
        "detail": "tremolo(rate)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "tremolodepth",
        "detail": "tremolodepth(depth)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "tremoloshape",
        "detail": "tremoloshape(s)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "tremshape",
        "detail": "tremshape",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "tri",
        "detail": "tri",
        "info": "Triangle.",
        "kind": "function"
    },
    {
        "label": "tri2",
        "detail": "tri2",
        "info": "Triangle.",
        "kind": "function"
    },
    {
        "label": "triangle",
        "detail": "triangle",
        "info": "Triangle oscillator",
        "kind": "sound"
    },
    {
        "label": "unit",
        "detail": "unit(name)",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "vel",
        "detail": "vel",
        "info": "Amplitude / panning",
        "kind": "method"
    },
    {
        "label": "velocity",
        "detail": "velocity(v)",
        "info": "Amplitude / panning",
        "kind": "method"
    },
    {
        "label": "verbdamp",
        "detail": "verbdamp",
        "info": "Reverb / room",
        "kind": "method"
    },
    {
        "label": "vib",
        "detail": "vib(rate)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "vibmod",
        "detail": "vibmod(depth)",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "vibrato",
        "detail": "vibrato",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "vmod",
        "detail": "vmod",
        "info": "Pitch modulation / FM",
        "kind": "method"
    },
    {
        "label": "voicing",
        "detail": "voicing()",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "voicings",
        "detail": "voicings(dict)",
        "info": "Notes / pitch / scale",
        "kind": "method"
    },
    {
        "label": "vowel",
        "detail": "vowel(v)",
        "info": "Effect quick-list (chainable)",
        "kind": "method"
    },
    {
        "label": "when",
        "detail": "when(cond, fn)",
        "info": "Conditionals",
        "kind": "method"
    },
    {
        "label": "white",
        "detail": "white",
        "info": "White noise",
        "kind": "sound"
    },
    {
        "label": "width",
        "detail": "width(v)",
        "info": "Pulse width 0–1. Setting it on a plain sine / tri / saw / square voice promotes it to a pulse oscillator. Colon form pw(\"0.3:2:0.4\") sets width, rate and depth at once.",
        "kind": "method"
    },
    {
        "label": "within",
        "detail": "within(start, end, fn)",
        "info": "Time / sequencing",
        "kind": "method"
    },
    {
        "label": "wt_bass",
        "detail": "wt_bass",
        "info": "Wavetable — electric bass",
        "kind": "sound"
    },
    {
        "label": "wt_bassoon",
        "detail": "wt_bassoon",
        "info": "Wavetable — bassoon timbre",
        "kind": "sound"
    },
    {
        "label": "wt_bell",
        "detail": "wt_bell",
        "info": "Wavetable — bell / metallic",
        "kind": "sound"
    },
    {
        "label": "wt_cello",
        "detail": "wt_cello",
        "info": "Wavetable — cello timbre",
        "kind": "sound"
    },
    {
        "label": "wt_choir",
        "detail": "wt_choir",
        "info": "Wavetable — choir / vocal",
        "kind": "sound"
    },
    {
        "label": "wt_clarinet",
        "detail": "wt_clarinet",
        "info": "Wavetable — clarinet timbre",
        "kind": "sound"
    },
    {
        "label": "wt_flute",
        "detail": "wt_flute",
        "info": "Wavetable — flute timbre",
        "kind": "sound"
    },
    {
        "label": "wt_lead",
        "detail": "wt_lead",
        "info": "Wavetable — synth lead",
        "kind": "sound"
    },
    {
        "label": "wt_oboe",
        "detail": "wt_oboe",
        "info": "Wavetable — oboe timbre",
        "kind": "sound"
    },
    {
        "label": "wt_organ",
        "detail": "wt_organ",
        "info": "Wavetable — pipe organ",
        "kind": "sound"
    },
    {
        "label": "wt_pad",
        "detail": "wt_pad",
        "info": "Wavetable — warm pad",
        "kind": "sound"
    },
    {
        "label": "wt_piano",
        "detail": "wt_piano",
        "info": "Wavetable — piano timbre",
        "kind": "sound"
    },
    {
        "label": "wt_pluck",
        "detail": "wt_pluck",
        "info": "Wavetable — plucked string",
        "kind": "sound"
    },
    {
        "label": "wt_saw",
        "detail": "wt_saw",
        "info": "Wavetable — sawtooth",
        "kind": "sound"
    },
    {
        "label": "wt_sine",
        "detail": "wt_sine",
        "info": "Wavetable — pure sine",
        "kind": "sound"
    },
    {
        "label": "wt_square",
        "detail": "wt_square",
        "info": "Wavetable — square wave",
        "kind": "sound"
    },
    {
        "label": "wt_strings",
        "detail": "wt_strings",
        "info": "Wavetable — string ensemble",
        "kind": "sound"
    },
    {
        "label": "wt_tri",
        "detail": "wt_tri",
        "info": "Wavetable — triangle (odd harmonics)",
        "kind": "sound"
    },
    {
        "label": "wt_trumpet",
        "detail": "wt_trumpet",
        "info": "Wavetable — trumpet timbre",
        "kind": "sound"
    },
    {
        "label": "wt_violin",
        "detail": "wt_violin",
        "info": "Wavetable — violin timbre",
        "kind": "sound"
    },
    {
        "label": "zoom",
        "detail": "zoom(s, e)",
        "info": "Time / sequencing",
        "kind": "method"
    }
];
