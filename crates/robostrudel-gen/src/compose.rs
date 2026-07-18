//! Per-genre composers — assemble a complete, verified `.strudel` piece from the
//! grid / scale / melody primitives.
//!
//! Every composer: builds an aligned drum [`Grid`], picks a [`Scale`], lays out
//! bass / chords / melody by scale degree, round-trip verifies each part, and
//! confirms the whole document plays ([`validate_doc`]). What comes out cannot
//! have the defects the scraped github "genre templates" had — no drum-grid
//! drift, no out-of-key notes — because those are unrepresentable in the types.

use crate::grid::Grid;
use crate::melody;
use crate::mini::Mini;
use crate::scale::Scale;
use crate::spec::{self, GenreSpec, HarmonySpec, MelodySpec, Voicing};
use crate::verify::{validate_doc, verify_grid, verify_notes};

/// One voice in the stack: a source pattern (`s(...)` / `note(...)`) plus a
/// method-chain suffix.
struct Part {
    src: String,
    chain: String,
}

impl Part {
    fn render(&self) -> String {
        format!("{}{}", self.src, self.chain)
    }
}

/// A finished piece: a titled `setbpm(...); stack(...)` document.
pub struct Piece {
    title: String,
    bpm: u32,
    parts: Vec<Part>,
}

impl Piece {
    /// Render the complete `.strudel` document.
    pub fn to_strudel(&self) -> String {
        let body = self
            .parts
            .iter()
            .map(|p| format!("  {}", p.render()))
            .collect::<Vec<_>>()
            .join(",\n");
        format!(
            "// {}\nsetbpm({});\n\nstack(\n{}\n)\n",
            self.title, self.bpm, body
        )
    }
}

/// Build a chord progression as a slowcat of voiced note-stacks:
/// `<[c3, e3, g3, b3] …>`. Roots are scale degrees; quality follows the mode.
fn chord_prog(scale: &Scale, roots: &[i32], octave: i32, voicing: Voicing) -> Mini {
    Mini::Alt(
        roots
            .iter()
            .map(|&d| {
                let notes = match voicing {
                    Voicing::Triad => scale.triad(d, octave),
                    Voicing::Seventh => scale.seventh(d, octave),
                };
                Mini::Group(Box::new(Mini::Stack(
                    notes.into_iter().map(Mini::atom).collect(),
                )))
            })
            .collect(),
    )
}

/// Assemble + verify a piece: every melodic part is round-trip checked and the
/// whole document is validated before it can be returned.
fn assemble(title: &str, bpm: u32, grid: &Grid, parts: Vec<Part>) -> Result<Piece, String> {
    verify_grid(grid).map_err(|e| format!("{title}: {e}"))?;
    let piece = Piece {
        title: title.to_string(),
        bpm,
        parts,
    };
    validate_doc(&piece.to_strudel()).map_err(|e| format!("{title}: {e}"))?;
    Ok(piece)
}

/// Helper: a verified `note("…")` part from a slot line.
fn note_part(scale: &Scale, slots: &[Option<i32>], octave: i32, chain: &str) -> Result<Part, String> {
    let m = scale.to_mini_slots(slots, octave);
    verify_notes(&scale.slot_notes(slots, octave), &m.emit())?;
    Ok(Part {
        src: m.as_note(),
        chain: chain.to_string(),
    })
}

fn sound_part(pat: &str, chain: &str) -> Part {
    Part {
        src: format!("s(\"{pat}\")"),
        chain: chain.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Legacy hardcoded genres — retained as the Phase 0 regression oracle. The
// canonical path is `spec::registry()` + [`compose_from_spec`]; the tests
// prove the spec-driven output is byte-identical to these. Delete in Phase 1
// once the map ships.
// ---------------------------------------------------------------------------

/// Deep house — 122 BPM, A minor. Four-on-the-floor, offbeat open hats, backbeat
/// clap; offbeat rolling bass; stabbed diatonic 7th chords; a pentatonic lead.
pub fn house(seed: u64) -> Result<Piece, String> {
    let scale = Scale::parse("a minor")?;
    let drums = Grid::new(16)
        .every("bd", 4, 0)
        .every("oh", 4, 2)
        .hit("cp", &[4, 12])
        .every("hh", 2, 0);

    // Offbeat rolling bass: root on the "and" of each beat, lift to the octave.
    let bass = note_part(
        &scale,
        &[None, Some(0), None, Some(0), None, Some(0), None, Some(7)],
        2,
        ".s(\"sawtooth\").lpf(600).resonance(6).gain(0.5)",
    )?;

    // i – VI – VII – v stabs (Am7 – Fmaj7 – Gmaj7 – Em7).
    let chords = Part {
        src: chord_prog(&scale, &[0, 5, 6, 4], 3, Voicing::Seventh).as_note(),
        chain: ".s(\"sawtooth\").struct(\"~ 1 ~ 1\").release(0.16).lpf(1900).gain(0.42).room(0.3)".into(),
    };

    // Sparse lead: a seeded walk in the scale, high register.
    let lead_degs = melody::walk(seed, 8, 7, 2, 4, 12);
    let lead_slots: Vec<Option<i32>> =
        lead_degs.iter().enumerate().map(|(i, &d)| if i % 2 == 0 { Some(d) } else { None }).collect();
    let lead = note_part(&scale, &lead_slots, 4, ".s(\"triangle\").delay(0.25).room(0.3).gain(0.35)")?;

    assemble(
        "deep house in A minor (generated) — four-on-floor, offbeat bass, 7th stabs",
        122,
        &drums,
        vec![
            sound_part(&drums.to_string(), ".gain(0.9)"),
            bass,
            chords,
            lead,
        ],
    )
}

/// Drum & bass — 174 BPM, C minor. Two-step break, reese-ish saw bass, minor
/// stabs.
pub fn drum_and_bass(_seed: u64) -> Result<Piece, String> {
    let scale = Scale::parse("c minor")?;
    let drums = Grid::new(16).hit("bd", &[0, 10]).hit("sd", &[4, 12]).every("hh", 1, 0);

    // Reese: root on 1, flat-7 on the "&" of 2, octave lift — sparse and low.
    let bass = note_part(
        &scale,
        &[Some(0), None, None, Some(6), None, None, Some(7), None],
        1,
        ".s(\"supersaw\").lpf(700).resonance(9).gain(0.5)",
    )?;

    let chords = Part {
        src: chord_prog(&scale, &[0, 5, 2, 6], 3, Voicing::Seventh).as_note(),
        chain: ".s(\"sawtooth\").struct(\"~ 1\").release(0.18).lpf(1500).gain(0.34).room(0.3)".into(),
    };

    assemble(
        "drum & bass in C minor (generated) — two-step break, reese bass, minor stabs",
        174,
        &drums,
        vec![sound_part(&drums.to_string(), ".gain(0.92)"), bass, chords],
    )
}

/// Techno — 130 BPM, C phrygian (dark). Four-on-the-floor with offbeat hats and
/// a euclidean tom; hypnotic driving root bass.
pub fn techno(_seed: u64) -> Result<Piece, String> {
    let scale = Scale::parse("c phrygian")?;
    let drums = Grid::new(16)
        .every("bd", 4, 0)
        .hit("cp", &[4, 12])
        .every("hh", 2, 1)
        .euclid("mt", 5, 16);

    // Driving offbeat 16th root bass — the hypnotic techno pulse.
    let bass = note_part(
        &scale,
        &[
            Some(0), None, Some(0), None, Some(0), None, Some(0), None,
            Some(0), None, Some(0), Some(1), Some(0), None, Some(0), None,
        ],
        2,
        ".s(\"sawtooth\").lpf(900).resonance(8).gain(0.5)",
    )?;

    let chords = Part {
        src: chord_prog(&scale, &[0, 1], 3, Voicing::Seventh).as_note(),
        chain: ".s(\"sawtooth\").struct(\"~ ~ 1 ~\").release(0.2).lpf(1400).gain(0.3).room(0.2)".into(),
    };

    assemble(
        "techno in C phrygian (generated) — four-on-floor, euclid tom, driving bass",
        130,
        &drums,
        vec![sound_part(&drums.to_string(), ".gain(0.9)"), bass, chords],
    )
}

/// Ambient — 58 BPM, C major. No drums: a sustained drone, long-attack pad
/// chords, and a sparse generated bell melody.
pub fn ambient(seed: u64) -> Result<Piece, String> {
    let scale = Scale::parse("c major")?;
    // No percussion — but assemble() still verifies an (empty) grid trivially,
    // so give it a single soft pulse to satisfy has_onsets and add motion.
    let drums = Grid::new(16).hit("hh", &[0, 8]);

    let drone = note_part(&scale, &[Some(0)], 2, ".s(\"sine\").attack(3).release(5).gain(0.45)")?;

    let pad = Part {
        src: chord_prog(&scale, &[0, 3, 5, 4], 3, Voicing::Seventh).as_note(),
        chain: ".s(\"sawtooth\").attack(2).release(4).lpf(1000).gain(0.32).room(0.85)".into(),
    };

    // Drifting bells: seeded pentatonic-ish walk, mostly rests.
    let bell_degs = melody::walk(seed, 8, 7, 2, 4, 11);
    let bell_slots: Vec<Option<i32>> =
        bell_degs.iter().enumerate().map(|(i, &d)| if i % 3 == 0 { Some(d) } else { None }).collect();
    let bells = note_part(&scale, &bell_slots, 4, ".s(\"gm_kalimba\").room(0.7).delay(0.4).gain(0.33)")?;

    assemble(
        "ambient in C major (generated) — drone, long-attack pad, drifting bells",
        58,
        &drums,
        vec![
            sound_part(&drums.to_string(), ".gain(0.2).room(0.6)"),
            drone,
            pad,
            bells,
        ],
    )
}

/// Lo-fi hip-hop — 85 BPM, D dorian. Boom-bap drums, walking upright bass, Rhodes
/// 7th chords, a soft dorian melody.
pub fn hip_hop(seed: u64) -> Result<Piece, String> {
    let scale = Scale::parse("d dorian")?;
    let drums = Grid::new(16)
        .hit("bd", &[0, 6, 10])
        .hit("sd", &[4, 12])
        .every("hh", 2, 0);

    // Walking upright bass: root, 5th, flat-7, one note per beat.
    let bass = note_part(
        &scale,
        &[Some(0), None, Some(4), None, Some(0), None, Some(6), None],
        2,
        ".s(\"gm_acoustic_bass\").gain(0.6)",
    )?;

    let chords = Part {
        src: chord_prog(&scale, &[0, 3, 4, 0], 3, Voicing::Seventh).as_note(),
        chain: ".s(\"gm_epiano1\").release(0.4).gain(0.42).room(0.3)".into(),
    };

    let mel_degs = melody::walk(seed, 8, 4, 2, 2, 11);
    let mel_slots: Vec<Option<i32>> =
        mel_degs.iter().enumerate().map(|(i, &d)| if i % 2 == 0 { Some(d) } else { None }).collect();
    let mel = note_part(&scale, &mel_slots, 4, ".s(\"triangle\").room(0.3).delay(0.2).gain(0.3)")?;

    assemble(
        "lo-fi hip-hop in D dorian (generated) — boom-bap, walking bass, Rhodes 7ths",
        85,
        &drums,
        vec![sound_part(&drums.to_string(), ".gain(0.85)"), bass, chords, mel],
    )
}

// ---------------------------------------------------------------------------
// Spec-driven composition — genres as data (docs/GENRE_MAP_PLAN.md, Phase 0)
// ---------------------------------------------------------------------------

/// Title-case the scale spec for the piece title: `"a minor"` → `"A minor"`.
fn scale_title(scale: &str) -> String {
    let mut chars = scale.chars();
    match chars.next() {
        Some(c) => c.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

/// Compose a complete, verified piece from a [`GenreSpec`]. The one composer
/// behind every genre on the map: drum archetypes lower onto an aligned grid
/// (swung offbeats split into `.late()`-nudged parts), bass and melody are
/// laid out by scale degree, chords follow the mode — and the assembled
/// document must round-trip verify and validate before it is returned.
pub fn compose_from_spec(genre: &GenreSpec, seed: u64) -> Result<Piece, String> {
    let scale = Scale::parse(&genre.scale).map_err(|e| format!("{}: {e}", genre.name))?;
    let bpm = (genre.bpm.0 + genre.bpm.1) / 2;
    let title = format!(
        "{} in {} (generated) — {}",
        genre.display,
        scale_title(&genre.scale),
        genre.desc
    );

    // Drums: every archetype lane lands on ONE grid. When the spec swings,
    // hits on swung columns are pulled into their own verified one-lane part
    // and delayed with .late() — the straight columns stay on the main grid.
    let mut grid = Grid::new(genre.steps);
    let mut swung_parts: Vec<Part> = Vec::new();
    let swing_delay = genre.swing_unit.delay(genre.swing, genre.steps);
    for archetype in &genre.drums {
        for lane in archetype.lanes() {
            let counts = lane.pat.counts(genre.steps).map_err(|e| format!("{title}: {e}"))?;
            if genre.swing > 0.0 && lane.swings {
                let (mut straight, mut swung) = (counts.clone(), counts);
                for i in 0..genre.steps {
                    if genre.swing_unit.is_swung_step(i) {
                        straight[i] = 0;
                    } else {
                        swung[i] = 0;
                    }
                }
                if straight.iter().any(|&c| c > 0) {
                    grid = grid.lane(lane.sound, straight);
                }
                if swung.iter().any(|&c| c > 0) {
                    let late_grid = Grid::new(genre.steps).lane(lane.sound, swung);
                    verify_grid(&late_grid).map_err(|e| format!("{title}: {e}"))?;
                    swung_parts.push(sound_part(
                        &late_grid.to_string(),
                        &format!(".late({swing_delay:.4}){}", genre.drum_fx),
                    ));
                }
            } else {
                grid = grid.lane(lane.sound, counts);
            }
        }
    }

    let mut parts: Vec<Part> = Vec::new();
    if grid.has_onsets() {
        parts.push(sound_part(&grid.to_string(), &genre.drum_fx));
    }
    parts.extend(swung_parts);

    if let Some(bass) = &genre.bass {
        let slots = bass.style.slots(scale.len(), seed);
        parts.push(note_part(
            &scale,
            &slots,
            bass.octave,
            &format!(".s(\"{}\"){}", bass.sound, bass.fx),
        )?);
    }

    if let Some(HarmonySpec { degrees, octave, voicing, rhythm, sound, fx }) = &genre.harmony {
        let struct_chain = if rhythm.is_empty() {
            String::new()
        } else {
            let mask = rhythm
                .iter()
                .map(|&on| if on { "1" } else { "~" })
                .collect::<Vec<_>>()
                .join(" ");
            format!(".struct(\"{mask}\")")
        };
        parts.push(Part {
            src: chord_prog(&scale, degrees, *octave, *voicing).as_note(),
            chain: format!(".s(\"{sound}\"){struct_chain}{fx}"),
        });
    }

    match &genre.melody {
        MelodySpec::None => {}
        MelodySpec::Walk { len, start, max_step, lo, hi, density, octave, sound, fx } => {
            let degrees = melody::walk(seed, *len, *start, *max_step, *lo, *hi);
            let slots: Vec<Option<i32>> = degrees
                .iter()
                .enumerate()
                .map(|(i, &d)| if i % density == 0 { Some(d) } else { None })
                .collect();
            parts.push(note_part(
                &scale,
                &slots,
                *octave,
                &format!(".s(\"{sound}\"){fx}"),
            )?);
        }
        MelodySpec::Arpeggio { chord, octaves, dir, octave, sound, fx } => {
            let degrees = melody::arpeggio(chord, *octaves, scale.len(), *dir);
            let slots: Vec<Option<i32>> = degrees.iter().map(|&d| Some(d)).collect();
            parts.push(note_part(
                &scale,
                &slots,
                *octave,
                &format!(".s(\"{sound}\"){fx}"),
            )?);
        }
    }

    assemble(&title, bpm, &grid, parts)
}

/// All genre composers keyed by the `corpus/genres/<folder>/` they belong in.
/// Reads the spec registry — adding a genre is adding a spec, not code here.
pub fn all(seed: u64) -> Vec<(String, Result<Piece, String>)> {
    spec::registry()
        .iter()
        .map(|s| (s.name.clone(), compose_from_spec(s, seed)))
        .collect()
}

/// Canonical genre names this module can compose.
pub fn genre_names() -> Vec<String> {
    spec::registry().into_iter().map(|s| s.name).collect()
}

/// Compose a genre by name (case/alias/lineage tolerant). `seed` varies the
/// generated melodic parts deterministically.
pub fn by_name(genre: &str, seed: u64) -> Result<Piece, String> {
    match spec::find(genre) {
        Some(s) => compose_from_spec(&s, seed),
        None => Err(format!(
            "unknown genre '{}'; supported: {}",
            genre.trim(),
            genre_names().join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn by_name_routes_aliases_and_validates() {
        // The path the agent's generate_pattern tool takes.
        for g in ["house", "dnb", "lo-fi", "Ambient", "TECHNO"] {
            let piece = by_name(g, 7).unwrap_or_else(|e| panic!("{g}: {e}"));
            validate_doc(&piece.to_strudel()).unwrap_or_else(|e| panic!("{g} doc: {e}"));
        }
        assert!(by_name("polka", 1).is_err());
    }

    #[test]
    fn every_genre_composes_and_validates() {
        for (name, res) in all(7) {
            let piece = res.unwrap_or_else(|e| panic!("{name} failed: {e}"));
            // to_strudel already passed validate_doc inside assemble(); re-check.
            validate_doc(&piece.to_strudel())
                .unwrap_or_else(|e| panic!("{name} doc invalid: {e}"));
        }
    }

    /// The Phase 0 regression bar: the spec registry must reproduce the
    /// original hardcoded composers BYTE-FOR-BYTE — same grids, same chains,
    /// same seeded melodies — across seeds. Same bytes, same sound.
    #[test]
    fn specs_reproduce_legacy_composers_byte_for_byte() {
        let oracles: [(&str, fn(u64) -> Result<Piece, String>); 5] = [
            ("house", house),
            ("drum-and-bass", drum_and_bass),
            ("techno", techno),
            ("ambient", ambient),
            ("hip-hop", hip_hop),
        ];
        for seed in [1u64, 7, 42, 1234] {
            for (name, oracle) in oracles {
                let s = spec::find(name).unwrap_or_else(|| panic!("no spec for {name}"));
                let from_spec = compose_from_spec(&s, seed)
                    .unwrap_or_else(|e| panic!("{name} spec failed: {e}"))
                    .to_strudel();
                let legacy = oracle(seed).unwrap().to_strudel();
                assert_eq!(from_spec, legacy, "{name} (seed {seed}) diverged from oracle");
            }
        }
    }

    /// Every archetype in the library lowers to a grid the strudel-rs
    /// evaluator agrees with — the non-slop guarantee for the whole map.
    #[test]
    fn every_drum_archetype_round_trips() {
        for archetype in crate::spec::DrumArchetype::library() {
            let mut g = Grid::new(16);
            for lane in archetype.lanes() {
                g = g.lane(lane.sound, lane.pat.counts(16).unwrap());
            }
            verify_grid(&g).unwrap_or_else(|e| panic!("{archetype:?}: {e}"));
            assert!(g.has_onsets(), "{archetype:?} is silent");
        }
    }

    /// Every bass style lowers to an in-key, round-trip-verified line in both
    /// diatonic and pentatonic modes.
    #[test]
    fn every_bass_style_round_trips() {
        for scale_name in ["c minor", "e minor pentatonic"] {
            let scale = Scale::parse(scale_name).unwrap();
            for style in crate::spec::BassStyle::library() {
                let slots = style.slots(scale.len(), 7);
                note_part(&scale, &slots, 2, ".s(\"sawtooth\")")
                    .unwrap_or_else(|e| panic!("{style:?} on {scale_name}: {e}"));
            }
        }
    }

    /// Swing splits swung-column hits into a `.late()`-nudged part and the
    /// result still validates.
    #[test]
    fn swing_produces_late_nudged_offbeats() {
        let mut s = spec::find("house").unwrap();
        s.swing = 2.0 / 3.0; // triplet feel
        s.swing_unit = crate::spec::SwingUnit::Eighth;
        let doc = compose_from_spec(&s, 7).unwrap().to_strudel();
        assert!(doc.contains(".late("), "no swing part emitted:\n{doc}");
        validate_doc(&doc).unwrap();
        // Straight house (swing 0) must NOT grow extra parts.
        let straight = compose_from_spec(&spec::find("house").unwrap(), 7)
            .unwrap()
            .to_strudel();
        assert!(!straight.contains(".late("));
    }
}
