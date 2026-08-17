//! The populated genre map — Phase 2 of `docs/GENRE_MAP_PLAN.md`.
//!
//! Every flagship subgenre from [`crate::map`] as a full [`GenreSpec`]: scale
//! and progression chosen for the genre's harmonic language, palette drawn
//! from the engine's real sound set (synths, wavetables, `gm_*`), drum
//! archetypes layered per the skeleton, swing where the style shuffles,
//! distortion where it bites (gabber, hardstyle, industrial). Specs are pure
//! data — each is ~10 lines through the helpers — and all of them compose
//! through the one verified [`crate::compose::compose_from_spec`] path, so a
//! spec that would misalign or leave the key cannot exist here.
//!
//! The five Phase 0 genres (`house`, `drum-and-bass`, `techno`, `ambient`,
//! `hip-hop`) stay in [`crate::spec`] as the regression oracle; this module
//! adds everything else on the map.

use crate::melody::Dir;
use crate::spec::{
    BassSpec, BassStyle, DrumArchetype, GenreSpec, HarmonySpec, MelodySpec, SwingUnit, Voicing,
};

// ---------------------------------------------------------------------------
// Helpers — keep each spec compact and uniform.
// ---------------------------------------------------------------------------

fn g(
    name: &str,
    display: &str,
    family: &str,
    bpm: (u32, u32),
    scale: &str,
    mood: &str,
    desc: &str,
) -> GenreSpec {
    GenreSpec {
        name: name.into(),
        display: display.into(),
        lineage: vec![family.into(), display.into()],
        aliases: Vec::new(),
        bpm,
        swing: 0.0,
        swing_unit: SwingUnit::Sixteenth,
        scale: scale.into(),
        mood: mood.into(),
        desc: desc.into(),
        steps: 16,
        drums: Vec::new(),
        drum_fx: ".gain(0.9)".into(),
        bass: None,
        harmony: None,
        melody: MelodySpec::None,
        form: None,
    }
}

fn bass(style: BassStyle, octave: i32, sound: &str, fx: &str) -> Option<BassSpec> {
    Some(BassSpec {
        style,
        octave,
        sound: sound.into(),
        fx: fx.into(),
    })
}

/// Rhythm mask from a compact string: `'1'` = stab, anything else = rest;
/// `""` = sustained (no `struct`).
fn mask(s: &str) -> Vec<bool> {
    s.chars().map(|c| c == '1').collect()
}

/// Mild default stereo: chords sit slightly left, leads slightly right, bass
/// and drums stay centre. Kills the "everything centre-panned" mono note on
/// every generated piece and simply sounds better. A spec can override by
/// putting its own `.pan(…)` in the fx string.
fn with_pan(fx: &str, pan: f64) -> String {
    if fx.contains(".pan(") {
        fx.to_string()
    } else {
        format!("{fx}.pan({pan})")
    }
}

fn sevenths(
    degrees: &[i32],
    octave: i32,
    rhythm: &str,
    sound: &str,
    fx: &str,
) -> Option<HarmonySpec> {
    Some(HarmonySpec {
        degrees: degrees.to_vec(),
        octave,
        voicing: Voicing::Seventh,
        rhythm: mask(rhythm),
        sound: sound.into(),
        fx: with_pan(fx, 0.42),
    })
}

fn triads(
    degrees: &[i32],
    octave: i32,
    rhythm: &str,
    sound: &str,
    fx: &str,
) -> Option<HarmonySpec> {
    Some(HarmonySpec {
        degrees: degrees.to_vec(),
        octave,
        voicing: Voicing::Triad,
        rhythm: mask(rhythm),
        sound: sound.into(),
        fx: with_pan(fx, 0.42),
    })
}

/// A seeded 8-note walk lead, max step 2.
fn walk(
    start: i32,
    lo: i32,
    hi: i32,
    density: usize,
    octave: i32,
    sound: &str,
    fx: &str,
) -> MelodySpec {
    MelodySpec::Walk {
        len: 8,
        start,
        max_step: 2,
        lo,
        hi,
        density,
        octave,
        sound: sound.into(),
        fx: with_pan(fx, 0.62),
    }
}

fn arp(chord: &[i32], octaves: usize, dir: Dir, octave: i32, sound: &str, fx: &str) -> MelodySpec {
    MelodySpec::Arpeggio {
        chord: chord.to_vec(),
        octaves,
        dir,
        octave,
        sound: sound.into(),
        fx: with_pan(fx, 0.62),
    }
}

fn hats(interval: usize, offset: usize) -> DrumArchetype {
    DrumArchetype::ClosedHats { interval, offset }
}

// ---------------------------------------------------------------------------
// The specs, family by family (map order).
// ---------------------------------------------------------------------------

/// Every populated spec beyond the Phase 0 five, in map order.
pub fn extras() -> Vec<GenreSpec> {
    use BassStyle::*;
    use Dir::{Up, UpDown};
    use DrumArchetype::*;
    let mut v: Vec<GenreSpec> = Vec::new();

    // ---- House (deep house = the Phase 0 `house` spec) -------------------
    {
        let mut s = g(
            "tech-house",
            "tech house",
            "house",
            (124, 128),
            "a dorian",
            "groovy",
            "four-on-floor, offbeat hats, clipped dorian stabs",
        );
        s.drums = vec![FourOnFloor, OffbeatOpenHat, BackbeatClap, hats(2, 1)];
        s.bass = bass(
            OffbeatRoot,
            2,
            "sawtooth",
            ".lpf(750).resonance(7).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 3, 4, 3],
            3,
            "~1~1",
            "sawtooth",
            ".release(0.12).lpf(2100).gain(0.4).room(0.25)",
        );
        s.melody = walk(
            7,
            4,
            11,
            4,
            4,
            "wt_pluck",
            ".delay(0.3).room(0.25).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "acid-house",
            "acid house",
            "house",
            (123, 127),
            "a minor",
            "raw",
            "four-on-floor, squelching 303 line, sparse stabs",
        );
        s.drums = vec![FourOnFloor, OffbeatOpenHat, BackbeatClap];
        s.bass = bass(
            Acid303,
            2,
            "sawtooth",
            ".lpf(1100).resonance(18).gain(0.48)",
        );
        s.harmony = sevenths(
            &[0, 5],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.15).lpf(1600).gain(0.32).room(0.3)",
        );
        v.push(s);
    }

    // ---- Techno (generic = Phase 0 `techno`) -----------------------------
    {
        let mut s = g(
            "detroit-techno",
            "Detroit techno",
            "techno",
            (126, 130),
            "c dorian",
            "soulful",
            "four-on-floor, warm dorian chords over a rolling machine bass",
        );
        s.drums = vec![FourOnFloor, BackbeatClap, hats(2, 1)];
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(850).resonance(6).gain(0.48)",
        );
        s.harmony = sevenths(
            &[0, 3, 4, 3],
            3,
            "~1~~",
            "gm_epiano1",
            ".release(0.3).gain(0.4).room(0.35)",
        );
        s.melody = walk(7, 4, 12, 4, 4, "wt_bell", ".delay(0.3).room(0.4).gain(0.3)");
        v.push(s);
    }
    {
        let mut s = g(
            "minimal-techno",
            "minimal techno",
            "techno",
            (126, 130),
            "c phrygian",
            "hypnotic",
            "stripped four-on-floor, ticking hats, slow filter hypnosis",
        );
        s.drums = vec![FourOnFloor, hats(2, 1)];
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(sine.range(450, 950).slow(8)).resonance(8).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~~1",
            "sawtooth",
            ".release(0.16).lpf(1300).gain(0.28).room(0.2)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "dub-techno",
            "dub techno",
            "techno",
            (118, 122),
            "c minor",
            "deep",
            "four-on-floor under washed minor chords and a slow sub",
        );
        s.drums = vec![FourOnFloor, hats(2, 1)];
        s.bass = bass(
            SubWobble,
            1,
            "sine",
            ".attack(0.05).release(0.8).gain(0.55)",
        );
        s.harmony = sevenths(
            &[0, 3],
            3,
            "~1~~",
            "sawtooth",
            ".release(0.5).lpf(900).gain(0.34).room(0.8).delay(0.45)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "hard-techno",
            "hard techno",
            "techno",
            (138, 145),
            "c phrygian",
            "dark",
            "pounding four-on-floor, relentless 16th bass, dark stabs",
        );
        s.drums = vec![FourOnFloor, BackbeatClap, hats(1, 0)];
        s.drum_fx = ".gain(0.95).dist(0.25)".into();
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(950).resonance(9).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.14).lpf(1500).gain(0.3).room(0.2)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "acid-techno",
            "acid techno",
            "techno",
            (128, 132),
            "a phrygian",
            "squelchy",
            "four-on-floor with a resonant 303 walk and clap backbeat",
        );
        s.drums = vec![FourOnFloor, BackbeatClap, hats(2, 1)];
        s.bass = bass(
            Acid303,
            2,
            "sawtooth",
            ".lpf(1200).resonance(20).gain(0.48)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.15).lpf(1400).gain(0.28).room(0.2)",
        );
        v.push(s);
    }

    // ---- Trance -----------------------------------------------------------
    {
        let mut s = g(
            "uplifting-trance",
            "uplifting trance",
            "trance",
            (136, 140),
            "a minor",
            "euphoric",
            "four-on-floor, rolling 16th bass, supersaw lift, gated arp",
        );
        s.drums = vec![FourOnFloor, OffbeatOpenHat, BackbeatClap, hats(1, 0)];
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(700).resonance(5).gain(0.48)",
        );
        s.harmony = sevenths(
            &[0, 5, 3, 6],
            3,
            "~1~1",
            "supersaw",
            ".release(0.2).lpf(2400).gain(0.36).room(0.4)",
        );
        s.melody = arp(
            &[0, 2, 4, 7],
            1,
            Up,
            4,
            "wt_lead",
            ".delay(0.35).room(0.4).gain(0.33)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "psytrance",
            "psytrance",
            "trance",
            (142, 148),
            "f# phrygian",
            "psychedelic",
            "four-on-floor with the rolling offbeat psy bass engine",
        );
        s.drums = vec![FourOnFloor, hats(2, 1)];
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(650).resonance(10).gain(0.52)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~~1",
            "sawtooth",
            ".release(0.12).lpf(1800).gain(0.26).room(0.3)",
        );
        s.melody = walk(
            7,
            5,
            13,
            4,
            4,
            "wt_lead",
            ".delay(0.25).room(0.35).gain(0.28)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "progressive-trance",
            "progressive trance",
            "trance",
            (130, 134),
            "e minor",
            "hypnotic",
            "four-on-floor, offbeat bass pulse, long pads, slow arp",
        );
        s.drums = vec![FourOnFloor, OffbeatOpenHat, hats(2, 0)];
        s.bass = bass(
            OffbeatRoot,
            2,
            "sawtooth",
            ".lpf(650).resonance(5).gain(0.48)",
        );
        s.harmony = sevenths(
            &[0, 5, 6, 5],
            3,
            "",
            "wt_pad",
            ".attack(1).release(2).lpf(1400).gain(0.32).room(0.6)",
        );
        s.melody = arp(
            &[0, 2, 4],
            2,
            Up,
            4,
            "wt_pluck",
            ".delay(0.4).room(0.4).gain(0.3)",
        );
        v.push(s);
    }

    // ---- Drum & Bass (generic/neurofunk = Phase 0 `drum-and-bass`) --------
    {
        let mut s = g(
            "liquid-dnb",
            "liquid drum & bass",
            "drum-and-bass",
            (172, 176),
            "e minor",
            "lush",
            "two-step break, deep sub, Rhodes wash, floating lead",
        );
        s.aliases = vec!["liquid"];
        s.drums = vec![TwoStep, hats(1, 0)];
        s.drum_fx = ".gain(0.9)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.02).release(0.5).gain(0.58)");
        s.harmony = sevenths(
            &[0, 3, 5, 4],
            3,
            "",
            "gm_epiano1",
            ".release(0.5).gain(0.38).room(0.5)",
        );
        s.melody = walk(
            7,
            4,
            12,
            4,
            4,
            "wt_flute",
            ".delay(0.35).room(0.5).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "jump-up",
            "jump-up",
            "drum-and-bass",
            (172, 176),
            "g minor",
            "bouncy",
            "two-step break with a talking octave bass hook",
        );
        s.drums = vec![TwoStep, hats(2, 0)];
        s.bass = bass(
            OctaveBounce,
            1,
            "supersquare",
            ".lpf(900).resonance(12).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 5],
            3,
            "~1",
            "sawtooth",
            ".release(0.14).lpf(1500).gain(0.3).room(0.25)",
        );
        v.push(s);
    }

    // ---- Bass / Dubstep ----------------------------------------------------
    {
        let mut s = g(
            "dubstep",
            "dubstep",
            "bass",
            (138, 142),
            "e minor",
            "heavy",
            "half-time drop, wobbling sub, cavernous space",
        );
        s.drums = vec![HalfTime, hats(2, 0)];
        s.drum_fx = ".gain(0.95)".into();
        s.bass = bass(
            SubWobble,
            1,
            "supersaw",
            ".lpf(400).resonance(14).gain(0.55)",
        );
        s.harmony = sevenths(
            &[0, 5],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.3).lpf(1100).gain(0.3).room(0.5)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "future-bass",
            "future bass",
            "bass",
            (145, 155),
            "d major",
            "bright",
            "half-time bounce, detuned supersaw chords, bright lead",
        );
        s.drums = vec![HalfTime, TrapHats];
        s.bass = bass(Sub808, 1, "sine", ".attack(0.02).release(0.6).gain(0.55)");
        s.harmony = sevenths(
            &[0, 4, 5, 3],
            3,
            "~11~",
            "supersaw",
            ".release(0.25).lpf(2600).gain(0.38).room(0.45)",
        );
        s.melody = walk(
            7,
            4,
            12,
            2,
            4,
            "wt_lead",
            ".delay(0.3).room(0.4).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "trap-edm",
            "trap (EDM)",
            "bass",
            (138, 142),
            "c# phrygian",
            "hard",
            "half-time 808 slam with rolled hats and a dark stab",
        );
        s.drums = vec![HalfTime, TrapHats];
        s.drum_fx = ".gain(0.95)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.01).release(0.7).gain(0.6)");
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.2).lpf(1300).gain(0.3).room(0.3)",
        );
        v.push(s);
    }

    // ---- Breakbeat ---------------------------------------------------------
    {
        let mut s = g(
            "big-beat",
            "big beat",
            "breakbeat",
            (128, 132),
            "e mixolydian",
            "funky",
            "driven break, octave bass riff, blaring stabs",
        );
        s.drums = vec![Breakbeat, hats(2, 0)];
        s.drum_fx = ".gain(0.95).dist(0.15)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(900).resonance(8).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 6],
            3,
            "1~~1",
            "sawtooth",
            ".release(0.15).lpf(2000).gain(0.36).room(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "nu-skool-breaks",
            "nu skool breaks",
            "breakbeat",
            (128, 132),
            "a minor",
            "electro",
            "chunky break, reese undertow, electro stabs",
        );
        s.drums = vec![Breakbeat, hats(2, 1)];
        s.bass = bass(
            ReeseSparse,
            1,
            "supersaw",
            ".lpf(600).resonance(10).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 5, 6, 5],
            3,
            "~1~1",
            "sawtooth",
            ".release(0.14).lpf(1700).gain(0.32).room(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "broken-beat",
            "broken beat",
            "breakbeat",
            (118, 122),
            "d dorian",
            "jazzy",
            "swung broken drums, walking bass, Rhodes extensions",
        );
        s.swing = 0.3;
        s.drums = vec![Breakbeat, hats(2, 1)];
        s.bass = bass(Walking, 2, "gm_acoustic_bass", ".gain(0.58)");
        s.harmony = sevenths(
            &[0, 3, 4, 1],
            3,
            "",
            "gm_epiano1",
            ".release(0.4).gain(0.4).room(0.35)",
        );
        s.melody = walk(
            4,
            2,
            11,
            2,
            4,
            "wt_flute",
            ".room(0.35).delay(0.2).gain(0.3)",
        );
        v.push(s);
    }

    // ---- UK Garage ---------------------------------------------------------
    {
        let mut s = g(
            "2-step-garage",
            "2-step garage",
            "uk-garage",
            (128, 132),
            "g minor",
            "shuffled",
            "shuffled 2-step, warm sub, clipped chord skips",
        );
        s.aliases = vec!["2-step", "ukg"];
        s.swing = 0.55;
        s.drums = vec![Shuffled2Step];
        s.bass = bass(Sub808, 1, "sine", ".attack(0.02).release(0.4).gain(0.58)");
        s.harmony = sevenths(
            &[0, 3, 4, 3],
            3,
            "~1~1",
            "gm_epiano1",
            ".release(0.18).gain(0.4).room(0.3)",
        );
        s.melody = walk(
            7,
            4,
            11,
            4,
            4,
            "wt_pluck",
            ".delay(0.25).room(0.3).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "speed-garage",
            "speed garage",
            "uk-garage",
            (133, 137),
            "f minor",
            "bassy",
            "two-step drive with a warped reese sub",
        );
        s.swing = 0.4;
        s.drums = vec![TwoStep, hats(2, 1)];
        s.bass = bass(
            ReeseSparse,
            1,
            "supersaw",
            ".lpf(550).resonance(12).gain(0.55)",
        );
        s.harmony = sevenths(
            &[0, 5],
            3,
            "~1",
            "sawtooth",
            ".release(0.15).lpf(1600).gain(0.3).room(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "future-garage",
            "future garage",
            "uk-garage",
            (132, 138),
            "a minor",
            "moody",
            "shuffled 2-step, hollow pads, sparse bell fragments",
        );
        s.swing = 0.5;
        s.drums = vec![Shuffled2Step];
        s.bass = bass(Sub808, 1, "sine", ".attack(0.03).release(0.6).gain(0.55)");
        s.harmony = sevenths(
            &[0, 5, 3, 5],
            3,
            "",
            "wt_pad",
            ".attack(0.8).release(1.5).lpf(1100).gain(0.3).room(0.7)",
        );
        s.melody = walk(
            7,
            4,
            11,
            3,
            4,
            "wt_bell",
            ".delay(0.4).room(0.6).gain(0.28)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "grime",
            "grime",
            "uk-garage",
            (138, 142),
            "c minor",
            "gritty",
            "half-time menace, square sub jabs, cold stabs",
        );
        s.drums = vec![HalfTime, hats(2, 0)];
        s.bass = bass(Sub808, 1, "square", ".lpf(500).gain(0.55)");
        s.harmony = sevenths(
            &[0, 1],
            3,
            "1~~1",
            "sawtooth",
            ".release(0.12).lpf(1400).gain(0.3).room(0.25)",
        );
        v.push(s);
    }

    // ---- Hardcore ----------------------------------------------------------
    {
        let mut s = g(
            "gabber",
            "gabber",
            "hardcore",
            (175, 185),
            "a phrygian",
            "brutal",
            "distorted gabber kick wall, driving 16th bass",
        );
        s.drums = vec![GabberKick, hats(2, 1)];
        s.drum_fx = ".gain(0.95).dist(0.5)".into();
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(900).resonance(8).gain(0.48).dist(0.2)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.1).lpf(1800).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "happy-hardcore",
            "happy hardcore",
            "hardcore",
            (165, 175),
            "c major",
            "euphoric",
            "4/4 kick over a break, bouncing octave bass, rave arp",
        );
        s.drums = vec![FourOnFloor, Breakbeat];
        s.drum_fx = ".gain(0.95)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(800).resonance(6).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 4, 5, 3],
            3,
            "~1~1",
            "supersaw",
            ".release(0.18).lpf(2400).gain(0.36).room(0.35)",
        );
        s.melody = arp(
            &[0, 2, 4],
            1,
            UpDown,
            4,
            "square",
            ".release(0.2).delay(0.25).room(0.3).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "breakcore",
            "breakcore",
            "hardcore",
            (190, 210),
            "d phrygian",
            "chaotic",
            "amen chop at breakneck tempo, reese growl",
        );
        s.drums = vec![Amen, hats(1, 0)];
        s.drum_fx = ".gain(0.95)".into();
        s.bass = bass(
            ReeseSparse,
            1,
            "supersaw",
            ".lpf(650).resonance(12).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.1).lpf(1600).gain(0.28)",
        );
        v.push(s);
    }

    // ---- Hard Dance --------------------------------------------------------
    {
        let mut s = g(
            "hardstyle",
            "hardstyle",
            "hard-dance",
            (148, 152),
            "f minor",
            "euphoric",
            "punished kick, offbeat bass slam, supersaw anthem stabs",
        );
        s.drums = vec![GabberKick, BackbeatClap];
        s.drum_fx = ".gain(0.95).dist(0.35)".into();
        s.bass = bass(
            OffbeatRoot,
            2,
            "sawtooth",
            ".lpf(700).resonance(8).gain(0.52).dist(0.15)",
        );
        s.harmony = sevenths(
            &[0, 5, 3, 6],
            3,
            "~1~1",
            "supersaw",
            ".release(0.2).lpf(2200).gain(0.36).room(0.35)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "jumpstyle",
            "jumpstyle",
            "hard-dance",
            (142, 148),
            "g minor",
            "bouncy",
            "stomping four-on-floor, springy offbeat bass",
        );
        s.drums = vec![FourOnFloor, BackbeatClap];
        s.drum_fx = ".gain(0.95)".into();
        s.bass = bass(
            OffbeatRoot,
            2,
            "sawtooth",
            ".lpf(750).resonance(7).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 5, 6, 5],
            3,
            "~1~1",
            "sawtooth",
            ".release(0.16).lpf(1900).gain(0.34).room(0.3)",
        );
        v.push(s);
    }

    // ---- Ambient (generic = Phase 0 `ambient`) -----------------------------
    {
        let mut s = g(
            "dark-ambient",
            "dark ambient",
            "ambient",
            (50, 60),
            "c phrygian",
            "ominous",
            "beatless low drone, slow dark pads, distant bells",
        );
        s.drums = vec![];
        s.bass = bass(Drone, 1, "sine", ".attack(4).release(6).gain(0.5)");
        s.harmony = sevenths(
            &[0, 1],
            3,
            "",
            "wt_strings",
            ".attack(3).release(5).lpf(700).gain(0.3).room(0.9)",
        );
        s.melody = walk(
            7,
            4,
            10,
            3,
            3,
            "wt_bell",
            ".room(0.85).delay(0.5).gain(0.26)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "ambient-dub",
            "ambient dub",
            "ambient",
            (65, 75),
            "c minor",
            "deep",
            "slow skank pulse, sub swells, echoing chords",
        );
        s.drums = vec![DubSkank, SparsePulse];
        s.drum_fx = ".gain(0.5).room(0.6)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.05).release(1).gain(0.55)");
        s.harmony = sevenths(
            &[0, 3],
            3,
            "~1~~",
            "gm_epiano1",
            ".release(0.6).gain(0.34).room(0.8).delay(0.5)",
        );
        s.melody = walk(
            7,
            4,
            11,
            3,
            4,
            "gm_kalimba",
            ".room(0.7).delay(0.45).gain(0.3)",
        );
        v.push(s);
    }

    // ---- Chill-out / Downtempo ---------------------------------------------
    {
        let mut s = g(
            "trip-hop",
            "trip-hop",
            "downtempo",
            (85, 92),
            "c# minor",
            "dusty",
            "dragging boom-bap, sub weight, noir Rhodes",
        );
        s.swing = 0.35;
        s.swing_unit = SwingUnit::Eighth;
        s.drums = vec![BoomBap, hats(2, 0)];
        s.drum_fx = ".gain(0.85).crush(9)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.02).release(0.6).gain(0.55)");
        s.harmony = sevenths(
            &[0, 5, 3, 5],
            3,
            "",
            "gm_epiano1",
            ".release(0.5).gain(0.38).room(0.45)",
        );
        s.melody = walk(
            4,
            2,
            10,
            2,
            4,
            "wt_flute",
            ".room(0.4).delay(0.3).gain(0.28)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "downtempo",
            "downtempo",
            "downtempo",
            (95, 105),
            "g dorian",
            "mellow",
            "relaxed boom-bap, walking bass, warm keys",
        );
        s.swing = 0.2;
        s.swing_unit = SwingUnit::Eighth;
        s.drums = vec![BoomBap, hats(2, 0)];
        s.drum_fx = ".gain(0.85)".into();
        s.bass = bass(Walking, 2, "gm_acoustic_bass", ".gain(0.58)");
        s.harmony = sevenths(
            &[0, 3, 4, 0],
            3,
            "",
            "gm_epiano1",
            ".release(0.45).gain(0.4).room(0.35)",
        );
        s.melody = walk(
            4,
            2,
            11,
            2,
            4,
            "gm_marimba",
            ".room(0.35).delay(0.25).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "psybient",
            "psybient",
            "downtempo",
            (95, 105),
            "e phrygian",
            "psychedelic",
            "soft pulse, drifting drone, phrygian bell trails",
        );
        s.drums = vec![SparsePulse];
        s.drum_fx = ".gain(0.25).room(0.6)".into();
        s.bass = bass(Drone, 2, "sine", ".attack(2.5).release(4).gain(0.45)");
        s.harmony = sevenths(
            &[0, 1, 0, 5],
            3,
            "",
            "wt_pad",
            ".attack(2).release(4).lpf(1100).gain(0.3).room(0.85)",
        );
        s.melody = walk(
            7,
            4,
            12,
            3,
            4,
            "wt_bell",
            ".room(0.8).delay(0.5).gain(0.28)",
        );
        v.push(s);
    }

    // ---- Hip-hop Fusion (lo-fi = Phase 0 `hip-hop`) -------------------------
    {
        let mut s = g(
            "trap",
            "trap",
            "hip-hop",
            (138, 142),
            "c# phrygian",
            "dark",
            "half-time 808s, hat rolls, cold two-chord loop",
        );
        s.drums = vec![HalfTime, TrapHats];
        s.drum_fx = ".gain(0.92)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.01).release(0.8).gain(0.6)");
        s.harmony = sevenths(
            &[0, 1],
            3,
            "",
            "wt_pad",
            ".attack(0.5).release(1.2).lpf(1000).gain(0.3).room(0.5)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "phonk",
            "phonk",
            "hip-hop",
            (128, 134),
            "a phrygian",
            "cold",
            "crushed boom-bap with rolls, 808 sub, icy stabs",
        );
        s.drums = vec![BoomBap, TrapHats];
        s.drum_fx = ".gain(0.9).crush(8)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.01).release(0.7).gain(0.58)");
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~1~~",
            "sawtooth",
            ".release(0.2).lpf(1200).gain(0.3).room(0.35)",
        );
        s.melody = walk(
            7,
            4,
            11,
            4,
            4,
            "wt_bell",
            ".room(0.4).delay(0.3).gain(0.28)",
        );
        v.push(s);
    }

    // ---- Disco Fusion --------------------------------------------------------
    {
        let mut s = g(
            "nu-disco",
            "nu-disco",
            "disco",
            (118, 122),
            "c dorian",
            "funky",
            "four-on-floor strut, octave disco bass, juicy stabs",
        );
        s.drums = vec![FourOnFloor, OffbeatOpenHat, BackbeatClap];
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(850).resonance(6).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 3, 4, 3],
            3,
            "~1~1",
            "gm_epiano1",
            ".release(0.2).gain(0.4).room(0.3)",
        );
        s.melody = walk(
            7,
            4,
            11,
            2,
            4,
            "wt_pluck",
            ".delay(0.25).room(0.3).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "italo-disco",
            "italo disco",
            "disco",
            (118, 122),
            "a minor",
            "retro",
            "four-on-floor, octave synth bass, mirrored arpeggio hook",
        );
        s.drums = vec![FourOnFloor, BackbeatClap, hats(2, 0)];
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(800).resonance(7).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 5, 6, 4],
            3,
            "~1~1",
            "supersaw",
            ".release(0.2).lpf(2200).gain(0.34).room(0.35)",
        );
        s.melody = arp(
            &[0, 2, 4],
            1,
            UpDown,
            4,
            "wt_lead",
            ".delay(0.3).room(0.35).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "french-house",
            "French house",
            "disco",
            (121, 125),
            "f dorian",
            "filtered",
            "four-on-floor, filtered stab loop, pumping offbeat bass",
        );
        s.drums = vec![FourOnFloor, OffbeatOpenHat, hats(1, 0)];
        s.bass = bass(
            OffbeatRoot,
            2,
            "sawtooth",
            ".lpf(600).resonance(6).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 3, 4, 3],
            3,
            "1~1~",
            "sawtooth",
            ".release(0.18).lpf(1200).gain(0.38).room(0.3)",
        );
        v.push(s);
    }

    // ---- Industrial / EBM ----------------------------------------------------
    {
        let mut s = g(
            "ebm",
            "EBM",
            "industrial",
            (126, 130),
            "a minor",
            "mechanical",
            "four-on-floor with snare, sequenced 16th bass, cold stabs",
        );
        s.drums = vec![FourOnFloor, BackbeatSnare, hats(2, 1)];
        s.drum_fx = ".gain(0.92).dist(0.15)".into();
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(800).resonance(10).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 5],
            3,
            "~1~1",
            "sawtooth",
            ".release(0.12).lpf(1600).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "industrial-techno",
            "industrial techno",
            "industrial",
            (132, 138),
            "c phrygian",
            "harsh",
            "grinding four-on-floor, euclid toms, distorted bass engine",
        );
        s.drums = vec![FourOnFloor, hats(1, 0), EuclidTom { k: 5, n: 16 }];
        s.drum_fx = ".gain(0.92).dist(0.3)".into();
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(850).resonance(9).gain(0.5).dist(0.15)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.12).lpf(1400).gain(0.28).room(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "witch-house",
            "witch house",
            "industrial",
            (95, 105),
            "e phrygian",
            "occult",
            "half-time crawl, detuned pads, buried bells",
        );
        s.drums = vec![HalfTime, hats(2, 0)];
        s.drum_fx = ".gain(0.88).crush(9)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.03).release(0.9).gain(0.55)");
        s.harmony = sevenths(
            &[0, 1, 0, 3],
            3,
            "",
            "wt_choir",
            ".attack(1).release(2.5).lpf(900).gain(0.3).room(0.8)",
        );
        s.melody = walk(
            7,
            4,
            10,
            3,
            3,
            "wt_bell",
            ".room(0.7).delay(0.45).gain(0.26)",
        );
        v.push(s);
    }

    // ---- IDM -------------------------------------------------------------------
    {
        let mut s = g(
            "idm",
            "IDM",
            "idm",
            (120, 140),
            "d dorian",
            "glitchy",
            "broken beat against an euclid pulse, soft keys, wandering lead",
        );
        s.drums = vec![Breakbeat, EuclidTom { k: 7, n: 16 }];
        s.bass = bass(ReeseSparse, 1, "fm", ".lpf(700).gain(0.5)");
        s.harmony = sevenths(
            &[0, 3, 1, 4],
            3,
            "",
            "gm_epiano1",
            ".release(0.4).gain(0.36).room(0.4)",
        );
        s.melody = walk(
            7,
            2,
            12,
            3,
            4,
            "wt_bell",
            ".delay(0.35).room(0.4).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "drill-n-bass",
            "drill 'n' bass",
            "idm",
            (165, 175),
            "e phrygian",
            "frantic",
            "amen shrapnel at speed, growling reese, needle stabs",
        );
        s.drums = vec![Amen, hats(1, 0)];
        s.drum_fx = ".gain(0.92)".into();
        s.bass = bass(
            ReeseSparse,
            1,
            "supersaw",
            ".lpf(700).resonance(11).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.1).lpf(1700).gain(0.28)",
        );
        v.push(s);
    }

    // ---- Hauntology --------------------------------------------------------------
    {
        let mut s = g(
            "synthwave",
            "synthwave",
            "hauntology",
            (98, 104),
            "a minor",
            "nostalgic",
            "gated rock beat, octave synth bass, neon arp",
        );
        s.drums = vec![RockBeat, hats(2, 0)];
        s.drum_fx = ".gain(0.9).room(0.4)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(750).resonance(6).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 5, 6, 4],
            3,
            "",
            "wt_pad",
            ".attack(0.6).release(1.5).lpf(1600).gain(0.32).room(0.5)",
        );
        s.melody = arp(
            &[0, 2, 4, 7],
            1,
            Up,
            4,
            "wt_lead",
            ".delay(0.35).room(0.45).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "darksynth",
            "darksynth",
            "hauntology",
            (105, 115),
            "c phrygian",
            "menacing",
            "pounding retro beat, grinding octave bass, sinister stabs",
        );
        s.drums = vec![FourOnFloor, BackbeatSnare, hats(2, 1)];
        s.drum_fx = ".gain(0.92).dist(0.2)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(700).resonance(9).gain(0.52).dist(0.1)",
        );
        s.harmony = sevenths(
            &[0, 1, 0, 5],
            3,
            "~1~1",
            "supersaw",
            ".release(0.2).lpf(1800).gain(0.32).room(0.35)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "vaporwave",
            "vaporwave",
            "hauntology",
            (65, 75),
            "c major",
            "hazy",
            "slow-motion boom-bap, drowned lush sevenths, faded lead",
        );
        s.drums = vec![BoomBap];
        s.drum_fx = ".gain(0.8).crush(9).room(0.5)".into();
        s.bass = bass(Walking, 2, "gm_acoustic_bass", ".gain(0.55)");
        s.harmony = sevenths(
            &[0, 3, 5, 4],
            3,
            "",
            "gm_epiano1",
            ".release(0.8).gain(0.4).room(0.75).delay(0.4)",
        );
        s.melody = walk(
            4,
            2,
            10,
            2,
            4,
            "wt_choir",
            ".attack(0.3).room(0.7).delay(0.4).gain(0.26)",
        );
        v.push(s);
    }

    // ---- Electronica ----------------------------------------------------------------
    {
        let mut s = g(
            "folktronica",
            "folktronica",
            "electronica",
            (105, 115),
            "g major",
            "organic",
            "soft boom-bap, upright bass, kalimba line",
        );
        s.drums = vec![BoomBap];
        s.drum_fx = ".gain(0.8)".into();
        s.bass = bass(Walking, 2, "gm_acoustic_bass", ".gain(0.56)");
        s.harmony = sevenths(
            &[0, 4, 5, 3],
            3,
            "",
            "wt_piano",
            ".release(0.5).gain(0.38).room(0.4)",
        );
        s.melody = walk(
            4,
            2,
            11,
            2,
            4,
            "gm_kalimba",
            ".room(0.4).delay(0.25).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "nu-jazz",
            "nu-jazz",
            "electronica",
            (105, 115),
            "d dorian",
            "jazzy",
            "swung beat, walking bass, extended Rhodes voicings",
        );
        s.swing = 0.3;
        s.drums = vec![BoomBap, hats(2, 1)];
        s.drum_fx = ".gain(0.82)".into();
        s.bass = bass(Walking, 2, "gm_acoustic_bass", ".gain(0.58)");
        s.harmony = sevenths(
            &[0, 3, 1, 4],
            3,
            "",
            "gm_epiano1",
            ".release(0.45).gain(0.4).room(0.35)",
        );
        s.melody = walk(
            4,
            2,
            12,
            2,
            4,
            "wt_trumpet",
            ".room(0.35).delay(0.2).gain(0.28)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "berlin-school",
            "Berlin school",
            "electronica",
            (100, 120),
            "a minor",
            "cosmic",
            "beatless sequencer pulse, deep pads, eight-step arp orbit",
        );
        s.drums = vec![];
        s.bass = bass(
            Rolling16th,
            2,
            "sawtooth",
            ".lpf(600).resonance(6).gain(0.42)",
        );
        s.harmony = sevenths(
            &[0, 5, 3, 6],
            3,
            "",
            "wt_strings",
            ".attack(2).release(4).lpf(1200).gain(0.3).room(0.8)",
        );
        s.melody = arp(
            &[0, 2, 4, 7],
            2,
            Up,
            4,
            "triangle",
            ".delay(0.4).room(0.5).gain(0.32)",
        );
        v.push(s);
    }

    // ---- Electronic Rock ---------------------------------------------------------------
    {
        let mut s = g(
            "synth-pop",
            "synth-pop",
            "electronic-rock",
            (116, 120),
            "c major",
            "catchy",
            "rock backbeat, octave synth bass, bright hook chords",
        );
        s.drums = vec![RockBeat, hats(2, 0)];
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(800).resonance(5).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 4, 5, 3],
            3,
            "~1~1",
            "supersaw",
            ".release(0.2).lpf(2200).gain(0.36).room(0.3)",
        );
        s.melody = walk(
            7,
            4,
            11,
            2,
            4,
            "square",
            ".release(0.2).delay(0.25).room(0.3).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "new-wave",
            "new wave",
            "electronic-rock",
            (128, 132),
            "b minor",
            "angular",
            "driving backbeat, insistent octave bass, angular stabs",
        );
        s.drums = vec![RockBeat, hats(2, 0)];
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(850).resonance(7).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 5, 6, 5],
            3,
            "1~1~",
            "sawtooth",
            ".release(0.15).lpf(1900).gain(0.34).room(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "indie-synth-rock",
            "indie synth-rock",
            "electronic-rock",
            (120, 128),
            "e major",
            "anthemic",
            "four-on-floor rock drive, octave bass, wide sustained synths",
        );
        s.drums = vec![FourOnFloor, BackbeatSnare, hats(2, 0)];
        s.drum_fx = ".gain(0.92)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(900).resonance(5).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 4, 5, 3],
            3,
            "",
            "supersaw",
            ".attack(0.2).release(0.8).lpf(2000).gain(0.34).room(0.45)",
        );
        s.melody = walk(7, 4, 12, 2, 4, "wt_lead", ".delay(0.3).room(0.4).gain(0.3)");
        v.push(s);
    }
    {
        let mut s = g(
            "pop-punk",
            "pop-punk",
            "electronic-rock",
            (150, 170),
            "e major",
            "energetic",
            "fast rock beat, driving octave bass, power-chord triads",
        );
        s.drums = vec![RockBeat, hats(1, 0)];
        s.drum_fx = ".gain(0.95)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "sawtooth",
            ".lpf(1000).resonance(4).gain(0.52).dist(0.15)",
        );
        s.harmony = triads(
            &[0, 4, 5, 3],
            3,
            "1~1~",
            "sawtooth",
            ".release(0.2).lpf(2400).gain(0.4).dist(0.2)",
        );
        v.push(s);
    }

    // ---- Afro / Regional -----------------------------------------------------------------
    {
        let mut s = g(
            "amapiano",
            "amapiano",
            "afro",
            (110, 115),
            "f# minor",
            "smooth",
            "log drum bounce, soft claps, glassy keys over quiet sub",
        );
        s.drums = vec![LogDrum, hats(2, 0), BackbeatClap];
        s.drum_fx = ".gain(0.9)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.03).release(0.6).gain(0.52)");
        s.harmony = sevenths(
            &[0, 3, 4, 3],
            3,
            "",
            "gm_epiano1",
            ".release(0.5).gain(0.38).room(0.45)",
        );
        s.melody = walk(
            7,
            4,
            11,
            3,
            4,
            "wt_pluck",
            ".delay(0.3).room(0.4).gain(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "afro-house",
            "afro house",
            "afro",
            (118, 122),
            "a dorian",
            "percussive",
            "four-on-floor with a soft clap-and-hat percussion web, kalimba call",
        );
        s.drums = vec![FourOnFloor, BackbeatClap, OffbeatOpenHat, hats(2, 1)];
        s.bass = bass(
            OffbeatRoot,
            2,
            "sawtooth",
            ".lpf(700).resonance(6).gain(0.5)",
        );
        s.harmony = sevenths(
            &[0, 3],
            3,
            "~1~~",
            "gm_epiano1",
            ".release(0.3).gain(0.36).room(0.35)",
        );
        s.melody = walk(
            7,
            4,
            11,
            2,
            4,
            "gm_kalimba",
            ".delay(0.25).room(0.35).gain(0.32)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "gqom",
            "gqom",
            "afro",
            (122, 128),
            "c phrygian",
            "raw",
            "broken half-time weight, tom triplet pull, dark sub",
        );
        s.drums = vec![HalfTime, EuclidTom { k: 3, n: 8 }];
        s.drum_fx = ".gain(0.95)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.02).release(0.7).gain(0.58)");
        s.harmony = sevenths(
            &[0, 1],
            3,
            "~~1~",
            "wt_pad",
            ".attack(0.4).release(1).lpf(900).gain(0.28).room(0.5)",
        );
        v.push(s);
    }

    // ---- Footwork / Juke ---------------------------------------------------------------------
    {
        let mut s = g(
            "footwork",
            "footwork",
            "footwork",
            (155, 165),
            "g minor",
            "frantic",
            "rapid 808 syncopation, clap cross-fire, hypnotic stab",
        );
        s.drums = vec![Rapid808, BackbeatClap];
        s.drum_fx = ".gain(0.92)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.01).release(0.5).gain(0.58)");
        s.harmony = sevenths(
            &[0, 5],
            3,
            "~~1~",
            "sawtooth",
            ".release(0.15).lpf(1300).gain(0.3).room(0.3)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "juke",
            "juke",
            "footwork",
            (155, 165),
            "g minor",
            "bouncy",
            "rapid 808 pulse with hats, springing sub, party stabs",
        );
        s.drums = vec![Rapid808, hats(2, 0)];
        s.drum_fx = ".gain(0.92)".into();
        s.bass = bass(Sub808, 1, "sine", ".attack(0.01).release(0.5).gain(0.56)");
        s.harmony = sevenths(
            &[0, 3, 4, 3],
            3,
            "~1~1",
            "sawtooth",
            ".release(0.15).lpf(1500).gain(0.32).room(0.3)",
        );
        v.push(s);
    }

    // ---- Dub -----------------------------------------------------------------------------------
    {
        let mut s = g(
            "dub",
            "dub",
            "dub",
            (70, 80),
            "a dorian",
            "spacious",
            "one-drop skank, walking bass, chords lost in echo",
        );
        s.swing = 0.25;
        s.drums = vec![DubSkank, hats(2, 1)];
        s.drum_fx = ".gain(0.88).room(0.4)".into();
        s.bass = bass(Walking, 1, "gm_acoustic_bass", ".gain(0.6)");
        s.harmony = sevenths(
            &[0, 3],
            3,
            "~1~1",
            "gm_epiano1",
            ".release(0.25).gain(0.38).room(0.7).delay(0.55)",
        );
        v.push(s);
    }

    // ---- Video Game ----------------------------------------------------------------------------
    {
        let mut s = g(
            "chiptune",
            "chiptune",
            "video-game",
            (125, 135),
            "c major",
            "playful",
            "8-bit rock beat, square octave bass, mirrored square arp",
        );
        s.drums = vec![RockBeat, hats(1, 0)];
        s.drum_fx = ".gain(0.85).crush(6)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "square",
            ".release(0.15).gain(0.45).crush(7)",
        );
        s.harmony = triads(
            &[0, 4, 5, 3],
            3,
            "~1~1",
            "pulse",
            ".release(0.15).gain(0.32).crush(7)",
        );
        s.melody = arp(
            &[0, 2, 4],
            1,
            UpDown,
            4,
            "square",
            ".release(0.15).crush(7).gain(0.34)",
        );
        v.push(s);
    }
    {
        let mut s = g(
            "bitpop",
            "bitpop",
            "video-game",
            (126, 130),
            "e major",
            "chirpy",
            "four-on-floor chip drive, square bass, sparkling lead",
        );
        s.drums = vec![FourOnFloor, BackbeatClap, hats(2, 0)];
        s.drum_fx = ".gain(0.88).crush(7)".into();
        s.bass = bass(
            OctaveBounce,
            2,
            "square",
            ".release(0.15).gain(0.45).crush(8)",
        );
        s.harmony = sevenths(
            &[0, 4, 5, 3],
            3,
            "~1~1",
            "pulse",
            ".release(0.18).gain(0.32).crush(8)",
        );
        s.melody = walk(
            7,
            4,
            12,
            2,
            5,
            "square",
            ".release(0.15).delay(0.2).gain(0.3).crush(8)",
        );
        v.push(s);
    }

    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify::validate_doc;

    /// Every populated spec composes and validates across seeds — the Phase 2
    /// non-slop gate. (Alignment and key-safety are already unrepresentable;
    /// this catches bad sound names, fx typos, and silent parts.)
    #[test]
    fn every_extra_spec_composes_across_seeds() {
        for spec in extras() {
            for seed in [1u64, 7, 42] {
                let piece = crate::compose::compose_from_spec(&spec, seed)
                    .unwrap_or_else(|e| panic!("{} (seed {seed}): {e}", spec.name));
                validate_doc(&piece.to_strudel())
                    .unwrap_or_else(|e| panic!("{} (seed {seed}) doc: {e}", spec.name));
            }
        }
    }

    #[test]
    fn extras_do_not_collide_with_phase0_names() {
        let base = ["house", "drum-and-bass", "techno", "ambient", "hip-hop"];
        for spec in extras() {
            assert!(
                !base.contains(&spec.name.as_str()),
                "{} shadows a base spec",
                spec.name
            );
        }
    }
}
