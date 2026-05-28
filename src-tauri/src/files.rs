//! File IO for `.strudel` / `.js` pattern files and recent-files tracking.
//!
//! `.strudel` files may carry an optional YAML-like frontmatter block
//! (delimited by `---`) used to record tempo, tags, and author. Plain
//! `.js` patterns are read verbatim.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Parsed contents of a pattern file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDoc {
    pub path: PathBuf,
    pub code: String,
    pub frontmatter: Option<Frontmatter>,
}

/// A minimal subset of frontmatter fields we recognize. Unknown keys are
/// preserved verbatim when round-tripping.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub bpm: Option<f64>,
    pub tags: Vec<String>,
    pub created: Option<String>,
}

pub fn read_file(path: &Path) -> std::io::Result<FileDoc> {
    let raw = fs::read_to_string(path)?;
    let (frontmatter, code) = split_frontmatter(&raw);
    Ok(FileDoc {
        path: path.to_path_buf(),
        code,
        frontmatter,
    })
}

pub fn write_file(path: &Path, code: &str, bpm: Option<f64>) -> std::io::Result<()> {
    let body = format_with_frontmatter(code, bpm);
    // Atomic-ish write: write to sibling temp then rename.
    let tmp = tmp_path(path);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    p.set_file_name(format!(".{name}.tmp"));
    p
}

fn format_with_frontmatter(code: &str, bpm: Option<f64>) -> String {
    let bpm_line = bpm.map(|v| format!("bpm: {v}\n")).unwrap_or_default();
    format!(
        "---\nname: \"Robostrudel Session\"\n{bpm_line}created: {}\ntags: [robostrudel]\n---\n{code}",
        Utc::now().format("%Y-%m-%d"),
    )
}

/// Splits a file body into optional frontmatter + code.
/// Accepts `---\n...\n---\n` at the very start; otherwise returns (None, raw).
fn split_frontmatter(raw: &str) -> (Option<Frontmatter>, String) {
    let trimmed_start = raw.trim_start_matches('\u{feff}');
    if !trimmed_start.starts_with("---") {
        return (None, raw.to_string());
    }
    // Find the closing `---` on its own line.
    let after_first = match trimmed_start.find('\n') {
        Some(i) => &trimmed_start[i + 1..],
        None => return (None, raw.to_string()),
    };
    let end = match find_line(after_first, "---") {
        Some(i) => i,
        None => return (None, raw.to_string()),
    };
    let yaml = &after_first[..end];
    let rest = &after_first[end..];
    // Skip the closing `---` line
    let code_start = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
    let code = rest[code_start..].to_string();

    (Some(parse_frontmatter(yaml)), code)
}

fn find_line(s: &str, needle: &str) -> Option<usize> {
    let mut offset = 0;
    for line in s.split_inclusive('\n') {
        let l = line.trim_end_matches('\n').trim_end_matches('\r');
        if l == needle {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

/// Parses a very small subset of YAML: `key: value` lines. Supports `bpm`
/// as number, `name` as (optionally quoted) string, and `tags` as either
/// an inline array `[a, b]` or a block list of `- item` lines.
fn parse_frontmatter(yaml: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let mut lines = yaml.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once(':') else {
            continue;
        };
        let key = k.trim();
        let val = v.trim();
        match key {
            "name" => fm.name = Some(strip_quotes(val).to_string()),
            "created" => fm.created = Some(strip_quotes(val).to_string()),
            "bpm" => {
                if let Ok(n) = val.parse::<f64>() {
                    fm.bpm = Some(n);
                }
            }
            "tags" => {
                if val.starts_with('[') && val.ends_with(']') {
                    fm.tags = val[1..val.len() - 1]
                        .split(',')
                        .map(|s| strip_quotes(s.trim()).to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                } else if val.is_empty() {
                    while let Some(next) = lines.peek() {
                        let t = next.trim();
                        if let Some(item) = t.strip_prefix("- ") {
                            fm.tags.push(strip_quotes(item.trim()).to_string());
                            lines.next();
                        } else {
                            break;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    fm
}

fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------

const DEFAULT_RECENTS_MAX: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Recents {
    pub entries: Vec<PathBuf>,
    #[serde(default = "default_recents_max")]
    pub max: usize,
}

fn default_recents_max() -> usize {
    DEFAULT_RECENTS_MAX
}

impl Recents {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            max: DEFAULT_RECENTS_MAX,
        }
    }

    /// Move `path` to the front, dedupe, cap at `max`.
    pub fn push(&mut self, path: PathBuf) {
        self.entries.retain(|p| p != &path);
        self.entries.insert(0, path);
        if self.entries.len() > self.max {
            self.entries.truncate(self.max);
        }
    }

    pub fn load(dir: &Path) -> Self {
        let file = dir.join("recents.json");
        if let Ok(s) = fs::read_to_string(&file)
            && let Ok(r) = serde_json::from_str::<Self>(&s)
        {
            return r;
        }
        Self::new()
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dir)?;
        let file = dir.join("recents.json");
        let s = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(file, s)
    }

    /// Drop entries whose path no longer exists on disk.
    pub fn prune_missing(&mut self) {
        self.entries.retain(|p| p.exists());
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_with_frontmatter() {
        let tmp = std::env::temp_dir().join("robostrudel_test.strudel");
        let code = "note(\"c4 e4 g4\").s(\"sine\")\n";
        write_file(&tmp, code, Some(120.0)).unwrap();
        let doc = read_file(&tmp).unwrap();
        assert_eq!(doc.code.trim(), code.trim());
        let fm = doc.frontmatter.unwrap();
        assert_eq!(fm.bpm, Some(120.0));
        assert!(fm.tags.contains(&"robostrudel".to_string()));
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn read_plain_js_file() {
        let tmp = std::env::temp_dir().join("robostrudel_plain.js");
        let code = "stack(note(\"c4\"), s(\"bd\"))\n";
        fs::write(&tmp, code).unwrap();
        let doc = read_file(&tmp).unwrap();
        assert!(doc.frontmatter.is_none());
        assert_eq!(doc.code, code);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn recents_push_dedupes_and_caps() {
        let mut r = Recents {
            entries: vec![],
            max: 3,
        };
        r.push(PathBuf::from("/a"));
        r.push(PathBuf::from("/b"));
        r.push(PathBuf::from("/a")); // dedup → moves /a to front
        r.push(PathBuf::from("/c"));
        r.push(PathBuf::from("/d"));
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[0], PathBuf::from("/d"));
        assert_eq!(r.entries[2], PathBuf::from("/a"));
    }
}
