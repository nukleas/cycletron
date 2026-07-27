//! Genres as DATA — the `GenreSpec` schema and the archetype library.
//!
//! One parameterized composer ([`crate::compose::compose_from_spec`]) reads a
//! [`GenreSpec`]; families are base specs, subgenres inherit + override. Adding
//! a genre is adding data, not code. Quality stays high because every spec
//! routes through the verified generator: drum archetypes lower to an aligned
//! [`crate::grid::Grid`], bass/melody are addressed by scale degree (out-of-key
//! notes are unrepresentable), and the assembled document must pass
//! `validate_doc` before it exists.
//!
//! See `docs/GENRE_MAP_PLAN.md` — this module is the Phase 0 foundation for
//! the full electronic-genre map.

use crate::melody;

// ---------------------------------------------------------------------------
// Drum archetypes
// ---------------------------------------------------------------------------

/// How one archetype lane places its hits on the grid.
#[derive(Clone, Debug)]
pub enum LanePat {
    /// Hits on explicit step indices.
    Hits(Vec<usize>),
    /// Every `interval`-th step starting at `offset`.
    Every { interval: usize, offset: usize },
    /// Bjorklund `k` pulses over `n` slots, tiled (n must divide grid steps).
    Euclid { k: usize, n: usize },
    /// Ratchets: `(step, subdivision)` pairs — `(7, 3)` rolls an `x*3` in step 7.
    Ratchet(Vec<(usize, u8)>),
}

impl LanePat {
    /// Lower to a per-step count vector (`0` rest, `1` hit, `n ≥ 2` ratchet)
    /// exactly `steps` wide — the raw form [`crate::grid::Grid::lane`] takes.
    pub fn counts(&self, steps: usize) -> Result<Vec<u8>, String> {
        match self {
            LanePat::Hits(positions) => {
                let mut counts = vec![0u8; steps];
                for &p in positions {
                    if p < steps {
                        counts[p] = 1;
                    }
                }
                Ok(counts)
            }
            LanePat::Every { interval, offset } => {
                if *interval == 0 {
                    return Err("every: interval must be > 0".into());
                }
                Ok((0..steps)
                    .map(|i| u8::from(i >= *offset && (i - offset) % interval == 0))
                    .collect())
            }
            LanePat::Euclid { k, n } => {
                if *n == 0 || steps % n != 0 {
                    return Err(format!("euclid n ({n}) must divide grid steps ({steps})"));
                }
                let cell = crate::grid::bjorklund(*k, *n);
                Ok((0..steps).map(|i| u8::from(cell[i % n])).collect())
            }
            LanePat::Ratchet(rolls) => {
                let mut counts = vec![0u8; steps];
                for &(p, div) in rolls {
                    if p < steps && div > 0 {
                        counts[p] = div;
                    }
                }
                Ok(counts)
            }
        }
    }
}

/// One lane an archetype contributes: a sound, a placement, and whether the
/// lane participates in swing (offbeat hits get `.late()`-nudged).
#[derive(Clone, Debug)]
pub struct LaneSpec {
    pub sound: &'static str,
    pub pat: LanePat,
    pub swings: bool,
}

impl LaneSpec {
    fn straight(sound: &'static str, pat: LanePat) -> Self {
        LaneSpec { sound, pat, swings: false }
    }
    fn swung(sound: &'static str, pat: LanePat) -> Self {
        LaneSpec { sound, pat, swings: true }
    }
}

/// Reusable drum building blocks. Each lowers to one or more grid lanes, so a
/// genre's drum section is a layered `Vec<DrumArchetype>` and every layer is
/// round-trip verified. Sounds are restricted to the default bank
/// (`bd sd hh oh cp mt lt rs …`) so they always resolve.
#[derive(Clone, Debug, PartialEq)]
pub enum DrumArchetype {
    /// Kick on every beat — house/techno/trance backbone.
    FourOnFloor,
    /// Open hat on the offbeat 8ths (the house "tsss").
    OffbeatOpenHat,
    /// Clap on beats 2 and 4.
    BackbeatClap,
    /// Snare on beats 2 and 4.
    BackbeatSnare,
    /// Closed hats every `interval` 16ths from `offset` (2,0 = straight 8ths;
    /// 1,0 = 16ths; 2,1 = offbeat 8ths).
    ClosedHats { interval: usize, offset: usize },
    /// DnB two-step: kick on 1 and the "&" of 3, snare on 2 and 4.
    TwoStep,
    /// Hip-hop boom-bap: syncopated kick, snare on 2 and 4.
    BoomBap,
    /// Funky-drummer-style break: displaced kick, snare with a ghost push.
    Breakbeat,
    /// Amen-flavoured chop: doubled kicks, displaced snares.
    Amen,
    /// Gabber: four-on-floor plus a pickup kick driving into the next bar.
    /// (The distortion lives in the spec's `drum_fx`, not the placement.)
    GabberKick,
    /// Half-time: kick on 1, snare on 3 — dubstep/trap skeleton.
    HalfTime,
    /// Trap hats: straight 8ths with triplet/quad rolls late in the bar.
    TrapHats,
    /// Footwork/juke rapid 808 kicks: dense syncopated pulse.
    Rapid808,
    /// Amapiano log drum: syncopated low tom, avoiding the downbeat grid.
    LogDrum,
    /// UK garage shuffled 2-step: two-step core with swung offbeat hats.
    Shuffled2Step,
    /// Dub: kick on 1 and 3, rimshot cross-stick on 2 and 4.
    DubSkank,
    /// The basic rock backbeat: kick on 1 and 3, snare on 2 and 4 —
    /// synth-pop/new-wave/chiptune skeleton.
    RockBeat,
    /// A euclidean tom line (`k` pulses over `n` slots).
    EuclidTom { k: usize, n: usize },
    /// A sparse soft pulse (ambient motion without a beat).
    SparsePulse,
}

impl DrumArchetype {
    /// The grid lanes this archetype contributes, in stack order.
    pub fn lanes(&self) -> Vec<LaneSpec> {
        use DrumArchetype::*;
        use LanePat::*;
        match self {
            FourOnFloor => vec![LaneSpec::straight("bd", Every { interval: 4, offset: 0 })],
            OffbeatOpenHat => vec![LaneSpec::swung("oh", Every { interval: 4, offset: 2 })],
            BackbeatClap => vec![LaneSpec::straight("cp", Hits(vec![4, 12]))],
            BackbeatSnare => vec![LaneSpec::straight("sd", Hits(vec![4, 12]))],
            ClosedHats { interval, offset } => vec![LaneSpec::swung(
                "hh",
                Every { interval: *interval, offset: *offset },
            )],
            TwoStep => vec![
                LaneSpec::straight("bd", Hits(vec![0, 10])),
                LaneSpec::straight("sd", Hits(vec![4, 12])),
            ],
            BoomBap => vec![
                LaneSpec::straight("bd", Hits(vec![0, 6, 10])),
                LaneSpec::straight("sd", Hits(vec![4, 12])),
            ],
            Breakbeat => vec![
                LaneSpec::straight("bd", Hits(vec![0, 10])),
                LaneSpec::straight("sd", Hits(vec![4, 7, 12])),
            ],
            Amen => vec![
                LaneSpec::straight("bd", Hits(vec![0, 2, 8, 10])),
                LaneSpec::straight("sd", Hits(vec![4, 7, 12, 14])),
            ],
            GabberKick => vec![LaneSpec::straight("bd", Hits(vec![0, 4, 8, 12, 14]))],
            HalfTime => vec![
                LaneSpec::straight("bd", Hits(vec![0])),
                LaneSpec::straight("sd", Hits(vec![8])),
            ],
            TrapHats => vec![
                LaneSpec::straight("hh", Every { interval: 2, offset: 0 }),
                LaneSpec::straight("hh", Ratchet(vec![(7, 3), (15, 4)])),
            ],
            Rapid808 => vec![LaneSpec::straight("bd", Hits(vec![0, 3, 6, 10, 13]))],
            LogDrum => vec![LaneSpec::straight("lt", Hits(vec![3, 6, 10, 14]))],
            Shuffled2Step => vec![
                LaneSpec::straight("bd", Hits(vec![0, 10])),
                LaneSpec::straight("sd", Hits(vec![4, 12])),
                LaneSpec::swung("hh", Every { interval: 2, offset: 1 }),
            ],
            DubSkank => vec![
                LaneSpec::straight("bd", Hits(vec![0, 8])),
                LaneSpec::straight("rs", Hits(vec![4, 12])),
            ],
            RockBeat => vec![
                LaneSpec::straight("bd", Hits(vec![0, 8])),
                LaneSpec::straight("sd", Hits(vec![4, 12])),
            ],
            EuclidTom { k, n } => vec![LaneSpec::straight("mt", Euclid { k: *k, n: *n })],
            SparsePulse => vec![LaneSpec::straight("hh", Hits(vec![0, 8]))],
        }
    }

    /// Short human label for map rendering ("four-on-floor", "closed-hats(2,1)").
    pub fn label(&self) -> String {
        use DrumArchetype::*;
        match self {
            FourOnFloor => "four-on-floor".into(),
            OffbeatOpenHat => "offbeat-open-hat".into(),
            BackbeatClap => "backbeat-clap".into(),
            BackbeatSnare => "backbeat-snare".into(),
            ClosedHats { interval, offset } => format!("closed-hats({interval},{offset})"),
            TwoStep => "two-step".into(),
            BoomBap => "boom-bap".into(),
            Breakbeat => "breakbeat".into(),
            Amen => "amen".into(),
            GabberKick => "gabber-kick".into(),
            HalfTime => "half-time".into(),
            TrapHats => "trap-hats".into(),
            Rapid808 => "rapid-808".into(),
            LogDrum => "log-drum".into(),
            Shuffled2Step => "shuffled-2step".into(),
            DubSkank => "dub-skank".into(),
            RockBeat => "rock-beat".into(),
            EuclidTom { k, n } => format!("euclid-tom({k},{n})"),
            SparsePulse => "sparse-pulse".into(),
        }
    }

    /// One of each archetype (representative params) — the library, for tests
    /// and for browsing the palette of building blocks.
    pub fn library() -> Vec<DrumArchetype> {
        use DrumArchetype::*;
        vec![
            FourOnFloor,
            OffbeatOpenHat,
            BackbeatClap,
            BackbeatSnare,
            ClosedHats { interval: 2, offset: 0 },
            TwoStep,
            BoomBap,
            Breakbeat,
            Amen,
            GabberKick,
            HalfTime,
            TrapHats,
            Rapid808,
            LogDrum,
            Shuffled2Step,
            DubSkank,
            RockBeat,
            EuclidTom { k: 5, n: 16 },
            SparsePulse,
        ]
    }
}

// ---------------------------------------------------------------------------
// Bass styles
// ---------------------------------------------------------------------------

/// Bass movement styles. Each lowers to a slot line of *scale degrees*
/// (`Some(deg)` / `None` rests), so the bass is diatonic by construction.
/// `scale_len` is the mode's notes-per-octave (7 diatonic, 5 pentatonic) —
/// styles use it for octave lifts and flat-7s so they transpose across modes.
#[derive(Clone, Debug, PartialEq)]
pub enum BassStyle {
    /// A single sustained root — ambient drones (pair with a long-attack fx).
    Drone,
    /// Root on the "and" of every beat, lifting to the octave at the turn —
    /// the house pulse.
    OffbeatRoot,
    /// Sparse low riff: root … flat-7 … octave — reese/DnB movement.
    ReeseSparse,
    /// Driving 16th root pulse with one passing tone — the techno engine.
    Rolling16th,
    /// Walking: root, 5th, root, flat-7, one note per beat.
    Walking,
    /// Root/octave bounce on 8ths — electro/synthwave.
    OctaveBounce,
    /// Long sub hits on 1 and the "&" of 3 — trap/dubstep 808s.
    Sub808,
    /// Half-note roots — the wobble carrier (movement comes from filter fx).
    SubWobble,
    /// A seeded 16th-note acid line: in-scale walk with rests every 4th slot.
    Acid303,
}

impl BassStyle {
    /// Lower to a slot line. `seed` only affects seeded styles (acid).
    pub fn slots(&self, scale_len: i32, seed: u64) -> Vec<Option<i32>> {
        match self {
            BassStyle::Drone => vec![Some(0)],
            BassStyle::OffbeatRoot => vec![
                None,
                Some(0),
                None,
                Some(0),
                None,
                Some(0),
                None,
                Some(scale_len),
            ],
            BassStyle::ReeseSparse => vec![
                Some(0),
                None,
                None,
                Some(scale_len - 1),
                None,
                None,
                Some(scale_len),
                None,
            ],
            BassStyle::Rolling16th => {
                // Root on every 8th; a passing tone on the "a" of beat 3.
                (0..16)
                    .map(|i| {
                        if i % 2 == 0 {
                            Some(0)
                        } else if i == 11 {
                            Some(1)
                        } else {
                            None
                        }
                    })
                    .collect()
            }
            BassStyle::Walking => vec![
                Some(0),
                None,
                Some(4),
                None,
                Some(0),
                None,
                Some(scale_len - 1),
                None,
            ],
            BassStyle::OctaveBounce => vec![
                Some(0),
                None,
                Some(scale_len),
                None,
                Some(0),
                None,
                Some(scale_len),
                None,
            ],
            BassStyle::Sub808 => (0..16)
                .map(|i| if i == 0 || i == 10 { Some(0) } else { None })
                .collect(),
            BassStyle::SubWobble => vec![Some(0), None, None, None, Some(0), None, None, None],
            BassStyle::Acid303 => {
                let line = melody::walk(seed, 16, 0, 3, -2, scale_len);
                line.iter()
                    .enumerate()
                    .map(|(i, &d)| if i % 4 == 3 { None } else { Some(d) })
                    .collect()
            }
        }
    }

    /// Short human label for map rendering.
    pub fn label(&self) -> &'static str {
        use BassStyle::*;
        match self {
            Drone => "drone",
            OffbeatRoot => "offbeat-root",
            ReeseSparse => "reese",
            Rolling16th => "rolling-16th",
            Walking => "walking",
            OctaveBounce => "octave",
            Sub808 => "sub-808",
            SubWobble => "sub-wobble",
            Acid303 => "acid-303",
        }
    }

    /// The whole style library, for tests.
    pub fn library() -> Vec<BassStyle> {
        use BassStyle::*;
        vec![
            Drone, OffbeatRoot, ReeseSparse, Rolling16th, Walking, OctaveBounce, Sub808,
            SubWobble, Acid303,
        ]
    }
}

/// A genre's bass voice: style + register + sound + effect chain tail.
#[derive(Clone, Debug)]
pub struct BassSpec {
    pub style: BassStyle,
    pub octave: i32,
    pub sound: String,
    /// Method-chain tail after `.s("…")`, e.g. `".lpf(600).gain(0.5)"`.
    pub fx: String,
}

// ---------------------------------------------------------------------------
// Harmony / melody
// ---------------------------------------------------------------------------

/// Chord voicing depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Voicing {
    Triad,
    Seventh,
}

/// A genre's harmony voice: a diatonic progression (roots as scale degrees,
/// one chord per cycle) with a rhythmic mask.
#[derive(Clone, Debug)]
pub struct HarmonySpec {
    /// Progression roots as scale degrees (0 = tonic): `[0, 5, 6, 4]` = i–VI–VII–v.
    pub degrees: Vec<i32>,
    pub octave: i32,
    pub voicing: Voicing,
    /// Stab rhythm as a `struct` mask (`[false, true, false, true]` → `"~ 1 ~ 1"`).
    /// Empty = sustained (no `struct`).
    pub rhythm: Vec<bool>,
    pub sound: String,
    pub fx: String,
}

/// A genre's melody voice.
#[derive(Clone, Debug)]
pub enum MelodySpec {
    /// No lead line.
    None,
    /// A seeded in-scale walk ([`melody::walk`]) thinned to every
    /// `density`-th slot (rests elsewhere) — the sparse generated lead.
    Walk {
        len: usize,
        start: i32,
        max_step: i32,
        lo: i32,
        hi: i32,
        /// Keep slot `i` when `i % density == 0` (2 = half the slots, 3 = a third).
        density: usize,
        octave: i32,
        sound: String,
        fx: String,
    },
    /// A deterministic arpeggio ([`melody::arpeggio`]) over `chord` degrees —
    /// the trance / italo / Berlin-school sequencer line. Note count =
    /// `chord.len() × octaves` (up/down shapes mirror), which sets the bar
    /// subdivision.
    Arpeggio {
        /// Chord degrees relative to the scale (e.g. `[0, 2, 4, 7]`).
        chord: Vec<i32>,
        octaves: usize,
        dir: melody::Dir,
        octave: i32,
        sound: String,
        fx: String,
    },
}

// ---------------------------------------------------------------------------
// Feel + form
// ---------------------------------------------------------------------------

/// Which grid columns swing: offbeat 8ths (steps 2,6,10,…) or offbeat 16ths
/// (odd steps). Swung hits on `swings` lanes are pulled into their own part
/// and `.late()`-nudged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwingUnit {
    Eighth,
    Sixteenth,
}

impl SwingUnit {
    /// Is grid column `i` a swung column for this unit?
    pub fn is_swung_step(&self, i: usize) -> bool {
        match self {
            SwingUnit::Eighth => i % 4 == 2,
            SwingUnit::Sixteenth => i % 2 == 1,
        }
    }

    /// Cycle-fraction delay for a swing `amount` in `[0, 1]`. `amount = 2/3`
    /// ≈ classic triplet swing (the offbeat lands on the last triplet third).
    pub fn delay(&self, amount: f64, steps: usize) -> f64 {
        let unit_len = match self {
            SwingUnit::Eighth => 2.0 / steps as f64,
            SwingUnit::Sixteenth => 1.0 / steps as f64,
        };
        amount * unit_len / 2.0
    }
}

/// An arrangement sketch: named sections and their cycle counts. Phase 0
/// carries the data; Phase 1 lowers it through `song::arrange`.
#[derive(Clone, Debug)]
pub struct FormSketch {
    pub sections: Vec<(String, u32)>,
}

// ---------------------------------------------------------------------------
// GenreSpec + registry
// ---------------------------------------------------------------------------

/// A genre as data. Everything `compose_from_spec` needs to produce a
/// complete, verified piece.
#[derive(Clone, Debug)]
pub struct GenreSpec {
    /// Canonical kebab-case name — also the `corpus/genres/<name>/` folder.
    pub name: String,
    /// Human display name used in the generated title ("deep house").
    pub display: String,
    /// Family → this genre, e.g. `["house", "deep house"]`.
    pub lineage: Vec<String>,
    /// Alternate names `find` should route here (kebab-case).
    pub aliases: Vec<&'static str>,
    /// BPM range; the composer picks the centre.
    pub bpm: (u32, u32),
    /// Swing amount in `[0, 1]` (0 = straight; ≈0.66 = triplet feel).
    pub swing: f64,
    pub swing_unit: SwingUnit,
    /// Scale spec, e.g. `"a minor"`, `"c phrygian"` (parsed by `Scale::parse`).
    pub scale: String,
    /// Mood tag ("warm", "dark", …) — map metadata, not (yet) sound-affecting.
    pub mood: String,
    /// Title tail describing the construction ("four-on-floor, offbeat bass, …").
    pub desc: String,
    /// Grid resolution (16 = one bar of 16ths).
    pub steps: usize,
    pub drums: Vec<DrumArchetype>,
    /// Chain tail for the drum part, e.g. `".gain(0.9)"`.
    pub drum_fx: String,
    pub bass: Option<BassSpec>,
    pub harmony: Option<HarmonySpec>,
    pub melody: MelodySpec,
    /// Optional arrangement sketch (Phase 1).
    pub form: Option<FormSketch>,
}

impl GenreSpec {
    /// Derive a subgenre spec from this one: clone everything, rename, and
    /// extend the lineage — then override fields freely. This is the
    /// "families are base specs, subgenres inherit + override" mechanism:
    ///
    /// ```
    /// # use cycletron_gen::spec;
    /// let mut tech_house = spec::find("house").unwrap().derive("tech-house", "tech house");
    /// tech_house.bpm = (124, 128);
    /// tech_house.mood = "groovy".into();
    /// ```
    pub fn derive(&self, name: &str, display: &str) -> GenreSpec {
        let mut sub = self.clone();
        sub.name = name.to_string();
        sub.display = display.to_string();
        sub.aliases = Vec::new();
        sub.lineage.push(display.to_string());
        sub
    }
}

/// The spec registry: every genre the generator can compose — the Phase 0
/// five (byte-identical regression oracle, see `compose::tests`) plus the
/// full populated map from [`crate::genres`].
pub fn registry() -> Vec<GenreSpec> {
    let mut v = vec![house(), drum_and_bass(), techno(), ambient(), hip_hop()];
    v.extend(crate::genres::extras());
    v
}

/// Find a spec by name, alias, or lineage entry (case/space/underscore
/// tolerant).
pub fn find(genre: &str) -> Option<GenreSpec> {
    let norm = normalize(genre);
    registry().into_iter().find(|s| {
        s.name == norm
            || s.aliases.iter().any(|a| *a == norm)
            || s.lineage.iter().any(|l| normalize(l) == norm)
    })
}

fn normalize(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace([' ', '_'], "-")
}

fn house() -> GenreSpec {
    GenreSpec {
        name: "house".into(),
        display: "deep house".into(),
        lineage: vec!["house".into(), "deep house".into()],
        aliases: vec!["deep-house"],
        bpm: (120, 124),
        swing: 0.0,
        swing_unit: SwingUnit::Sixteenth,
        scale: "a minor".into(),
        mood: "warm".into(),
        desc: "four-on-floor, offbeat bass, 7th stabs".into(),
        steps: 16,
        drums: vec![
            DrumArchetype::FourOnFloor,
            DrumArchetype::OffbeatOpenHat,
            DrumArchetype::BackbeatClap,
            DrumArchetype::ClosedHats { interval: 2, offset: 0 },
        ],
        drum_fx: ".gain(0.9)".into(),
        bass: Some(BassSpec {
            style: BassStyle::OffbeatRoot,
            octave: 2,
            sound: "sawtooth".into(),
            fx: ".lpf(600).resonance(6).gain(0.5)".into(),
        }),
        harmony: Some(HarmonySpec {
            degrees: vec![0, 5, 6, 4],
            octave: 3,
            voicing: Voicing::Seventh,
            rhythm: vec![false, true, false, true],
            sound: "sawtooth".into(),
            fx: ".release(0.16).lpf(1900).gain(0.42).room(0.3)".into(),
        }),
        melody: MelodySpec::Walk {
            len: 8,
            start: 7,
            max_step: 2,
            lo: 4,
            hi: 12,
            density: 2,
            octave: 4,
            sound: "triangle".into(),
            fx: ".delay(0.25).room(0.3).gain(0.35)".into(),
        },
        form: None,
    }
}

fn drum_and_bass() -> GenreSpec {
    GenreSpec {
        name: "drum-and-bass".into(),
        display: "drum & bass".into(),
        lineage: vec!["drum & bass".into()],
        aliases: vec!["dnb", "d-n-b", "jungle", "neurofunk"],
        // neurofunk stays here: the Phase 0 dnb spec IS reese-driven dark dnb.
        bpm: (172, 176),
        swing: 0.0,
        swing_unit: SwingUnit::Sixteenth,
        scale: "c minor".into(),
        mood: "dark".into(),
        desc: "two-step break, reese bass, minor stabs".into(),
        steps: 16,
        drums: vec![
            DrumArchetype::TwoStep,
            DrumArchetype::ClosedHats { interval: 1, offset: 0 },
        ],
        drum_fx: ".gain(0.92)".into(),
        bass: Some(BassSpec {
            style: BassStyle::ReeseSparse,
            octave: 1,
            sound: "supersaw".into(),
            fx: ".lpf(700).resonance(9).gain(0.5)".into(),
        }),
        harmony: Some(HarmonySpec {
            degrees: vec![0, 5, 2, 6],
            octave: 3,
            voicing: Voicing::Seventh,
            rhythm: vec![false, true],
            sound: "sawtooth".into(),
            fx: ".release(0.18).lpf(1500).gain(0.34).room(0.3)".into(),
        }),
        melody: MelodySpec::None,
        form: None,
    }
}

fn techno() -> GenreSpec {
    GenreSpec {
        name: "techno".into(),
        display: "techno".into(),
        lineage: vec!["techno".into()],
        aliases: vec![],
        bpm: (128, 132),
        swing: 0.0,
        swing_unit: SwingUnit::Sixteenth,
        scale: "c phrygian".into(),
        mood: "dark".into(),
        desc: "four-on-floor, euclid tom, driving bass".into(),
        steps: 16,
        drums: vec![
            DrumArchetype::FourOnFloor,
            DrumArchetype::BackbeatClap,
            DrumArchetype::ClosedHats { interval: 2, offset: 1 },
            DrumArchetype::EuclidTom { k: 5, n: 16 },
        ],
        drum_fx: ".gain(0.9)".into(),
        bass: Some(BassSpec {
            style: BassStyle::Rolling16th,
            octave: 2,
            sound: "sawtooth".into(),
            fx: ".lpf(900).resonance(8).gain(0.5)".into(),
        }),
        harmony: Some(HarmonySpec {
            degrees: vec![0, 1],
            octave: 3,
            voicing: Voicing::Seventh,
            rhythm: vec![false, false, true, false],
            sound: "sawtooth".into(),
            fx: ".release(0.2).lpf(1400).gain(0.3).room(0.2)".into(),
        }),
        melody: MelodySpec::None,
        form: None,
    }
}

fn ambient() -> GenreSpec {
    GenreSpec {
        name: "ambient".into(),
        display: "ambient".into(),
        lineage: vec!["ambient".into()],
        aliases: vec!["drone"],
        bpm: (56, 60),
        swing: 0.0,
        swing_unit: SwingUnit::Sixteenth,
        scale: "c major".into(),
        mood: "spacious".into(),
        desc: "drone, long-attack pad, drifting bells".into(),
        steps: 16,
        drums: vec![DrumArchetype::SparsePulse],
        drum_fx: ".gain(0.2).room(0.6)".into(),
        bass: Some(BassSpec {
            style: BassStyle::Drone,
            octave: 2,
            sound: "sine".into(),
            fx: ".attack(3).release(5).gain(0.45)".into(),
        }),
        harmony: Some(HarmonySpec {
            degrees: vec![0, 3, 5, 4],
            octave: 3,
            voicing: Voicing::Seventh,
            rhythm: vec![],
            sound: "sawtooth".into(),
            fx: ".attack(2).release(4).lpf(1000).gain(0.32).room(0.85)".into(),
        }),
        melody: MelodySpec::Walk {
            len: 8,
            start: 7,
            max_step: 2,
            lo: 4,
            hi: 11,
            density: 3,
            octave: 4,
            sound: "gm_kalimba".into(),
            fx: ".room(0.7).delay(0.4).gain(0.33)".into(),
        },
        form: None,
    }
}

fn hip_hop() -> GenreSpec {
    GenreSpec {
        name: "hip-hop".into(),
        display: "lo-fi hip-hop".into(),
        lineage: vec!["hip-hop".into(), "lo-fi hip-hop".into()],
        aliases: vec!["hiphop", "lo-fi", "lofi", "lo-fi-hip-hop", "boom-bap"],
        bpm: (83, 87),
        swing: 0.0,
        swing_unit: SwingUnit::Eighth,
        scale: "d dorian".into(),
        mood: "warm".into(),
        desc: "boom-bap, walking bass, Rhodes 7ths".into(),
        steps: 16,
        drums: vec![
            DrumArchetype::BoomBap,
            DrumArchetype::ClosedHats { interval: 2, offset: 0 },
        ],
        drum_fx: ".gain(0.85)".into(),
        bass: Some(BassSpec {
            style: BassStyle::Walking,
            octave: 2,
            sound: "gm_acoustic_bass".into(),
            fx: ".gain(0.6)".into(),
        }),
        harmony: Some(HarmonySpec {
            degrees: vec![0, 3, 4, 0],
            octave: 3,
            voicing: Voicing::Seventh,
            rhythm: vec![],
            sound: "gm_epiano1".into(),
            fx: ".release(0.4).gain(0.42).room(0.3)".into(),
        }),
        melody: MelodySpec::Walk {
            len: 8,
            start: 4,
            max_step: 2,
            lo: 2,
            hi: 11,
            density: 2,
            octave: 4,
            sound: "triangle".into(),
            fx: ".room(0.3).delay(0.2).gain(0.3)".into(),
        },
        form: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_routes_names_aliases_and_lineage() {
        assert_eq!(find("house").unwrap().name, "house");
        assert_eq!(find("Deep House").unwrap().name, "house");
        assert_eq!(find("dnb").unwrap().name, "drum-and-bass");
        assert_eq!(find("lo_fi").unwrap().name, "hip-hop");
        assert_eq!(find("boom-bap").unwrap().name, "hip-hop");
        assert!(find("polka").is_none());
    }

    #[test]
    fn bass_styles_stay_in_degree_range() {
        for style in BassStyle::library() {
            let slots = style.slots(7, 42);
            assert!(!slots.is_empty());
            assert!(
                slots.iter().flatten().all(|&d| (-7..=14).contains(&d)),
                "{style:?} strayed: {slots:?}"
            );
        }
    }

    #[test]
    fn swing_units_pick_the_offbeats() {
        let e = SwingUnit::Eighth;
        assert!(e.is_swung_step(2) && e.is_swung_step(6));
        assert!(!e.is_swung_step(0) && !e.is_swung_step(4) && !e.is_swung_step(1));
        let s = SwingUnit::Sixteenth;
        assert!(s.is_swung_step(1) && s.is_swung_step(15));
        assert!(!s.is_swung_step(2));
        // Triplet swing on 16 steps: offbeat 8th delayed by 1/24 cycle.
        assert!((e.delay(2.0 / 3.0, 16) - 1.0 / 24.0).abs() < 1e-9);
    }
}
