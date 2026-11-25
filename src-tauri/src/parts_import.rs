//! `cycletron parts`: cut MIDI files into parts for the Parts shelf.
//!
//! Each part is written to `<library>/Parts/<role>/<collection>/` with a
//! header saying where it came from and under what licence, so a part can be
//! checked before it goes anywhere else.

use cycletron_midi::parts::{ExtractedPart, PartOptions, Role, extract_parts};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::library_index::PARTS_DIR;
use cycletron_core::text::{frontmatter, slug::slugify as slug};

pub struct Flags {
    pub inputs: Vec<PathBuf>,
    /// Licence of the source files, e.g. `CC-BY-4.0` or `personal`.
    pub license: String,
    /// Folder name under each role. Defaults to the input's own name.
    pub collection: Option<String>,
    /// Library root to write into. Defaults to the app's library.
    pub out: Option<PathBuf>,
    /// Keep the played timing instead of snapping to 16ths.
    pub loose: bool,
    pub max_per_track: Option<usize>,
}

pub fn parse(args: &[String]) -> Result<Flags, String> {
    let mut flags = Flags {
        inputs: Vec::new(),
        license: String::new(),
        collection: None,
        out: None,
        loose: false,
        max_per_track: None,
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--license" => flags.license = it.next().ok_or("--license needs a value")?.clone(),
            "--collection" => {
                flags.collection = Some(slug(it.next().ok_or("--collection needs a name")?));
            }
            "--out" => flags.out = Some(it.next().ok_or("--out needs a folder")?.into()),
            "--loose" => flags.loose = true,
            "--max" => {
                flags.max_per_track = Some(
                    it.next()
                        .and_then(|v| v.parse().ok())
                        .filter(|n: &usize| *n > 0)
                        .ok_or("--max needs a positive whole number")?,
                );
            }
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}")),
            _ => flags.inputs.push(arg.into()),
        }
    }
    if flags.inputs.is_empty() {
        return Err("parts needs a MIDI file or folder".into());
    }
    if flags.license.trim().is_empty() {
        return Err(
            "parts needs --license (e.g. CC-BY-4.0, MIT, or personal for your own use)".into(),
        );
    }
    Ok(flags)
}

#[derive(Default)]
struct Summary {
    files: usize,
    unreadable: usize,
    written: usize,
    duplicate: usize,
    silent: usize,
}

pub fn run(flags: &Flags, library_root: &Path) -> Result<(), String> {
    let root = flags
        .out
        .clone()
        .unwrap_or_else(|| library_root.to_path_buf());
    let mut opts = PartOptions::default();
    if flags.loose {
        opts.import.cleanup.snap_per_bar = 0;
    }
    if let Some(max) = flags.max_per_track {
        opts.max_per_track = max;
    }

    let mut summary = Summary::default();
    let mut seen: HashSet<String> = HashSet::new();
    for input in &flags.inputs {
        let collection = flags
            .collection
            .clone()
            .unwrap_or_else(|| slug(&input.file_stem().unwrap_or_default().to_string_lossy()));
        let base = if input.is_dir() {
            input.as_path()
        } else {
            input.parent().unwrap_or(input)
        };
        let mut files = Vec::new();
        collect_midi(input, &mut files);
        files.sort();
        for file in files {
            summary.files += 1;
            let parts = match std::fs::read(&file)
                .map_err(|e| e.to_string())
                .and_then(|data| extract_parts(&data, &opts).map_err(|e| format!("{e:#}")))
            {
                Ok(parts) => parts,
                Err(e) => {
                    summary.unreadable += 1;
                    eprintln!("skip {}: {e}", file.display());
                    continue;
                }
            };
            let source = file
                .strip_prefix(base)
                .unwrap_or(&file)
                .to_string_lossy()
                .into_owned();
            let stem = file
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            for mut part in parts {
                // What the file says about itself outranks a guess from the notes.
                let named = part.track_name.as_deref().unwrap_or_default();
                if part.role == Role::Lead && (says_bass(&stem) || says_bass(named)) {
                    part.role = Role::Bass;
                }
                if part.role != Role::Drums {
                    part.key = named_key(&stem).or(part.key);
                }
                if !seen.insert(part.code.clone()) {
                    summary.duplicate += 1;
                    continue;
                }
                // Same gate as the curated corpus: it parses and it sounds.
                let sounds = cycletron_analysis::Evaluated::new(&part.code, part.bars)
                    .is_ok_and(|ev| ev.has_any_haps());
                if !sounds {
                    summary.silent += 1;
                    continue;
                }
                let dir = root
                    .join(PARTS_DIR)
                    .join(part.role.as_str())
                    .join(&collection);
                write_part(&dir, &stem, &source, &collection, &flags.license, &part)?;
                summary.written += 1;
            }
        }
    }

    println!(
        "{} MIDI file(s): {} part(s) written to {}",
        summary.files,
        summary.written,
        root.join(PARTS_DIR).display()
    );
    if summary.duplicate + summary.silent + summary.unreadable > 0 {
        println!(
            "skipped: {} duplicate, {} silent or invalid, {} unreadable file(s)",
            summary.duplicate, summary.silent, summary.unreadable
        );
    }
    Ok(())
}

fn collect_midi(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            collect_midi(&entry.path(), out);
        }
    } else if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mid") || e.eq_ignore_ascii_case("midi"))
    {
        out.push(path.to_path_buf());
    }
}

fn write_part(
    dir: &Path,
    stem: &str,
    source: &str,
    collection: &str,
    license: &str,
    part: &ExtractedPart,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    // "funk-112-take3" reads better spaced; "A - i VI III" is spaced already.
    let title = if stem.contains(' ') {
        stem.to_string()
    } else {
        stem.replace(['_', '-'], " ")
    };
    // What tells this part from the file's others: the track name, or the
    // sound it plays when the track has none. A drum file's track name
    // ("MIDI", "Drums") adds nothing, nor does one that repeats the file name.
    let pitched = part.role != Role::Drums;
    let label = match &part.track_name {
        Some(track) if stem.to_lowercase().contains(&track.to_lowercase()) => None,
        Some(track) => Some(track.clone()),
        None => sound_of(&part.code),
    }
    .filter(|_| pitched);
    let (name, base) = match label {
        Some(label) => (
            format!("{title} · {label}"),
            slug(&format!("{stem}-{label}-{}bar", part.bars)),
        ),
        None => (title, slug(&format!("{stem}-{}bar", part.bars))),
    };
    let mut path = dir.join(format!("{base}.strudel"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base}-{n}.strudel"));
        n += 1;
    }

    let role = part.role.as_str();
    let key = part
        .key
        .as_deref()
        .map(|k| format!("key: {}\n", quote(k)))
        .unwrap_or_default();
    let text = format!(
        "---\nname: {}\nbpm: {}\ntags: [part, {role}, {collection}]\nrole: {role}\nbars: {}\n{key}collection: {}\nsource: {}\nlicense: {}\n---\n{}\n",
        quote(&name),
        part.bpm,
        part.bars,
        quote(collection),
        quote(source),
        quote(license),
        part.code,
    );
    crate::files::write_text(&path, &text).map_err(|e| format!("write {}: {e}", path.display()))
}

/// A part saved in the library, with the header it was written with.
#[derive(Debug, serde::Serialize)]
pub struct SavedPart {
    pub path: String,
    pub name: String,
    /// The folder under `Parts/` the file sits in.
    pub role: String,
    pub bpm: Option<f64>,
    pub bars: Option<usize>,
    pub key: Option<String>,
    pub collection: Option<String>,
    pub license: Option<String>,
    /// Name the part had before it was reviewed: its source file and track.
    pub song: Option<String>,
    /// File the part was cut from, relative to what was imported.
    pub source: Option<String>,
    /// 1 to 5 from a review. Unreviewed parts have none.
    pub rating: Option<u8>,
    pub tags: Vec<String>,
    /// Parts with the same kit were written to play together.
    pub kit: Option<String>,
    pub code: String,
}

/// Every part under `<root>/Parts/<role>/`, bounded and deterministically sorted.
pub fn list_saved(root: &Path) -> Vec<SavedPart> {
    const MAX_PART_BYTES: u64 = 256 * 1024;
    let mut out = Vec::new();
    let Ok(roles) = std::fs::read_dir(root.join(PARTS_DIR)) else {
        return out;
    };
    let mut role_dirs: Vec<(String, PathBuf)> = roles
        .flatten()
        .filter_map(|e| {
            let ft = e.file_type().ok()?;
            if ft.is_symlink() || !ft.is_dir() {
                return None;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            Some((name, e.path()))
        })
        .collect();
    role_dirs.sort_by(|a, b| a.0.cmp(&b.0));

    for (role, role_path) in role_dirs {
        let mut files = Vec::new();
        collect_strudel(&role_path, 0, &mut files);
        files.sort();
        for path in files {
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.len() > MAX_PART_BYTES {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let (yaml, code) = frontmatter::split(&raw);
            let fm = yaml.map(frontmatter::parse).unwrap_or_default();
            out.push(SavedPart {
                name: fm.scalar("name").unwrap_or_else(|| {
                    path.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                }),
                role: role.clone(),
                bpm: fm.scalar("bpm").and_then(|v| v.parse().ok()),
                bars: fm.scalar("bars").and_then(|v| v.parse().ok()),
                key: fm.scalar("key"),
                collection: fm.scalar("collection"),
                license: fm.scalar("license"),
                song: fm.scalar("song"),
                source: fm.scalar("source"),
                kit: fm.scalar("kit"),
                rating: fm.scalar("rating").and_then(|v| v.parse().ok()),
                tags: fm.array("tags").unwrap_or_default(),
                code: code.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    out
}

fn collect_strudel(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    const MAX_DEPTH: usize = 16;
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            collect_strudel(&path, depth + 1, out);
        } else if ft.is_file() && path.extension().is_some_and(|e| e == "strudel") {
            out.push(path);
        }
    }
}

/// The sound a part plays, as words: `gm_slap_bass_2` gives "slap bass 2".
fn sound_of(code: &str) -> Option<String> {
    let name = code.split_once(".sound(\"")?.1.split_once('"')?.0;
    Some(name.trim_start_matches("gm_").replace('_', " "))
}

/// True when a file or track name calls the part a bass ("Synth Bass 1", "contrabass").
fn says_bass(name: &str) -> bool {
    name.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| word == "bass" || word == "contrabass")
}

/// The key a file name states: "… A minor …", or a chord pack's
/// "Bb - i VII III VI - …", where the case of the tonic chord gives the mode.
fn named_key(stem: &str) -> Option<String> {
    let words: Vec<&str> = stem.split_whitespace().collect();
    for pair in words.windows(2) {
        let mode = pair[1].to_lowercase();
        if let Some(root) = root_of(pair[0]).filter(|_| mode == "minor" || mode == "major") {
            return Some(format!("{root}:{mode}"));
        }
    }
    let root = root_of(words.first()?)?;
    if words.get(1) != Some(&"-") {
        return None;
    }
    words[2..]
        .iter()
        .take_while(|w| **w != "-")
        .find_map(|chord| {
            let numeral: String = chord
                .trim_start_matches(['b', '#'])
                .chars()
                .take_while(|c| "ivIV".contains(*c))
                .collect();
            match numeral.as_str() {
                "i" => Some("minor"),
                "I" => Some("major"),
                _ => None,
            }
        })
        .map(|mode| format!("{root}:{mode}"))
}

/// A note name as the root of a key, flats spelled as sharps like the converter's.
fn root_of(word: &str) -> Option<&'static str> {
    const ROOTS: [(&str, &str); 17] = [
        ("C", "C"),
        ("C#", "C#"),
        ("Db", "C#"),
        ("D", "D"),
        ("D#", "D#"),
        ("Eb", "D#"),
        ("E", "E"),
        ("F", "F"),
        ("F#", "F#"),
        ("Gb", "F#"),
        ("G", "G"),
        ("G#", "G#"),
        ("Ab", "G#"),
        ("A", "A"),
        ("A#", "A#"),
        ("Bb", "A#"),
        ("B", "B"),
    ];
    ROOTS
        .iter()
        .find(|(name, _)| *name == word)
        .map(|(_, root)| *root)
}

pub(crate) fn quote(s: &str) -> String {
    let clean: String = s
        .chars()
        .map(|c| match c {
            '\\' => '/',
            '"' => '\'',
            '\r' | '\n' => ' ',
            _ => c,
        })
        .collect();
    format!("\"{clean}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_licence_is_required() {
        assert!(parse(&args(&["song.mid"])).is_err());
        let flags = parse(&args(&[
            "song.mid",
            "--license",
            "CC-BY-4.0",
            "--collection",
            "Groove MIDI",
        ]))
        .unwrap();
        assert_eq!(flags.license, "CC-BY-4.0");
        assert_eq!(flags.collection.as_deref(), Some("groove-midi"));
    }

    #[test]
    fn a_file_name_gives_the_key_and_the_role() {
        assert_eq!(
            named_key("HPR Bass Riff - 001 - 124 BPM - A minor").as_deref(),
            Some("A:minor")
        );
        assert_eq!(
            named_key("Bb - i VII III VI - Rebellious").as_deref(),
            Some("A#:minor")
        );
        assert_eq!(
            named_key("C - VII iv v i - Dark").as_deref(),
            Some("C:minor")
        );
        assert_eq!(
            named_key("A - bIIIM ii bIIM I - Surprised").as_deref(),
            Some("A:major")
        );
        assert_eq!(named_key("funk-112-take3"), None);
        assert!(says_bass("Synth Bass 1") && says_bass("f-contrabass"));
        assert!(!says_bass("Synth Brass 1"));
    }

    #[test]
    fn a_part_is_named_after_its_sound() {
        let code = r#"note("c2 e2").sound("gm_slap_bass_2").gain(0.7)"#;
        assert_eq!(sound_of(code).as_deref(), Some("slap bass 2"));
        assert_eq!(sound_of(r#"s("bd sd")"#), None);
    }

    #[test]
    fn a_saved_part_lists_with_its_header() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Parts/drums/groove-midi");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(tmp.path().join("Parts/bass")).unwrap();
        std::fs::write(
            dir.join("funk.strudel"),
            "---\nname: \"Funk 1\"\nbpm: 96\nrole: drums\nbars: 2\ncollection: \"groove-midi\"\nkit: \"Funk in E\"\nlicense: \"CC-BY-4.0\"\n---\ns(\"bd sd\")\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("Parts/bass/mine.strudel"),
            "// mine\nnote(\"c2\")\n",
        )
        .unwrap();

        let mut parts = list_saved(tmp.path());
        parts.sort_by(|a, b| a.role.cmp(&b.role));
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1].kit.as_deref(), Some("Funk in E"));
        assert_eq!(parts[0].kit, None);
        assert_eq!(
            (parts[0].role.as_str(), parts[0].name.as_str()),
            ("bass", "mine")
        );
        assert_eq!(parts[0].license, None);
        let funk = &parts[1];
        assert_eq!(
            (funk.name.as_str(), funk.bpm, funk.bars),
            ("Funk 1", Some(96.0), Some(2))
        );
        assert_eq!(funk.collection.as_deref(), Some("groove-midi"));
        assert_eq!(funk.license.as_deref(), Some("CC-BY-4.0"));
        assert_eq!(funk.code, "s(\"bd sd\")\n");
    }
}
