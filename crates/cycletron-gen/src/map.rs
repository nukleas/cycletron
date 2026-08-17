//! The genre map — the electronic-music taxonomy as a spec tree.
//!
//! Phase 1 of `docs/GENRE_MAP_PLAN.md`: every family and flagship subgenre
//! from the agreed skeleton, encoded as data. Each [`MapEntry`] carries the
//! rough parameters (bpm band, mood, drum archetypes, bass style, swing) that
//! seed a full [`crate::spec::GenreSpec`] in Phase 2. Coverage is *computed*,
//! never hand-maintained: an entry is spec-covered when [`crate::spec::find`]
//! resolves it, recipe-covered when `corpus/genres/<name>.md` exists (the
//! `gen_map` example checks the filesystem and renders `corpus/genres/_map.md`).
//!
//! The archetype hints are not decoration — every entry's drum stack must
//! lower to a round-trip-verified grid (see tests), so even a "sketch" is
//! already provably alignable. Phase 2 turns sketches into full specs via
//! [`crate::spec::GenreSpec::derive`] + research (`/research-genre`, DB
//! tempo/sound mining).

use crate::spec::{BassStyle, DrumArchetype, GenreSpec};

/// One genre on the map: the plan-table row as data.
#[derive(Clone, Debug)]
pub struct MapEntry {
    /// Canonical kebab-case name (also the future `corpus/genres/<name>/`).
    pub name: String,
    pub display: String,
    /// Typical tempo band.
    pub bpm: (u32, u32),
    /// Mood tag from the skeleton ("warm", "brutal", "hazy", …).
    pub mood: String,
    /// Swing hint in `[0, 1]` (garage shuffle, hip-hop drag).
    pub swing: f64,
    /// Layered drum archetypes (may be empty — beatless ambient).
    pub drums: Vec<DrumArchetype>,
    /// Bass movement hint.
    pub bass: Option<BassStyle>,
}

/// A family row: the base style plus its flagship subgenres.
#[derive(Clone, Debug)]
pub struct Family {
    pub name: String,
    pub display: String,
    pub genres: Vec<MapEntry>,
}

impl MapEntry {
    /// The full spec behind this entry, if the registry composes it today.
    pub fn spec(&self) -> Option<GenreSpec> {
        crate::spec::find(&self.name)
    }
}

fn entry(
    name: &str,
    display: &str,
    bpm: (u32, u32),
    mood: &str,
    swing: f64,
    drums: Vec<DrumArchetype>,
    bass: Option<BassStyle>,
) -> MapEntry {
    MapEntry {
        name: name.into(),
        display: display.into(),
        bpm,
        mood: mood.into(),
        swing,
        drums,
        bass,
    }
}

fn family(name: &str, display: &str, genres: Vec<MapEntry>) -> Family {
    Family {
        name: name.into(),
        display: display.into(),
        genres,
    }
}

/// The whole map: 22 families, ~60 flagship genres, in taxonomy order.
pub fn families() -> Vec<Family> {
    use BassStyle::*;
    use DrumArchetype::*;
    let hats = |interval: usize, offset: usize| ClosedHats { interval, offset };
    vec![
        family(
            "house",
            "House",
            vec![
                entry(
                    "deep-house",
                    "deep house",
                    (120, 124),
                    "warm",
                    0.0,
                    vec![FourOnFloor, OffbeatOpenHat, BackbeatClap, hats(2, 0)],
                    Some(OffbeatRoot),
                ),
                entry(
                    "tech-house",
                    "tech house",
                    (124, 128),
                    "groovy",
                    0.0,
                    vec![FourOnFloor, OffbeatOpenHat, BackbeatClap, hats(2, 1)],
                    Some(OffbeatRoot),
                ),
                entry(
                    "acid-house",
                    "acid house",
                    (123, 127),
                    "raw",
                    0.0,
                    vec![FourOnFloor, OffbeatOpenHat, BackbeatClap],
                    Some(Acid303),
                ),
            ],
        ),
        family(
            "techno",
            "Techno",
            vec![
                entry(
                    "detroit-techno",
                    "Detroit techno",
                    (126, 130),
                    "soulful",
                    0.0,
                    vec![FourOnFloor, BackbeatClap, hats(2, 1)],
                    Some(Rolling16th),
                ),
                entry(
                    "minimal-techno",
                    "minimal techno",
                    (126, 130),
                    "hypnotic",
                    0.0,
                    vec![FourOnFloor, hats(2, 1)],
                    Some(Rolling16th),
                ),
                entry(
                    "dub-techno",
                    "dub techno",
                    (118, 122),
                    "deep",
                    0.0,
                    vec![FourOnFloor, hats(2, 1)],
                    Some(SubWobble),
                ),
                entry(
                    "hard-techno",
                    "hard techno",
                    (138, 145),
                    "dark",
                    0.0,
                    vec![FourOnFloor, BackbeatClap, hats(1, 0)],
                    Some(Rolling16th),
                ),
                entry(
                    "acid-techno",
                    "acid techno",
                    (128, 132),
                    "squelchy",
                    0.0,
                    vec![FourOnFloor, BackbeatClap, hats(2, 1)],
                    Some(Acid303),
                ),
            ],
        ),
        family(
            "trance",
            "Trance",
            vec![
                entry(
                    "uplifting-trance",
                    "uplifting trance",
                    (136, 140),
                    "euphoric",
                    0.0,
                    vec![FourOnFloor, OffbeatOpenHat, BackbeatClap, hats(1, 0)],
                    Some(Rolling16th),
                ),
                entry(
                    "psytrance",
                    "psytrance",
                    (142, 148),
                    "psychedelic",
                    0.0,
                    vec![FourOnFloor, hats(2, 1)],
                    Some(Rolling16th),
                ),
                entry(
                    "progressive-trance",
                    "progressive trance",
                    (130, 134),
                    "hypnotic",
                    0.0,
                    vec![FourOnFloor, OffbeatOpenHat, hats(2, 0)],
                    Some(OffbeatRoot),
                ),
            ],
        ),
        family(
            "drum-and-bass",
            "Drum & Bass",
            vec![
                entry(
                    "liquid-dnb",
                    "liquid drum & bass",
                    (172, 176),
                    "lush",
                    0.0,
                    vec![TwoStep, hats(1, 0)],
                    Some(Sub808),
                ),
                entry(
                    "neurofunk",
                    "neurofunk",
                    (172, 176),
                    "dark",
                    0.0,
                    vec![TwoStep, hats(1, 0)],
                    Some(ReeseSparse),
                ),
                entry(
                    "jump-up",
                    "jump-up",
                    (172, 176),
                    "bouncy",
                    0.0,
                    vec![TwoStep, hats(2, 0)],
                    Some(OctaveBounce),
                ),
            ],
        ),
        family(
            "bass",
            "Bass / Dubstep",
            vec![
                entry(
                    "dubstep",
                    "dubstep",
                    (138, 142),
                    "heavy",
                    0.0,
                    vec![HalfTime, hats(2, 0)],
                    Some(SubWobble),
                ),
                entry(
                    "future-bass",
                    "future bass",
                    (145, 155),
                    "bright",
                    0.0,
                    vec![HalfTime, TrapHats],
                    Some(Sub808),
                ),
                entry(
                    "trap-edm",
                    "trap (EDM)",
                    (138, 142),
                    "hard",
                    0.0,
                    vec![HalfTime, TrapHats],
                    Some(Sub808),
                ),
            ],
        ),
        family(
            "breakbeat",
            "Breakbeat",
            vec![
                entry(
                    "big-beat",
                    "big beat",
                    (128, 132),
                    "funky",
                    0.0,
                    vec![Breakbeat, hats(2, 0)],
                    Some(OctaveBounce),
                ),
                entry(
                    "nu-skool-breaks",
                    "nu skool breaks",
                    (128, 132),
                    "electro",
                    0.0,
                    vec![Breakbeat, hats(2, 1)],
                    Some(ReeseSparse),
                ),
                entry(
                    "broken-beat",
                    "broken beat",
                    (118, 122),
                    "jazzy",
                    0.3,
                    vec![Breakbeat, hats(2, 1)],
                    Some(Walking),
                ),
            ],
        ),
        family(
            "uk-garage",
            "UK Garage",
            vec![
                entry(
                    "2-step-garage",
                    "2-step garage",
                    (128, 132),
                    "shuffled",
                    0.55,
                    vec![Shuffled2Step],
                    Some(Sub808),
                ),
                entry(
                    "speed-garage",
                    "speed garage",
                    (133, 137),
                    "bassy",
                    0.4,
                    vec![TwoStep, hats(2, 1)],
                    Some(ReeseSparse),
                ),
                entry(
                    "future-garage",
                    "future garage",
                    (132, 138),
                    "moody",
                    0.5,
                    vec![Shuffled2Step],
                    Some(Sub808),
                ),
                entry(
                    "grime",
                    "grime",
                    (138, 142),
                    "gritty",
                    0.0,
                    vec![HalfTime, hats(2, 0)],
                    Some(Sub808),
                ),
            ],
        ),
        family(
            "hardcore",
            "Hardcore",
            vec![
                entry(
                    "gabber",
                    "gabber",
                    (175, 185),
                    "brutal",
                    0.0,
                    vec![GabberKick, hats(2, 1)],
                    Some(Rolling16th),
                ),
                entry(
                    "happy-hardcore",
                    "happy hardcore",
                    (165, 175),
                    "euphoric",
                    0.0,
                    vec![FourOnFloor, Breakbeat],
                    Some(OctaveBounce),
                ),
                entry(
                    "breakcore",
                    "breakcore",
                    (190, 210),
                    "chaotic",
                    0.0,
                    vec![Amen, hats(1, 0)],
                    Some(ReeseSparse),
                ),
            ],
        ),
        family(
            "hard-dance",
            "Hard Dance",
            vec![
                entry(
                    "hardstyle",
                    "hardstyle",
                    (148, 152),
                    "euphoric",
                    0.0,
                    vec![GabberKick, BackbeatClap],
                    Some(OffbeatRoot),
                ),
                entry(
                    "jumpstyle",
                    "jumpstyle",
                    (142, 148),
                    "bouncy",
                    0.0,
                    vec![FourOnFloor, BackbeatClap],
                    Some(OffbeatRoot),
                ),
            ],
        ),
        family(
            "ambient",
            "Ambient",
            vec![
                entry(
                    "ambient",
                    "ambient",
                    (56, 60),
                    "spacious",
                    0.0,
                    vec![SparsePulse],
                    Some(Drone),
                ),
                entry(
                    "dark-ambient",
                    "dark ambient",
                    (50, 60),
                    "ominous",
                    0.0,
                    vec![],
                    Some(Drone),
                ),
                entry(
                    "ambient-dub",
                    "ambient dub",
                    (65, 75),
                    "deep",
                    0.0,
                    vec![DubSkank, SparsePulse],
                    Some(Sub808),
                ),
            ],
        ),
        family(
            "downtempo",
            "Chill-out / Downtempo",
            vec![
                entry(
                    "trip-hop",
                    "trip-hop",
                    (85, 92),
                    "dusty",
                    0.35,
                    vec![BoomBap, hats(2, 0)],
                    Some(Sub808),
                ),
                entry(
                    "downtempo",
                    "downtempo",
                    (95, 105),
                    "mellow",
                    0.2,
                    vec![BoomBap, hats(2, 0)],
                    Some(Walking),
                ),
                entry(
                    "psybient",
                    "psybient",
                    (95, 105),
                    "psychedelic",
                    0.0,
                    vec![SparsePulse],
                    Some(Drone),
                ),
            ],
        ),
        family(
            "hip-hop",
            "Hip-hop Fusion",
            vec![
                entry(
                    "lo-fi-hip-hop",
                    "lo-fi hip-hop",
                    (83, 87),
                    "warm",
                    0.3,
                    vec![BoomBap, hats(2, 0)],
                    Some(Walking),
                ),
                entry(
                    "trap",
                    "trap",
                    (138, 142),
                    "dark",
                    0.0,
                    vec![HalfTime, TrapHats],
                    Some(Sub808),
                ),
                entry(
                    "phonk",
                    "phonk",
                    (128, 134),
                    "cold",
                    0.0,
                    vec![BoomBap, TrapHats],
                    Some(Sub808),
                ),
            ],
        ),
        family(
            "disco",
            "Disco Fusion",
            vec![
                entry(
                    "nu-disco",
                    "nu-disco",
                    (118, 122),
                    "funky",
                    0.0,
                    vec![FourOnFloor, OffbeatOpenHat, BackbeatClap],
                    Some(OctaveBounce),
                ),
                entry(
                    "italo-disco",
                    "italo disco",
                    (118, 122),
                    "retro",
                    0.0,
                    vec![FourOnFloor, BackbeatClap, hats(2, 0)],
                    Some(OctaveBounce),
                ),
                entry(
                    "french-house",
                    "French house",
                    (121, 125),
                    "filtered",
                    0.0,
                    vec![FourOnFloor, OffbeatOpenHat, hats(1, 0)],
                    Some(OffbeatRoot),
                ),
            ],
        ),
        family(
            "industrial",
            "Industrial / EBM",
            vec![
                entry(
                    "ebm",
                    "EBM",
                    (126, 130),
                    "mechanical",
                    0.0,
                    vec![FourOnFloor, BackbeatSnare, hats(2, 1)],
                    Some(Rolling16th),
                ),
                entry(
                    "industrial-techno",
                    "industrial techno",
                    (132, 138),
                    "harsh",
                    0.0,
                    vec![FourOnFloor, hats(1, 0), EuclidTom { k: 5, n: 16 }],
                    Some(Rolling16th),
                ),
                entry(
                    "witch-house",
                    "witch house",
                    (95, 105),
                    "occult",
                    0.0,
                    vec![HalfTime, hats(2, 0)],
                    Some(Sub808),
                ),
            ],
        ),
        family(
            "idm",
            "IDM",
            vec![
                entry(
                    "idm",
                    "IDM",
                    (120, 140),
                    "glitchy",
                    0.0,
                    vec![Breakbeat, EuclidTom { k: 7, n: 16 }],
                    Some(ReeseSparse),
                ),
                entry(
                    "drill-n-bass",
                    "drill 'n' bass",
                    (165, 175),
                    "frantic",
                    0.0,
                    vec![Amen, hats(1, 0)],
                    Some(ReeseSparse),
                ),
            ],
        ),
        family(
            "hauntology",
            "Hauntology",
            vec![
                entry(
                    "synthwave",
                    "synthwave",
                    (98, 104),
                    "nostalgic",
                    0.0,
                    vec![RockBeat, hats(2, 0)],
                    Some(OctaveBounce),
                ),
                entry(
                    "darksynth",
                    "darksynth",
                    (105, 115),
                    "menacing",
                    0.0,
                    vec![FourOnFloor, BackbeatSnare, hats(2, 1)],
                    Some(OctaveBounce),
                ),
                entry(
                    "vaporwave",
                    "vaporwave",
                    (65, 75),
                    "hazy",
                    0.0,
                    vec![BoomBap],
                    Some(Walking),
                ),
            ],
        ),
        family(
            "electronica",
            "Electronica",
            vec![
                entry(
                    "folktronica",
                    "folktronica",
                    (105, 115),
                    "organic",
                    0.0,
                    vec![BoomBap],
                    Some(Walking),
                ),
                entry(
                    "nu-jazz",
                    "nu-jazz",
                    (105, 115),
                    "jazzy",
                    0.3,
                    vec![BoomBap, hats(2, 1)],
                    Some(Walking),
                ),
                entry(
                    "berlin-school",
                    "Berlin school",
                    (100, 120),
                    "cosmic",
                    0.0,
                    vec![],
                    Some(Rolling16th),
                ),
            ],
        ),
        family(
            "electronic-rock",
            "Electronic Rock",
            vec![
                entry(
                    "synth-pop",
                    "synth-pop",
                    (116, 120),
                    "catchy",
                    0.0,
                    vec![RockBeat, hats(2, 0)],
                    Some(OctaveBounce),
                ),
                entry(
                    "new-wave",
                    "new wave",
                    (128, 132),
                    "angular",
                    0.0,
                    vec![RockBeat, hats(2, 0)],
                    Some(OctaveBounce),
                ),
                entry(
                    "indie-synth-rock",
                    "indie synth-rock",
                    (120, 128),
                    "anthemic",
                    0.0,
                    vec![FourOnFloor, BackbeatSnare, hats(2, 0)],
                    Some(OctaveBounce),
                ),
                entry(
                    "pop-punk",
                    "pop-punk",
                    (150, 170),
                    "energetic",
                    0.0,
                    vec![RockBeat, hats(1, 0)],
                    Some(OctaveBounce),
                ),
            ],
        ),
        family(
            "afro",
            "Afro / Regional",
            vec![
                entry(
                    "amapiano",
                    "amapiano",
                    (110, 115),
                    "smooth",
                    0.0,
                    vec![LogDrum, hats(2, 0), BackbeatClap],
                    Some(Sub808),
                ),
                entry(
                    "afro-house",
                    "afro house",
                    (118, 122),
                    "percussive",
                    0.0,
                    vec![FourOnFloor, BackbeatClap, OffbeatOpenHat, hats(2, 1)],
                    Some(OffbeatRoot),
                ),
                entry(
                    "gqom",
                    "gqom",
                    (122, 128),
                    "raw",
                    0.0,
                    vec![HalfTime, EuclidTom { k: 3, n: 8 }],
                    Some(Sub808),
                ),
            ],
        ),
        family(
            "footwork",
            "Footwork / Juke",
            vec![
                entry(
                    "footwork",
                    "footwork",
                    (155, 165),
                    "frantic",
                    0.0,
                    vec![Rapid808, BackbeatClap],
                    Some(Sub808),
                ),
                entry(
                    "juke",
                    "juke",
                    (155, 165),
                    "bouncy",
                    0.0,
                    vec![Rapid808, hats(2, 0)],
                    Some(Sub808),
                ),
            ],
        ),
        family(
            "dub",
            "Dub",
            vec![entry(
                "dub",
                "dub",
                (70, 80),
                "spacious",
                0.25,
                vec![DubSkank, hats(2, 1)],
                Some(Walking),
            )],
        ),
        family(
            "video-game",
            "Video Game",
            vec![
                entry(
                    "chiptune",
                    "chiptune",
                    (110, 140),
                    "playful",
                    0.0,
                    vec![RockBeat, hats(1, 0)],
                    Some(OctaveBounce),
                ),
                entry(
                    "bitpop",
                    "bitpop",
                    (126, 130),
                    "chirpy",
                    0.0,
                    vec![FourOnFloor, BackbeatClap, hats(2, 0)],
                    Some(OctaveBounce),
                ),
            ],
        ),
    ]
}

/// Every entry, flattened, with its family name.
pub fn entries() -> Vec<(String, MapEntry)> {
    families()
        .into_iter()
        .flat_map(|f| {
            let fname = f.name.clone();
            f.genres.into_iter().map(move |g| (fname.clone(), g))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::Grid;
    use crate::verify::verify_grid;

    #[test]
    fn map_covers_the_agreed_skeleton() {
        let fams = families();
        assert!(fams.len() >= 20, "only {} families", fams.len());
        let n: usize = fams.iter().map(|f| f.genres.len()).sum();
        assert!(n >= 55, "only {n} genres");
    }

    #[test]
    fn names_are_unique_and_kebab_case() {
        let all = entries();
        let mut seen = std::collections::HashSet::new();
        for (fam, e) in &all {
            assert!(
                seen.insert(e.name.clone()),
                "duplicate genre name '{}' (family {fam})",
                e.name
            );
            assert!(
                e.name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "'{}' is not kebab-case",
                e.name
            );
        }
    }

    #[test]
    fn bpm_bands_are_sane() {
        for (fam, e) in entries() {
            let (lo, hi) = e.bpm;
            assert!(
                (40..=220).contains(&lo) && lo <= hi && hi <= 220,
                "{fam}/{} has bpm {:?}",
                e.name,
                e.bpm
            );
            assert!(
                (0.0..=1.0).contains(&e.swing),
                "{} swing {}",
                e.name,
                e.swing
            );
        }
    }

    /// Even sketches are provable: every entry's drum stack lowers to a grid
    /// the strudel-rs evaluator agrees with.
    #[test]
    fn every_entry_drum_stack_round_trips() {
        for (_, e) in entries() {
            let mut g = Grid::new(16);
            for archetype in &e.drums {
                for lane in archetype.lanes() {
                    g = g.lane(
                        lane.sound,
                        lane.pat
                            .counts(16)
                            .unwrap_or_else(|err| panic!("{}: {err}", e.name)),
                    );
                }
            }
            verify_grid(&g).unwrap_or_else(|err| panic!("{}: {err}", e.name));
            assert!(
                e.drums.is_empty() || g.has_onsets(),
                "{} drums are silent",
                e.name
            );
        }
    }

    /// Phase 2 definition of done: EVERY entry on the map resolves to a spec
    /// and composes a validated piece. No sketches left behind.
    #[test]
    fn every_map_entry_composes() {
        for (fam, e) in entries() {
            assert!(e.spec().is_some(), "{fam}/{} has no spec", e.name);
            crate::compose::by_name(&e.name, 7)
                .unwrap_or_else(|err| panic!("{fam}/{}: {err}", e.name));
        }
    }

    /// Family names route to a flagship via lineage (base five stay first in
    /// the registry so `house`/`techno`/… still hit their canonical specs).
    #[test]
    fn family_queries_resolve() {
        for fam in ["house", "techno", "trance", "uk-garage", "hardcore", "dub"] {
            assert!(
                crate::spec::find(fam).is_some(),
                "family '{fam}' unroutable"
            );
        }
    }
}
