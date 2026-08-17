//! Offline export: pattern → WAV / MP3 / stems / MIDI.
//!
//! Audio path uses strudel-rs `OfflineRenderer` (same as `strudio render`).
//! MP3 is produced via an optional `ffmpeg` post-step when available on PATH.
//! MIDI path ports the `strudio to-midi` logic.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;

use midly::{
    Format, Header, MidiMessage, Smf, Timing, Track as MidiTrack, TrackEvent, TrackEventKind,
    num::{u4, u7, u15, u24, u28},
};
use rustc_hash::FxHashMap;
use serde::Serialize;
use strudel_audio::{OfflineRenderer, default_sources};
use strudel_core::{ContextKey, Hap, Pattern, Value, stack};
use strudel_dsl::{
    Directive, EvalContext, Expr, Tempo, evaluate_in_context, evaluate_in_context_with_tempo,
    execute, parse as parse_expr, parse_strudel_file,
};
use strudel_music_theory::MidiNoteNumber;

const SAMPLE_RATE: u32 = 44_100;
const DEFAULT_BPM: f64 = 120.0;
const DEFAULT_GAIN: f32 = 0.7;
const MAX_DURATION_SECS: f64 = 600.0;
const DEFAULT_MIDI_PPQ: u16 = 480;
const DEFAULT_MIDI_VELOCITY: u8 = 100;
const DRUM_CHANNEL: u8 = 9;
const MELODIC_CHANNEL: u8 = 0;

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ExportAudioResult {
    /// Mixdown file path(s) written (`.wav` and/or `.mp3`).
    pub paths: Vec<String>,
    /// Stem file paths (empty when stems were not requested / not splittable).
    pub stem_paths: Vec<String>,
    pub duration_secs: f64,
    pub bpm: f64,
    pub sample_rate: u32,
    pub clipped_samples: u64,
    /// Human-readable note (e.g. "stems: split 3 $: tracks", "mp3 via ffmpeg").
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportMidiResult {
    pub path: String,
    pub cycles: u32,
    pub bpm: f64,
    pub note_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Wav,
    Mp3,
    Both,
}

impl AudioFormat {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "wav" => Ok(Self::Wav),
            "mp3" => Ok(Self::Mp3),
            "both" | "wav+mp3" | "all" => Ok(Self::Both),
            other => Err(format!(
                "Unknown audio format '{other}' (expected wav, mp3, or both)"
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// Audio export
// ---------------------------------------------------------------------------

/// Parse `code`, offline-render audio, optionally encode MP3 and/or stems.
pub fn export_audio(
    code: &str,
    path: impl AsRef<Path>,
    duration_secs: f64,
    bpm: Option<f64>,
    gain: Option<f32>,
    format: AudioFormat,
    stems: bool,
) -> Result<ExportAudioResult, String> {
    let path = path.as_ref();
    validate_code_and_duration(code, duration_secs)?;

    let (stem_patterns, file_tempo) = resolve_patterns(code, stems)?;
    let tempo = resolve_tempo(file_tempo, bpm);
    let gain = resolve_gain(gain);

    tracing::info!(
        target: "cycletron::export",
        path = %path.display(),
        duration_secs,
        bpm = tempo,
        gain,
        ?format,
        stems,
        stem_count = stem_patterns.len(),
        "starting offline audio export"
    );

    // Always bake the full mix first.
    let mix_wav = ensure_wav_path(path);
    let mut notes = Vec::new();
    let mut clipped = 0_u64;

    let mix_pattern = if stem_patterns.len() == 1 {
        stem_patterns[0].1.clone()
    } else {
        stack(stem_patterns.iter().map(|(_, p)| p.clone()).collect())
    };

    clipped += render_pattern_to_wav(&mix_pattern, tempo, gain, duration_secs, &mix_wav)?;

    let mut paths = Vec::new();
    let mut stem_paths = Vec::new();

    match format {
        AudioFormat::Wav => {
            paths.push(mix_wav.to_string_lossy().into_owned());
        }
        AudioFormat::Mp3 => {
            let mp3 = mix_wav.with_extension("mp3");
            encode_mp3(&mix_wav, &mp3)?;
            // Drop intermediate WAV when user asked for MP3 only.
            let _ = std::fs::remove_file(&mix_wav);
            paths.push(mp3.to_string_lossy().into_owned());
            notes.push("MP3 encoded with ffmpeg (libmp3lame 320k)".into());
        }
        AudioFormat::Both => {
            let mp3 = mix_wav.with_extension("mp3");
            encode_mp3(&mix_wav, &mp3)?;
            paths.push(mix_wav.to_string_lossy().into_owned());
            paths.push(mp3.to_string_lossy().into_owned());
            notes.push("WAV + MP3 (ffmpeg libmp3lame 320k)".into());
        }
    }

    if stems {
        if stem_patterns.len() <= 1 {
            notes.push(
                "Stems: only one layer found (use multiple `$:` tracks or a top-level stack(...) for multi-stem export)."
                    .into(),
            );
        } else {
            let stem_dir = stem_dir_for(&mix_wav);
            std::fs::create_dir_all(&stem_dir)
                .map_err(|e| format!("Could not create stems dir {}: {e}", stem_dir.display()))?;
            notes.push(format!(
                "Stems: split into {} layers → {}",
                stem_patterns.len(),
                stem_dir.display()
            ));

            for (i, (name, pattern)) in stem_patterns.iter().enumerate() {
                let safe = cycletron_core::text::slug::filename(name, "stem", None);
                let stem_wav = stem_dir.join(format!("{:02}-{safe}.wav", i + 1));
                clipped += render_pattern_to_wav(pattern, tempo, gain, duration_secs, &stem_wav)?;

                match format {
                    AudioFormat::Wav => {
                        stem_paths.push(stem_wav.to_string_lossy().into_owned());
                    }
                    AudioFormat::Mp3 => {
                        let stem_mp3 = stem_wav.with_extension("mp3");
                        encode_mp3(&stem_wav, &stem_mp3)?;
                        let _ = std::fs::remove_file(&stem_wav);
                        stem_paths.push(stem_mp3.to_string_lossy().into_owned());
                    }
                    AudioFormat::Both => {
                        let stem_mp3 = stem_wav.with_extension("mp3");
                        encode_mp3(&stem_wav, &stem_mp3)?;
                        stem_paths.push(stem_wav.to_string_lossy().into_owned());
                        stem_paths.push(stem_mp3.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    Ok(ExportAudioResult {
        paths,
        stem_paths,
        duration_secs,
        bpm: tempo,
        sample_rate: SAMPLE_RATE,
        clipped_samples: clipped,
        notes,
    })
}

/// Backward-compatible thin wrapper used by the original command.
pub fn export_wav(
    code: &str,
    path: impl AsRef<Path>,
    duration_secs: f64,
    bpm: Option<f64>,
    gain: Option<f32>,
) -> Result<ExportAudioResult, String> {
    export_audio(
        code,
        path,
        duration_secs,
        bpm,
        gain,
        AudioFormat::Wav,
        false,
    )
}

fn render_pattern_to_wav(
    pattern: &Pattern,
    tempo: f64,
    gain: f32,
    duration_secs: f64,
    path: &Path,
) -> Result<u64, String> {
    let mut renderer = OfflineRenderer::new(tempo, SAMPLE_RATE, gain);
    register_sample_manifests(&mut renderer);
    renderer.set_pattern(pattern.clone());

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create directory {}: {e}", parent.display()))?;
    }

    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("Could not create WAV '{}': {e}", path.display()))?;

    let mut clip_count: u64 = 0;
    renderer
        .render(duration_secs, |left, right| {
            for (&l, &r) in left.iter().zip(right.iter()) {
                let _ = writer.write_sample(sample_to_i16(l, &mut clip_count));
                let _ = writer.write_sample(sample_to_i16(r, &mut clip_count));
            }
        })
        .map_err(|e| format!("Render failed: {e}"))?;

    writer
        .finalize()
        .map_err(|e| format!("Could not finalize WAV '{}': {e}", path.display()))?;

    Ok(clip_count)
}

// ---------------------------------------------------------------------------
// Pattern / stem resolution
// ---------------------------------------------------------------------------

/// Resolve the mix and optional stem patterns from source code.
///
/// Stem split priority:
/// 1. Multiple `$:` tracks (named by id, comment, or index)
/// 2. Top-level `stack(a, b, …)` arguments
/// 3. Single layer (full mix)
fn resolve_patterns(
    code: &str,
    want_stems: bool,
) -> Result<(Vec<(String, Pattern)>, Option<Tempo>), String> {
    // Multi-track file path
    if let Ok(file) = parse_strudel_file(code)
        && !file.is_empty()
    {
        let mut tempo: Option<Tempo> = None;
        for directive in &file.directives {
            match directive {
                Directive::SetCpm(cpm) => tempo = Some(Tempo::from_cpm(*cpm)),
                Directive::SetBpm(bpm) => tempo = Some(Tempo::from_bpm(*bpm)),
            }
        }

        let mut context = EvalContext::new();
        for func in &file.functions {
            context.define_function(func.clone());
        }
        for binding in &file.bindings {
            // Binding parse-error offsets are relative to the binding text.
            let expr = parse_expr(binding.expr_str)
                .map_err(|e| format!("Parse error in binding '{}': {e}", binding.name))?;
            // Mirror evaluate_file: object literals become object bindings.
            if let Expr::Object {
                entries, spreads, ..
            } = &expr
            {
                let mut obj = FxHashMap::default();
                for spread in spreads {
                    if let Expr::Call { name, args, .. } = spread
                        && args.is_empty()
                    {
                        let Some(spread_obj) = context.get_object(name) else {
                            return Err(format!(
                                "Spread variable '{name}' not found or is not an object"
                            ));
                        };
                        for (key, value) in spread_obj {
                            obj.insert(key.clone(), value.clone());
                        }
                    } else {
                        return Err("Object spreads must be bare object identifiers".into());
                    }
                }
                for (key, value_expr) in entries {
                    let value_pattern = evaluate_in_context(value_expr, &context)
                        .map_err(|e| format!("Eval error in object field '{key}': {e}"))?;
                    obj.insert(key.clone(), value_pattern);
                }
                context.bind_object(binding.name, obj);
            } else {
                let pattern = evaluate_in_context(&expr, &context)
                    .map_err(|e| format!("Eval error in binding '{}': {e}", binding.name))?;
                context.bind(binding.name, pattern);
            }
        }

        let mut stems = Vec::new();
        for (i, track) in file.tracks.iter().enumerate() {
            let result = evaluate_in_context_with_tempo(&track.expression, &context)
                .map_err(|e| format!("Eval error in track {}: {e}", i + 1))?;
            if let Some(t) = result.tempo {
                tempo = Some(t);
            }
            let name = track_stem_name(track.id, track.comment, i);
            stems.push((name, result.pattern));
        }

        if stems.is_empty() {
            return Err("File contains no tracks".into());
        }

        // Single track: try to peel top-level stack for stem split.
        if want_stems && stems.len() == 1 {
            if let Some(split) = try_split_stack_expr(&file.tracks[0].expression, &context) {
                return Ok((split, tempo));
            }
        }

        return Ok((stems, tempo));
    }

    // Single expression / mini
    let evaluated = execute(code).map_err(|e| format!("Could not parse pattern: {e}"))?;

    if want_stems {
        if let Ok(expr) = parse_expr(code.trim())
            && let Some(split) = try_split_stack_expr(&expr, &EvalContext::new())
        {
            return Ok((split, evaluated.tempo));
        }
    }

    Ok((vec![("mix".into(), evaluated.pattern)], evaluated.tempo))
}

fn track_stem_name(id: &str, comment: Option<&str>, index: usize) -> String {
    if !id.is_empty() {
        return id.to_string();
    }
    if let Some(c) = comment {
        let cleaned = c
            .trim()
            .trim_start_matches('/')
            .trim()
            .trim_start_matches("Track")
            .trim_start_matches(char::is_numeric)
            .trim_start_matches([':', '-', ' '])
            .trim();
        if !cleaned.is_empty() {
            return cleaned.to_string();
        }
    }
    format!("stem-{}", index + 1)
}

/// If `expr` is `stack(a, b, …)`, evaluate each arg as its own stem.
fn try_split_stack_expr(expr: &Expr, ctx: &EvalContext<'_>) -> Option<Vec<(String, Pattern)>> {
    let Expr::Call { name, args, .. } = expr else {
        return None;
    };
    if *name != "stack" || args.len() < 2 {
        return None;
    }
    let mut out = Vec::with_capacity(args.len());
    for (i, arg) in args.iter().enumerate() {
        let pattern = evaluate_in_context(arg, ctx).ok()?;
        let label = stack_arg_label(arg, i);
        out.push((label, pattern));
    }
    Some(out)
}

fn stack_arg_label(expr: &Expr, index: usize) -> String {
    match expr {
        Expr::Call { name, .. } if !name.is_empty() => format!("{name}-{}", index + 1),
        Expr::MethodCall { method, .. } if !method.is_empty() => {
            format!("{method}-{}", index + 1)
        }
        _ => format!("layer-{}", index + 1),
    }
}

// ---------------------------------------------------------------------------
// MIDI export
// ---------------------------------------------------------------------------

/// Convert the current pattern to a Standard MIDI File.
pub fn export_midi(
    code: &str,
    path: impl AsRef<Path>,
    cycles: u32,
    bpm: Option<f64>,
) -> Result<ExportMidiResult, String> {
    let path = path.as_ref();
    if code.trim().is_empty() {
        return Err("Editor is empty — nothing to export.".into());
    }
    if cycles == 0 || cycles > 1024 {
        return Err(format!("Cycles must be between 1 and 1024 (got {cycles})"));
    }

    let evaluated = execute(code).map_err(|e| format!("Could not parse pattern: {e}"))?;
    let tempo = resolve_tempo(evaluated.tempo, bpm);

    let haps = evaluated.pattern.query_arc(0, cycles);
    let events = haps_to_midi_events(&haps, tempo, DEFAULT_MIDI_PPQ)?;
    if events.is_empty() {
        return Err(
            "No MIDI notes generated — pattern may be sample-only or empty over that range.".into(),
        );
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create directory {}: {e}", parent.display()))?;
    }

    let smf = build_midi_file(&events, tempo, DEFAULT_MIDI_PPQ)?;
    smf.save(path)
        .map_err(|e| format!("Could not save MIDI '{}': {e}", path.display()))?;

    tracing::info!(
        target: "cycletron::export",
        path = %path.display(),
        notes = events.len(),
        cycles,
        bpm = tempo,
        "MIDI export complete"
    );

    Ok(ExportMidiResult {
        path: path.to_string_lossy().into_owned(),
        cycles,
        bpm: tempo,
        note_count: events.len(),
    })
}

#[derive(Debug, Clone)]
struct MidiNoteEvent {
    onset_ticks: u32,
    duration_ticks: u32,
    note: u8,
    velocity: u8,
    channel: u8,
}

fn haps_to_midi_events(
    haps: &[Hap<Value>],
    _bpm: f64,
    ppq: u16,
) -> Result<Vec<MidiNoteEvent>, String> {
    let mut events = Vec::new();
    let ticks_per_cycle = u32::from(ppq) * 4;

    for hap in haps {
        if !hap.has_onset() || hap.value.is_rest() {
            continue;
        }

        let notes: Vec<u8> = match &hap.value {
            Value::String(s) => {
                if s.contains(',') {
                    s.split(',')
                        .filter_map(|n| value_to_midi_note(n.trim()))
                        .collect()
                } else {
                    match value_to_midi_note(s) {
                        Some(n) => vec![n],
                        None => continue,
                    }
                }
            }
            Value::Number(n) => {
                let note = *n as i32;
                if !(0..=127).contains(&note) {
                    continue;
                }
                vec![note as u8]
            }
            _ => continue,
        };

        if notes.is_empty() {
            continue;
        }

        let onset_ticks = (hap.part.begin.to_f64() * f64::from(ticks_per_cycle)) as u32;
        let duration_ticks = (hap.duration().to_f64() * f64::from(ticks_per_cycle)).max(1.0) as u32;

        let channel = if let Some(s) = hap.value.as_string() {
            if is_drum_sound(s) {
                DRUM_CHANNEL
            } else {
                MELODIC_CHANNEL
            }
        } else {
            MELODIC_CHANNEL
        };

        let velocity = extract_velocity(hap, DEFAULT_MIDI_VELOCITY);

        for note in notes {
            events.push(MidiNoteEvent {
                onset_ticks,
                duration_ticks,
                note,
                velocity,
                channel,
            });
        }
    }

    Ok(events)
}

fn extract_velocity(hap: &Hap<Value>, default: u8) -> u8 {
    if let Some(Value::Number(v)) = hap.context.get(&ContextKey::Velocity) {
        return (*v as u8).clamp(1, 127);
    }
    if let Some(Value::Number(gain)) = hap.context.get(&ContextKey::Gain) {
        return ((gain * 127.0) as u8).clamp(1, 127);
    }
    default
}

fn build_midi_file(events: &[MidiNoteEvent], bpm: f64, ppq: u16) -> Result<Smf<'static>, String> {
    let mut smf = Smf::new(Header {
        format: Format::SingleTrack,
        timing: Timing::Metrical(u15::new(ppq)),
    });

    let mut track: MidiTrack<'static> = Vec::new();

    let tempo_us = (60_000_000.0 / bpm) as u32;
    track.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(midly::MetaMessage::Tempo(u24::new(tempo_us))),
    });

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum EventType {
        NoteOn,
        NoteOff,
    }

    #[derive(Debug, Clone)]
    struct TimedEvent {
        time: u32,
        event_type: EventType,
        note: u8,
        velocity: u8,
        channel: u8,
    }

    let mut timed: Vec<TimedEvent> = Vec::new();
    for e in events {
        timed.push(TimedEvent {
            time: e.onset_ticks,
            event_type: EventType::NoteOn,
            note: e.note,
            velocity: e.velocity,
            channel: e.channel,
        });
        timed.push(TimedEvent {
            time: e.onset_ticks + e.duration_ticks,
            event_type: EventType::NoteOff,
            note: e.note,
            velocity: 0,
            channel: e.channel,
        });
    }

    timed.sort_by(|a, b| {
        a.time
            .cmp(&b.time)
            .then_with(|| match (&a.event_type, &b.event_type) {
                (EventType::NoteOff, EventType::NoteOn) => Ordering::Less,
                (EventType::NoteOn, EventType::NoteOff) => Ordering::Greater,
                _ => Ordering::Equal,
            })
    });

    let mut current_time = 0_u32;
    for event in timed {
        let delta = event.time.saturating_sub(current_time);
        current_time = event.time;
        let message = match event.event_type {
            EventType::NoteOn => MidiMessage::NoteOn {
                key: u7::new(event.note),
                vel: u7::new(event.velocity),
            },
            EventType::NoteOff => MidiMessage::NoteOff {
                key: u7::new(event.note),
                vel: u7::new(0),
            },
        };
        track.push(TrackEvent {
            delta: u28::new(delta),
            kind: TrackEventKind::Midi {
                channel: u4::new(event.channel),
                message,
            },
        });
    }

    track.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(midly::MetaMessage::EndOfTrack),
    });
    smf.tracks.push(track);
    Ok(smf)
}

fn drum_to_midi(name: &str) -> Option<u8> {
    match name.to_lowercase().as_str() {
        "bd" | "kick" | "bassdrum" => Some(36),
        "sd" | "snare" => Some(38),
        "rim" | "rimshot" | "rs" => Some(37),
        "hh" | "hihat" | "ch" | "closedhihat" => Some(42),
        "oh" | "openhihat" => Some(46),
        "ph" | "pedalhihat" => Some(44),
        "cr" | "crash" => Some(49),
        "rd" | "ride" => Some(51),
        "lt" | "lowtom" => Some(45),
        "mt" | "midtom" => Some(47),
        "ht" | "hightom" => Some(50),
        "cp" | "clap" => Some(39),
        "cb" | "cowbell" => Some(56),
        "tb" | "tambourine" => Some(54),
        "sh" | "shaker" => Some(70),
        _ => None,
    }
}

fn is_drum_sound(name: &str) -> bool {
    drum_to_midi(name).is_some()
}

fn value_to_midi_note(value: &str) -> Option<u8> {
    if let Some(note) = drum_to_midi(value) {
        return Some(note);
    }
    if let Ok(note) = value.parse::<MidiNoteNumber>().map(u8::from) {
        return Some(note);
    }
    value
        .parse::<u8>()
        .ok()
        .and_then(MidiNoteNumber::new_checked)
        .map(u8::from)
}

// ---------------------------------------------------------------------------
// MP3 via ffmpeg
// ---------------------------------------------------------------------------

fn encode_mp3(wav: &Path, mp3: &Path) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| {
        "MP3 export requires `ffmpeg` on PATH (with libmp3lame). Install via brew: `brew install ffmpeg`."
            .to_string()
    })?;

    let output = Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            &wav.to_string_lossy(),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "320k",
            &mp3.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg failed (exit {:?}): {}",
            output.status.code(),
            stderr.chars().take(400).collect::<String>()
        ));
    }
    if !mp3.is_file() {
        return Err(format!(
            "ffmpeg reported success but {} is missing",
            mp3.display()
        ));
    }
    Ok(())
}

fn find_ffmpeg() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FFMPEG_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    // Common install locations + PATH lookup via `which`-style.
    let candidates = [
        "ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    for c in candidates {
        let path = PathBuf::from(c);
        if path.is_file() {
            return Some(path);
        }
        // Bare name — let Command resolve via PATH by checking `command -v`.
        if c == "ffmpeg" {
            if let Ok(out) = Command::new("which").arg("ffmpeg").output()
                && out.status.success()
            {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(PathBuf::from(s));
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn validate_code_and_duration(code: &str, duration_secs: f64) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err("Editor is empty — nothing to export.".into());
    }
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return Err(format!(
            "Duration must be a positive number of seconds (got {duration_secs})"
        ));
    }
    if duration_secs > MAX_DURATION_SECS {
        return Err(format!(
            "Duration capped at {MAX_DURATION_SECS} seconds (10 minutes)."
        ));
    }
    Ok(())
}

fn resolve_tempo(file_tempo: Option<Tempo>, bpm: Option<f64>) -> f64 {
    file_tempo
        .map(|t| t.to_bpm())
        .or(bpm)
        .filter(|b| b.is_finite() && *b > 0.0)
        .unwrap_or(DEFAULT_BPM)
}

fn resolve_gain(gain: Option<f32>) -> f32 {
    gain.filter(|g| g.is_finite() && *g > 0.0)
        .unwrap_or(DEFAULT_GAIN)
        .clamp(0.01, 2.0)
}

fn ensure_wav_path(path: &Path) -> PathBuf {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("wav") || e.eq_ignore_ascii_case("mp3"))
    {
        path.with_extension("wav")
    } else {
        let mut p = path.to_path_buf();
        p.set_extension("wav");
        p
    }
}

fn stem_dir_for(mix_wav: &Path) -> PathBuf {
    let stem = mix_wav
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".into());
    mix_wav
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}-stems"))
}

fn register_sample_manifests(renderer: &mut OfflineRenderer) {
    let mut urls: Vec<String> = Vec::new();
    if let Some(local) = find_local_samples_manifest() {
        urls.push(local.to_string_lossy().into_owned());
    }
    urls.extend([
        default_sources::PIANO.to_string(),
        default_sources::UZU_DRUMKIT.to_string(),
        default_sources::UZU_WAVETABLES.to_string(),
        default_sources::DIRT_SAMPLES.to_string(),
    ]);

    for url in &urls {
        if let Err(e) = renderer.register_manifest_url(url) {
            tracing::warn!(
                target: "cycletron::export",
                url,
                error = %e,
                "sample manifest skipped"
            );
        }
    }
}

fn find_local_samples_manifest() -> Option<PathBuf> {
    if let Ok(env) = std::env::var("CYCLETRON_SAMPLES") {
        let p = PathBuf::from(env);
        if p.is_file() {
            return Some(p);
        }
        let joined = p.join("strudel.json");
        if joined.is_file() {
            return Some(joined);
        }
    }
    let candidates = [
        PathBuf::from("samples/strudel.json"),
        PathBuf::from("../strudel-rs/samples/strudel.json"),
        PathBuf::from("../../strudel-rs/samples/strudel.json"),
    ];
    candidates.into_iter().find(|c| c.is_file())
}

fn sample_to_i16(s: f32, clip_count: &mut u64) -> i16 {
    let clamped = if s > 1.0 {
        *clip_count += 1;
        1.0
    } else if s < -1.0 {
        *clip_count += 1;
        -1.0
    } else {
        s
    };
    (clamped * f32::from(i16::MAX)).round() as i16
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp(prefix: &str, ext: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("cycletron-{prefix}-{stamp}.{ext}"))
    }

    #[test]
    fn export_sine_phrase_writes_wav() {
        let path = tmp("export", "wav");
        let code = r#"note("c4 e4 g4 c5").s("sine").gain(0.5)"#;
        let result = export_wav(code, &path, 1.0, Some(120.0), Some(0.7)).expect("export");
        assert!(path.is_file());
        assert!(path.metadata().unwrap().len() > 1000);
        assert!((result.duration_secs - 1.0).abs() < f64::EPSILON);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_code_errors() {
        let err = export_wav("  ", "/tmp/nope.wav", 1.0, None, None).unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn stems_from_multi_track_file() {
        let path = tmp("stems", "wav");
        let code = r#"
setbpm(120)
// Kick
$: s("bd*4").gain(0.5)
// Hats
$: s("hh*8").gain(0.3)
"#;
        let result = export_audio(
            code,
            &path,
            0.5,
            Some(120.0),
            Some(0.7),
            AudioFormat::Wav,
            true,
        )
        .expect("stems export");
        assert_eq!(
            result.stem_paths.len(),
            2,
            "expected 2 stems, got {:?}",
            result.stem_paths
        );
        for p in &result.stem_paths {
            assert!(Path::new(p).is_file(), "missing stem {p}");
            let _ = std::fs::remove_file(p);
        }
        for p in &result.paths {
            let _ = std::fs::remove_file(p);
        }
        if let Some(parent) = Path::new(&result.stem_paths[0]).parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn stems_from_top_level_stack() {
        let path = tmp("stack-stems", "wav");
        let code = r#"stack(note("c4").s("sine").gain(0.4), note("e4").s("sine").gain(0.4))"#;
        let result = export_audio(
            code,
            &path,
            0.5,
            Some(120.0),
            Some(0.7),
            AudioFormat::Wav,
            true,
        )
        .expect("stack stems");
        assert!(
            result.stem_paths.len() >= 2,
            "expected stack stems, notes={:?}",
            result.notes
        );
        for p in result.stem_paths.iter().chain(result.paths.iter()) {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn export_midi_writes_file() {
        let path = tmp("midi", "mid");
        let code = r#"note("c4 e4 g4 c5")"#;
        let result = export_midi(code, &path, 2, Some(120.0)).expect("midi");
        assert!(path.is_file());
        assert!(result.note_count >= 4);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn export_midi_drums() {
        let path = tmp("drums", "mid");
        let code = r#"s("bd sd hh cp")"#;
        let result = export_midi(code, &path, 1, Some(120.0)).expect("drums midi");
        assert!(result.note_count >= 4);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn mp3_when_ffmpeg_available() {
        if find_ffmpeg().is_none() {
            eprintln!("skipping mp3 test: ffmpeg not on PATH");
            return;
        }
        let path = tmp("mp3", "wav");
        let code = r#"note("c4").s("sine").gain(0.5)"#;
        let result = export_audio(
            code,
            &path,
            0.5,
            Some(120.0),
            Some(0.7),
            AudioFormat::Mp3,
            false,
        )
        .expect("mp3");
        assert_eq!(result.paths.len(), 1);
        assert!(result.paths[0].ends_with(".mp3"));
        assert!(Path::new(&result.paths[0]).is_file());
        assert!(!path.is_file(), "intermediate wav should be removed");
        let _ = std::fs::remove_file(&result.paths[0]);
    }
}
