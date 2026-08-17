//! Hap ingest: JS-strudel → hap IR → cycletron-gen [`Mini`] → strudel-rs.
//!
//! The bakery files are web-strudel JS. Instead of rewriting that source, we
//! evaluate it with the JS engine (`eval.mjs`), treat the discrete haps as an
//! IR, and lower each voice onto a [`Mini`] tree (the same AST the generators
//! emit). `factor::compress` then folds repeated bars. The result is a
//! strudel-rs document that `validate_doc` will accept.
//!
//!     cargo run -p hap-ingest -- corpus/_examples/featured/piano-phase--….strudel
//!     cargo run -p hap-ingest -- --dir corpus/_examples/featured --limit 12

use anyhow::{Context, Result, bail};
use cycletron_gen::{mini::Mini, verify};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const DRUMS: &[&str] = &[
    "bd",
    "sd",
    "hh",
    "oh",
    "cp",
    "rim",
    "rd",
    "lt",
    "mt",
    "ht",
    "cr",
    "cb",
    "rs",
    "sh",
    "tambourine",
    "cowbell",
    "tb",
];
const SYNTHS: &[&str] = &[
    "sine",
    "sawtooth",
    "triangle",
    "square",
    "supersaw",
    "supersquare",
    "superpwm",
    "pulse",
    "fm",
    "white",
    "pink",
    "brown",
    "noise",
];

#[derive(Deserialize)]
struct HapDump {
    hap_count: usize,
    haps: Vec<Hap>,
}

#[derive(Deserialize, Clone)]
struct Hap {
    part: [f64; 2],
    value: BTreeMap<String, serde_json::Value>,
}

struct Args {
    inputs: Vec<PathBuf>,
    out: PathBuf,
    cycles: u32,
    steps: u32,
    #[allow(dead_code)]
    limit: usize,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("hap-ingest: {e:#}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    if args.inputs.is_empty() {
        bail!("no input .strudel files");
    }
    std::fs::create_dir_all(&args.out)?;

    let eval_js = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("eval.mjs");
    let mut ok = 0usize;
    let mut fail = 0usize;

    for path in &args.inputs {
        match convert_one(path, &eval_js, &args) {
            Ok(n) => {
                ok += 1;
                println!("ok  {} → {n} voice(s)", path.display());
            }
            Err(e) => {
                fail += 1;
                println!("err {} — {e}", path.display());
            }
        }
    }
    println!("hap-ingest: {ok} ok, {fail} fail");
    Ok(())
}

fn convert_one(path: &Path, eval_js: &Path, args: &Args) -> Result<usize> {
    let dump = eval_js_file(eval_js, path, args.cycles)?;
    if dump.haps.is_empty() {
        bail!("no discrete haps in {} cycles", args.cycles);
    }

    let voices = group_voices(&dump.haps);
    if voices.is_empty() {
        bail!("{} haps but no extractable voices", dump.hap_count);
    }

    let stem = sanitize(
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("pattern"),
    );
    let bpm = infer_bpm(&std::fs::read_to_string(path).unwrap_or_default()).unwrap_or(120);

    let mut written = 0usize;
    let mut stacked: Vec<String> = Vec::new();

    for (key, haps) in &voices {
        let bars = voice_to_bars(haps, args.cycles, args.steps);
        if bars.iter().all(bar_is_rest) {
            continue;
        }
        let body = wrap_voice(key, &bars);
        let doc = format!(
            "// extracted from {}\n// voice {key} · {n} cycles · {steps}-step grid\nsetbpm({bpm});\n\n{body}\n",
            path.display(),
            key = key,
            n = bars.len(),
            steps = args.steps,
            bpm = bpm,
            body = body,
        );
        if verify::validate_doc(&doc).is_ok() {
            let out = args.out.join(format!("{stem}__{}.strudel", sanitize(key)));
            std::fs::write(&out, doc)?;
            written += 1;
            stacked.push(body);
        }
    }

    if stacked.len() >= 2 {
        let tracks = stacked
            .iter()
            .map(|b| format!("$: {b}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let doc = format!(
            "// extracted from {} (stacked voices)\nsetbpm({bpm});\n\n{tracks}\n",
            path.display(),
        );
        if verify::validate_doc(&doc).is_ok() {
            let out = args.out.join(format!("{stem}__stack.strudel"));
            std::fs::write(out, doc)?;
            written += 1;
        }
    }

    if written == 0 {
        bail!("voices produced no validating documents");
    }
    Ok(written)
}

fn eval_js_file(eval_js: &Path, src: &Path, cycles: u32) -> Result<HapDump> {
    let out = Command::new("node")
        .arg(eval_js)
        .arg("--file")
        .arg(src)
        .arg("--cycles")
        .arg(cycles.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("spawn node eval.mjs")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("js eval: {}", err.trim());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let json = stdout
        .find('{')
        .map(|i| &stdout[i..])
        .ok_or_else(|| anyhow::anyhow!("js eval produced no JSON"))?;
    serde_json::from_str(json).context("parse hap JSON")
}

fn group_voices(haps: &[Hap]) -> BTreeMap<String, Vec<Hap>> {
    let mut out: BTreeMap<String, Vec<Hap>> = BTreeMap::new();
    for h in haps {
        let s = string_field(&h.value, "s");
        let has_pitch = h.value.contains_key("note") || h.value.contains_key("n");
        let key = if let Some(s) = s.as_deref() {
            if is_drum(s) {
                format!("drum:{}", drum_alias(s))
            } else {
                format!("tone:{}", synth_alias(s))
            }
        } else if has_pitch {
            "tone:sine".into()
        } else {
            continue;
        };
        out.entry(key).or_default().push(h.clone());
    }
    // Split overlapping notes of the same voice onto parallel lanes
    // (piano-phase, stacked synths) so we don't flatten them to chords.
    let mut split: BTreeMap<String, Vec<Hap>> = BTreeMap::new();
    for (key, mut haps) in out {
        haps.sort_by(|a, b| a.part[0].total_cmp(&b.part[0]));
        let mut lanes: Vec<f64> = Vec::new();
        for h in haps {
            let start = h.part[0];
            let end = h.part[1].max(start + 0.01);
            let lane = lanes
                .iter()
                .position(|&busy| start >= busy - 1e-6)
                .unwrap_or_else(|| {
                    if lanes.len() >= 2 {
                        // Keep the two busiest lanes; extra overlaps stay on lane 0
                        // as a chord rather than exploding into 10 files.
                        0
                    } else {
                        lanes.push(0.0);
                        lanes.len() - 1
                    }
                });
            lanes[lane] = end;
            let name = if lane == 0 {
                key.clone()
            } else {
                format!("{key}-{lane}")
            };
            split.entry(name).or_default().push(h);
        }
    }
    split
}

fn synth_alias(s: &str) -> String {
    match s.to_ascii_lowercase().as_str() {
        "piano" => "gm_piano".into(),
        other => other.to_string(),
    }
}

fn voice_to_bars(haps: &[Hap], cycles: u32, steps: u32) -> Vec<Mini> {
    let mut bars: Vec<Mini> = Vec::with_capacity(cycles as usize);
    for c in 0..cycles {
        let begin = f64::from(c);
        let end = begin + 1.0;
        let mut slots: Vec<Vec<String>> = vec![Vec::new(); steps as usize];
        for h in haps {
            let t = h.part[0];
            if t < begin || t >= end {
                continue;
            }
            let frac = ((t - begin) * f64::from(steps)).round() as i32;
            let slot = frac.clamp(0, steps as i32 - 1) as usize;
            if let Some(tok) = hap_token(h)
                && !slots[slot].contains(&tok)
            {
                slots[slot].push(tok);
            }
        }
        let items: Vec<Mini> = slots
            .into_iter()
            .map(|cell| match cell.len() {
                0 => Mini::Rest,
                1 => Mini::atom(cell.into_iter().next().unwrap()),
                _ => Mini::Stack(cell.into_iter().map(Mini::atom).collect()),
            })
            .collect();
        bars.push(Mini::Seq(items));
    }
    while bars.len() > 8 && bars.last().is_some_and(bar_is_rest) {
        bars.pop();
    }
    bars
}

fn bar_is_rest(bar: &Mini) -> bool {
    match bar {
        Mini::Rest => true,
        Mini::Seq(xs) | Mini::Alt(xs) | Mini::Stack(xs) => xs.iter().all(bar_is_rest),
        Mini::Group(inner)
        | Mini::Fast(inner, _)
        | Mini::Slow(inner, _)
        | Mini::Replicate(inner, _) => bar_is_rest(inner),
        Mini::Euclid { base, .. } => bar_is_rest(base),
        Mini::Atom(_) => false,
    }
}

fn wrap_voice(key: &str, bars: &[Mini]) -> String {
    let inner = bars
        .iter()
        .map(cycletron_gen::mini::Mini::emit)
        .collect::<Vec<_>>()
        .join("\n  ");
    if key.starts_with("drum:") {
        format!("s(`<\n  {inner}\n>`).gain(0.8)")
    } else {
        let synth = key
            .strip_prefix("tone:")
            .unwrap_or("sine")
            .split('-')
            .next()
            .unwrap_or("sine");
        let synth = if SYNTHS.contains(&synth) || synth.starts_with("gm_") {
            synth
        } else {
            "sine"
        };
        format!("note(`<\n  {inner}\n>`).s(\"{synth}\").gain(0.45)")
    }
}

fn hap_token(h: &Hap) -> Option<String> {
    let s = string_field(&h.value, "s");
    if let Some(s) = s.as_deref()
        && is_drum(s)
    {
        return Some(drum_alias(s));
    }
    if let Some(n) = number_field(&h.value, "note") {
        return Some(midi_to_name(n));
    }
    if let Some(name) = string_field(&h.value, "note") {
        return Some(name.to_ascii_lowercase());
    }
    if let Some(n) = number_field(&h.value, "n") {
        // scale degree left as a number — caller wraps in note()
        if n.fract() == 0.0 && (0.0..128.0).contains(&n) && n >= 12.0 {
            return Some(midi_to_name(n));
        }
        return Some(format!("{}", n as i32));
    }
    None
}

fn is_drum(s: &str) -> bool {
    let base = s.split([':', '_']).next().unwrap_or(s).to_ascii_lowercase();
    DRUMS.contains(&base.as_str())
        || s.to_ascii_lowercase().contains("_bd")
        || s.to_ascii_lowercase().contains("_sd")
        || s.to_ascii_lowercase().contains("_hh")
}

fn drum_alias(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    for d in DRUMS {
        if lower == *d || lower.ends_with(&format!("_{d}")) || lower.ends_with(&format!(":{d}")) {
            return (*d).to_string();
        }
    }
    if lower.contains("clap") {
        return "cp".into();
    }
    "bd".into()
}

fn midi_to_name(n: f64) -> String {
    const PC: [&str; 12] = [
        "c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b",
    ];
    let midi = n.round() as i32;
    let pc = midi.rem_euclid(12) as usize;
    let oct = midi.div_euclid(12) - 1;
    format!("{}{oct}", PC[pc])
}

fn string_field(v: &BTreeMap<String, serde_json::Value>, k: &str) -> Option<String> {
    match v.get(k)? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn number_field(v: &BTreeMap<String, serde_json::Value>, k: &str) -> Option<f64> {
    match v.get(k)? {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn infer_bpm(src: &str) -> Option<u32> {
    for line in src.lines() {
        let t = line.trim();
        if let Some(n) = parse_call(t, "setbpm") {
            return Some(n.round() as u32);
        }
        if let Some(n) = parse_call(t, "setcpm") {
            return Some((n * 4.0).round() as u32);
        }
        if let Some(n) = parse_call(t, "setcps") {
            return Some((n * 240.0).round() as u32);
        }
        if let Some(n) = parse_call(t, "setCps") {
            return Some((n * 240.0).round() as u32);
        }
    }
    None
}

fn parse_call(line: &str, name: &str) -> Option<f64> {
    let rest = line.strip_prefix(name)?.trim_start().strip_prefix('(')?;
    let end = rest.find(')')?;
    let expr = rest[..end].trim();
    // setcps(172/4/60) etc.
    let mut acc = 1.0f64;
    let mut first = true;
    for part in expr.split('/') {
        let v: f64 = part.trim().parse().ok()?;
        if first {
            acc = v;
            first = false;
        } else if v != 0.0 {
            acc /= v;
        }
    }
    Some(acc)
}

fn sanitize(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let t = out.trim_matches('-');
    if t.is_empty() {
        "voice".into()
    } else {
        t.to_ascii_lowercase()
    }
}

fn parse_args() -> Result<Args> {
    let mut argv = std::env::args().skip(1);
    let mut inputs = Vec::new();
    let mut dir: Option<PathBuf> = None;
    let mut out = PathBuf::from("corpus/_examples/extracted");
    let mut cycles = 32u32;
    let mut steps = 16u32;
    let mut limit = 0usize;
    while let Some(a) = argv.next() {
        match a.as_str() {
            "--dir" => dir = Some(PathBuf::from(argv.next().context("--dir needs a path")?)),
            "--out" => out = PathBuf::from(argv.next().context("--out needs a path")?),
            "--cycles" => cycles = argv.next().context("--cycles")?.parse()?,
            "--steps" => steps = argv.next().context("--steps")?.parse()?,
            "--limit" => limit = argv.next().context("--limit")?.parse()?,
            "-h" | "--help" => {
                eprintln!(
                    "hap-ingest <file.strudel>… [--dir DIR] [--out DIR] [--cycles N] [--steps N] [--limit N]"
                );
                std::process::exit(0);
            }
            other if other.starts_with('-') => bail!("unknown flag {other}"),
            other => inputs.push(PathBuf::from(other)),
        }
    }
    if let Some(d) = dir {
        let mut files: Vec<PathBuf> = walk(&d);
        files.sort();
        if limit > 0 {
            files.truncate(limit);
        }
        inputs.extend(files);
    }
    Ok(Args {
        inputs,
        out,
        cycles,
        steps,
        limit,
    })
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else if p.extension().and_then(|s| s.to_str()) == Some("strudel") {
            out.push(p);
        }
    }
    out
}
