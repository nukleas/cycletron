//! Dump per-track pitch histograms + channel/program assignments for a MIDI file.
//! Used to diagnose why midi-to-strudel mismaps a particular file.
//!
//!     cargo run -p midi-inspect -- path/to/file.mid

use std::collections::BTreeMap;
use std::env;
use std::path::PathBuf;

use anyhow::{Context, Result};
use midly::{MetaMessage, MidiMessage, Smf, TrackEventKind};

const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

fn note_name(midi: u8) -> String {
    let octave = (midi as i32 / 12) - 1;
    format!("{}{}", NOTE_NAMES[(midi % 12) as usize], octave)
}

#[derive(Default)]
struct TrackStats {
    name: Option<String>,
    channels: BTreeMap<u8, ChannelStats>,
}

#[derive(Default)]
struct ChannelStats {
    notes: BTreeMap<u8, u32>,
    note_count: u32,
    program: Option<u8>,
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let path = args
        .first()
        .map(PathBuf::from)
        .context("usage: midi-inspect <path-to-midi>")?;

    let data = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let smf = Smf::parse(&data).context("parsing MIDI")?;

    println!("file: {}", path.display());
    println!("format: {:?}", smf.header.format);
    println!("timing: {:?}", smf.header.timing);
    println!("tracks: {}", smf.tracks.len());
    println!();

    for (track_idx, track) in smf.tracks.iter().enumerate() {
        let mut stats = TrackStats::default();
        for event in track {
            match event.kind {
                TrackEventKind::Meta(MetaMessage::TrackName(name)) => {
                    if let Ok(s) = std::str::from_utf8(name) {
                        let cleaned = s.trim_end_matches('\0').trim();
                        if !cleaned.is_empty() {
                            stats.name = Some(cleaned.to_string());
                        }
                    }
                }
                TrackEventKind::Midi { channel, message } => {
                    let ch = u8::from(channel);
                    let cs = stats.channels.entry(ch).or_default();
                    match message {
                        MidiMessage::NoteOn { key, vel } if u8::from(vel) > 0 => {
                            let k = u8::from(key);
                            *cs.notes.entry(k).or_insert(0) += 1;
                            cs.note_count += 1;
                        }
                        MidiMessage::ProgramChange { program } => {
                            cs.program = Some(u8::from(program));
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }

        if stats.channels.is_empty() {
            continue;
        }

        let label = stats.name.as_deref().unwrap_or("(unnamed)");
        println!("== Track {} — {} ==", track_idx, label);
        for (ch, cs) in &stats.channels {
            let prog = cs
                .program
                .map(|p| format!("program={} ({})", p, gm_name(p)))
                .unwrap_or_else(|| "no program".into());
            println!(
                "  channel {} ({}{}): {} notes, {}",
                ch + 1,
                prog,
                if *ch == 9 { ", GM percussion" } else { "" },
                cs.note_count,
                ""
            );

            if cs.notes.is_empty() {
                continue;
            }
            let min = *cs.notes.keys().next().unwrap();
            let max = *cs.notes.keys().next_back().unwrap();
            let distinct = cs.notes.len();
            println!(
                "    pitch range: {} ({}) .. {} ({}); distinct={}",
                min,
                note_name(min),
                max,
                note_name(max),
                distinct,
            );
            // Top-10 most-used notes
            let mut by_count: Vec<(&u8, &u32)> = cs.notes.iter().collect();
            by_count.sort_by(|a, b| b.1.cmp(a.1));
            print!("    top notes:");
            for (k, c) in by_count.iter().take(10) {
                print!(" {}={}", note_name(**k), c);
            }
            println!();
            // Flag bimodal distributions: large gaps between adjacent notes
            let keys: Vec<u8> = cs.notes.keys().copied().collect();
            let mut gaps: Vec<(u8, u8, u8)> = Vec::new();
            for w in keys.windows(2) {
                let gap = w[1] - w[0];
                if gap >= 12 {
                    gaps.push((w[0], w[1], gap));
                }
            }
            if !gaps.is_empty() {
                println!("    !! large pitch gaps (>= 1 octave):");
                for (lo, hi, g) in gaps {
                    println!(
                        "       between {} ({}) and {} ({}): {} semitones",
                        lo,
                        note_name(lo),
                        hi,
                        note_name(hi),
                        g
                    );
                }
            }
        }
        println!();
    }
    Ok(())
}

fn gm_name(prog: u8) -> &'static str {
    // GM instrument names, abbreviated. prog is 0-127.
    const GM: [&str; 128] = [
        "Acoustic Grand Piano",
        "Bright Acoustic Piano",
        "Electric Grand",
        "Honky-tonk Piano",
        "Electric Piano 1",
        "Electric Piano 2",
        "Harpsichord",
        "Clavinet",
        "Celesta",
        "Glockenspiel",
        "Music Box",
        "Vibraphone",
        "Marimba",
        "Xylophone",
        "Tubular Bells",
        "Dulcimer",
        "Drawbar Organ",
        "Percussive Organ",
        "Rock Organ",
        "Church Organ",
        "Reed Organ",
        "Accordion",
        "Harmonica",
        "Tango Accordion",
        "Acoustic Guitar (nylon)",
        "Acoustic Guitar (steel)",
        "Electric Guitar (jazz)",
        "Electric Guitar (clean)",
        "Electric Guitar (muted)",
        "Overdriven Guitar",
        "Distortion Guitar",
        "Guitar Harmonics",
        "Acoustic Bass",
        "Electric Bass (finger)",
        "Electric Bass (pick)",
        "Fretless Bass",
        "Slap Bass 1",
        "Slap Bass 2",
        "Synth Bass 1",
        "Synth Bass 2",
        "Violin",
        "Viola",
        "Cello",
        "Contrabass",
        "Tremolo Strings",
        "Pizzicato Strings",
        "Orchestral Harp",
        "Timpani",
        "String Ensemble 1",
        "String Ensemble 2",
        "Synth Strings 1",
        "Synth Strings 2",
        "Choir Aahs",
        "Voice Oohs",
        "Synth Voice",
        "Orchestra Hit",
        "Trumpet",
        "Trombone",
        "Tuba",
        "Muted Trumpet",
        "French Horn",
        "Brass Section",
        "Synth Brass 1",
        "Synth Brass 2",
        "Soprano Sax",
        "Alto Sax",
        "Tenor Sax",
        "Baritone Sax",
        "Oboe",
        "English Horn",
        "Bassoon",
        "Clarinet",
        "Piccolo",
        "Flute",
        "Recorder",
        "Pan Flute",
        "Blown Bottle",
        "Shakuhachi",
        "Whistle",
        "Ocarina",
        "Lead 1 (square)",
        "Lead 2 (sawtooth)",
        "Lead 3 (calliope)",
        "Lead 4 (chiff)",
        "Lead 5 (charang)",
        "Lead 6 (voice)",
        "Lead 7 (fifths)",
        "Lead 8 (bass + lead)",
        "Pad 1 (new age)",
        "Pad 2 (warm)",
        "Pad 3 (polysynth)",
        "Pad 4 (choir)",
        "Pad 5 (bowed)",
        "Pad 6 (metallic)",
        "Pad 7 (halo)",
        "Pad 8 (sweep)",
        "FX 1 (rain)",
        "FX 2 (soundtrack)",
        "FX 3 (crystal)",
        "FX 4 (atmosphere)",
        "FX 5 (brightness)",
        "FX 6 (goblins)",
        "FX 7 (echoes)",
        "FX 8 (sci-fi)",
        "Sitar",
        "Banjo",
        "Shamisen",
        "Koto",
        "Kalimba",
        "Bag pipe",
        "Fiddle",
        "Shanai",
        "Tinkle Bell",
        "Agogo",
        "Steel Drums",
        "Woodblock",
        "Taiko Drum",
        "Melodic Tom",
        "Synth Drum",
        "Reverse Cymbal",
        "Guitar Fret Noise",
        "Breath Noise",
        "Seashore",
        "Bird Tweet",
        "Telephone Ring",
        "Helicopter",
        "Applause",
        "Gunshot",
    ];
    let i = prog as usize;
    if i < GM.len() { GM[i] } else { "?" }
}
