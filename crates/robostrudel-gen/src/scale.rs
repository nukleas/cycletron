//! Scales and modes — the in-key guarantee for melodic material.
//!
//! A [`Scale`] maps integer *scale degrees* to concrete pitches. Because every
//! generated note is addressed by degree (not by an absolute semitone), an
//! out-of-key note is unrepresentable: the scale's interval table is the only
//! way in. Degrees wrap octaves in both directions (`-1` is the leading tone
//! below the root; `7` in a diatonic scale is the root an octave up), so
//! melodies can range freely while staying diatonic.

use crate::mini::Mini;
use crate::parse_key;

const PC_LOWER: [&str; 12] = [
    "c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b",
];

/// A scale mode: its semitone offsets from the root within one octave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Major,
    Minor,
    Dorian,
    Phrygian,
    Lydian,
    Mixolydian,
    Locrian,
    HarmonicMinor,
    MelodicMinor,
    MajorPentatonic,
    MinorPentatonic,
    Blues,
}

impl Mode {
    /// Semitone offsets from the root (one octave). Length = notes per octave.
    pub fn intervals(self) -> &'static [i32] {
        match self {
            Mode::Major => &[0, 2, 4, 5, 7, 9, 11],
            Mode::Minor => &[0, 2, 3, 5, 7, 8, 10],
            Mode::Dorian => &[0, 2, 3, 5, 7, 9, 10],
            Mode::Phrygian => &[0, 1, 3, 5, 7, 8, 10],
            Mode::Lydian => &[0, 2, 4, 6, 7, 9, 11],
            Mode::Mixolydian => &[0, 2, 4, 5, 7, 9, 10],
            Mode::Locrian => &[0, 1, 3, 5, 6, 8, 10],
            Mode::HarmonicMinor => &[0, 2, 3, 5, 7, 8, 11],
            Mode::MelodicMinor => &[0, 2, 3, 5, 7, 9, 11],
            Mode::MajorPentatonic => &[0, 2, 4, 7, 9],
            Mode::MinorPentatonic => &[0, 3, 5, 7, 10],
            Mode::Blues => &[0, 3, 5, 6, 7, 10],
        }
    }

    /// Parse a mode name (case/space-insensitive). Accepts common aliases.
    pub fn parse(s: &str) -> Result<Mode, String> {
        let norm = s.trim().to_ascii_lowercase();
        let collapsed = norm.split_whitespace().collect::<Vec<_>>().join(" ");
        Ok(match collapsed.as_str() {
            "major" | "ionian" | "" => Mode::Major,
            "minor" | "aeolian" | "natural minor" => Mode::Minor,
            "dorian" => Mode::Dorian,
            "phrygian" => Mode::Phrygian,
            "lydian" => Mode::Lydian,
            "mixolydian" => Mode::Mixolydian,
            "locrian" => Mode::Locrian,
            "harmonic minor" => Mode::HarmonicMinor,
            "melodic minor" => Mode::MelodicMinor,
            "major pentatonic" | "pentatonic" | "majpent" => Mode::MajorPentatonic,
            "minor pentatonic" | "minpent" => Mode::MinorPentatonic,
            "blues" => Mode::Blues,
            other => return Err(format!("unknown mode '{other}'")),
        })
    }
}

/// A scale: a root pitch-class plus a mode.
#[derive(Clone, Copy, Debug)]
pub struct Scale {
    root_pc: i32,
    mode: Mode,
}

impl Scale {
    /// Build from a root pitch-class (0..12) and a mode.
    pub fn new(root_pc: i32, mode: Mode) -> Self {
        Scale {
            root_pc: root_pc.rem_euclid(12),
            mode,
        }
    }

    /// Parse `"c minor"`, `"f# dorian"`, `"eb major pentatonic"`.
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (root, mode) = s.split_once(char::is_whitespace).unwrap_or((s, "major"));
        Ok(Scale::new(parse_key(root)?, Mode::parse(mode)?))
    }

    /// Notes per octave (the mode's degree count).
    pub fn len(&self) -> i32 {
        self.mode.intervals().len() as i32
    }

    /// MIDI number for a scale degree at `base_octave` (4 = the octave of
    /// middle C). Degrees below 0 or ≥ len wrap octaves.
    pub fn degree_to_midi(&self, degree: i32, base_octave: i32) -> i32 {
        let len = self.len();
        let oct = degree.div_euclid(len);
        let idx = degree.rem_euclid(len) as usize;
        let semis = self.mode.intervals()[idx] + 12 * oct;
        self.root_pc + 12 * (base_octave + 1) + semis
    }

    /// Note token (e.g. `"d#4"`) for a scale degree.
    pub fn note(&self, degree: i32, base_octave: i32) -> String {
        midi_to_note(self.degree_to_midi(degree, base_octave))
    }

    /// Note tokens for a sequence of degrees.
    pub fn notes(&self, degrees: &[i32], base_octave: i32) -> Vec<String> {
        degrees.iter().map(|&d| self.note(d, base_octave)).collect()
    }

    /// A diatonic triad rooted on `degree`: scale degrees d, d+2, d+4 — so the
    /// chord quality follows the mode automatically (minor i in aeolian, etc.).
    pub fn triad(&self, degree: i32, base_octave: i32) -> Vec<String> {
        [0, 2, 4].iter().map(|o| self.note(degree + o, base_octave)).collect()
    }

    /// A seventh chord on `degree`: degrees d, d+2, d+4, d+6.
    pub fn seventh(&self, degree: i32, base_octave: i32) -> Vec<String> {
        [0, 2, 4, 6].iter().map(|o| self.note(degree + o, base_octave)).collect()
    }

    /// Lower a degree sequence to a `note(...)`-ready [`Mini`] sequence.
    pub fn to_mini(&self, degrees: &[i32], base_octave: i32) -> Mini {
        Mini::Seq(
            degrees
                .iter()
                .map(|&d| Mini::atom(self.note(d, base_octave)))
                .collect(),
        )
    }

    /// Lower a rhythmic line to a [`Mini`] sequence: `Some(d)` is a note on that
    /// degree, `None` is a rest. Lets basslines and melodies carry gaps.
    pub fn to_mini_slots(&self, slots: &[Option<i32>], base_octave: i32) -> Mini {
        Mini::Seq(
            slots
                .iter()
                .map(|s| match s {
                    Some(d) => Mini::atom(self.note(*d, base_octave)),
                    None => Mini::Rest,
                })
                .collect(),
        )
    }

    /// The note tokens a slot line produces (rests dropped) — the expected
    /// onsets for round-trip verification.
    pub fn slot_notes(&self, slots: &[Option<i32>], base_octave: i32) -> Vec<String> {
        slots
            .iter()
            .filter_map(|s| s.map(|d| self.note(d, base_octave)))
            .collect()
    }
}

/// MIDI number → strudel note token (`60` → `"c4"`). Sharp spelling.
pub fn midi_to_note(midi: i32) -> String {
    let name = PC_LOWER[midi.rem_euclid(12) as usize];
    let octave = midi.div_euclid(12) - 1;
    format!("{name}{octave}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_minor_degrees_are_in_key() {
        let s = Scale::parse("c minor").unwrap();
        // degrees 0..7 → c d eb f g ab bb c'
        let got = s.notes(&[0, 1, 2, 3, 4, 5, 6, 7], 4);
        assert_eq!(
            got,
            ["c4", "d4", "d#4", "f4", "g4", "g#4", "a#4", "c5"]
        );
    }

    #[test]
    fn degrees_wrap_octaves_both_ways() {
        let s = Scale::parse("c major").unwrap();
        assert_eq!(s.note(-1, 4), "b3"); // leading tone below root
        assert_eq!(s.note(7, 4), "c5"); // root an octave up
        assert_eq!(s.note(0, 4), "c4");
    }

    #[test]
    fn diatonic_triads_follow_mode() {
        let s = Scale::parse("c minor").unwrap();
        // i triad in C minor = c eb g
        assert_eq!(s.triad(0, 3), ["c3", "d#3", "g3"]);
        // iv triad on degree 3 = f ab c
        assert_eq!(s.triad(3, 3), ["f3", "g#3", "c4"]);
    }

    #[test]
    fn parses_modes_and_roots() {
        assert!(Scale::parse("f# dorian").is_ok());
        assert!(Scale::parse("eb major pentatonic").is_ok());
        assert!(Scale::parse("a minor").is_ok());
        assert!(Scale::parse("c bogus").is_err());
    }
}
