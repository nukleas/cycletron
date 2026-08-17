//! Small text primitives shared across the workspace: frontmatter
//! splitting/parsing for `.strudel`/recipe files, tempo-directive scanning,
//! and filename slugs. One implementation each — the app, the corpus loader,
//! and the CLI tools all agree on these rules.

/// `---`-fenced YAML-subset frontmatter at the start of a file.
pub mod frontmatter {
    use std::collections::HashMap;

    /// Parsed frontmatter: `key: scalar`, `key: [a, b]`, and block arrays
    /// (`key:` followed by indented `- item` lines).
    #[derive(Debug, Default)]
    pub struct Frontmatter {
        pub scalars: HashMap<String, String>,
        pub arrays: HashMap<String, Vec<String>>,
    }

    impl Frontmatter {
        pub fn scalar(&self, key: &str) -> Option<String> {
            self.scalars.get(key).cloned()
        }
        pub fn array(&self, key: &str) -> Option<Vec<String>> {
            self.arrays.get(key).cloned()
        }
    }

    /// Split a leading `---`-fenced frontmatter block from the body.
    ///
    /// Tolerates a BOM and leading whitespace before the opening fence; the
    /// closing fence is the next line starting with `---` (CRLF tolerant).
    /// Returns `(None, text)` unchanged when there is no complete block.
    pub fn split(text: &str) -> (Option<&str>, &str) {
        let t = text.trim_start_matches(['\u{feff}', ' ', '\n', '\r', '\t']);
        let Some(rest) = t.strip_prefix("---") else {
            return (None, text);
        };
        let Some(nl) = rest.find('\n') else {
            return (None, text);
        };
        let after = &rest[nl + 1..];
        let mut offset = 0;
        for line in after.split_inclusive('\n') {
            let stripped = line.trim_end_matches('\n').trim_end_matches('\r');
            if stripped.starts_with("---") {
                let yaml = after[..offset].trim_matches(['\n', '\r']);
                let body = &after[offset + line.len()..];
                return (Some(yaml), body);
            }
            offset += line.len();
        }
        (None, text)
    }

    /// Parse the YAML subset used by recipes and pattern files.
    pub fn parse(yaml: &str) -> Frontmatter {
        let mut fm = Frontmatter::default();
        let lines: Vec<&str> = yaml.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            let trimmed = lines[i].trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                i += 1;
                continue;
            }
            if let Some((key, value)) = trimmed.split_once(':') {
                let key = key.trim().to_string();
                let value = value.trim();
                if value.is_empty() {
                    // Possibly a block array on following indented `- ` lines.
                    let mut items = Vec::new();
                    let mut j = i + 1;
                    while j < lines.len() {
                        let t = lines[j].trim();
                        if let Some(item) = t.strip_prefix("- ") {
                            items.push(unquote(item.trim()).to_string());
                            j += 1;
                        } else if t.is_empty() {
                            j += 1;
                        } else {
                            break;
                        }
                    }
                    if items.is_empty() {
                        fm.scalars.insert(key, String::new());
                    } else {
                        fm.arrays.insert(key, items);
                    }
                    i = j;
                    continue;
                } else if value.starts_with('[') && value.ends_with(']') {
                    let inner = &value[1..value.len() - 1];
                    fm.arrays.insert(key, split_inline_array(inner));
                } else {
                    fm.scalars.insert(key, unquote(value).to_string());
                }
            }
            i += 1;
        }
        fm
    }

    /// Split an inline-array body on commas, respecting quoted strings.
    fn split_inline_array(inner: &str) -> Vec<String> {
        let mut items = Vec::new();
        let mut buf = String::new();
        let mut quote: Option<char> = None;
        for c in inner.chars() {
            match quote {
                Some(q) => {
                    if c == q {
                        quote = None;
                    } else {
                        buf.push(c);
                    }
                }
                None => match c {
                    '"' | '\'' => quote = Some(c),
                    ',' => {
                        let t = buf.trim().to_string();
                        if !t.is_empty() {
                            items.push(t);
                        }
                        buf.clear();
                    }
                    _ => buf.push(c),
                },
            }
        }
        let t = buf.trim().to_string();
        if !t.is_empty() {
            items.push(t);
        }
        items
    }

    fn unquote(s: &str) -> &str {
        let s = s.trim();
        if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
            || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
        {
            &s[1..s.len() - 1]
        } else {
            s
        }
    }
}

/// Tempo-directive scanning over strudel source.
pub mod tempo {
    /// BPM from the first `setbpm(...)`, `setcpm(...)`, or `setcps(...)`
    /// directive, converted to BPM at 4 beats/cycle. `//` comment lines are
    /// skipped.
    pub fn scan_bpm(code: &str) -> Option<f64> {
        for line in code.lines() {
            let line = line.trim_start();
            if line.starts_with("//") {
                continue;
            }
            for (prefix, mul) in [("setbpm(", 1.0), ("setcpm(", 4.0), ("setcps(", 240.0)] {
                if let Some(i) = line.find(prefix) {
                    let rest = &line[i + prefix.len()..];
                    if let Some(end) = rest.find(')')
                        && let Ok(v) = rest[..end].trim().parse::<f64>()
                    {
                        return Some(v * mul);
                    }
                }
            }
        }
        None
    }
}

/// Filename slugs.
pub mod slug {
    /// Filesystem-safe name: `[A-Za-z0-9_-]` kept, everything else becomes
    /// `-`, edge dashes trimmed, optionally capped, `fallback` when empty.
    pub fn filename(name: &str, fallback: &str, max_len: Option<usize>) -> String {
        let s: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let mut out = s.trim_matches('-').to_string();
        if let Some(max) = max_len
            && out.len() > max
        {
            out.truncate(max);
        }
        if out.is_empty() {
            fallback.to_string()
        } else {
            out
        }
    }

    /// Lowercase dash-slug for display-derived filenames: alphanumerics kept
    /// (lowercased), runs of anything else collapse to a single `-`.
    pub fn slugify(name: &str) -> String {
        let mut out = String::new();
        let mut dash = false;
        for c in name.trim().chars() {
            if c.is_ascii_alphanumeric() {
                out.push(c.to_ascii_lowercase());
                dash = false;
            } else if !dash && !out.is_empty() {
                out.push('-');
                dash = true;
            }
        }
        let s = out.trim_matches('-').to_string();
        if s.is_empty() {
            "untitled".to_string()
        } else {
            s
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_split_plain() {
        let (fm, body) = frontmatter::split("---\nname: x\n---\ncode here\n");
        assert_eq!(fm, Some("name: x"));
        assert_eq!(body, "code here\n");
    }

    #[test]
    fn frontmatter_split_crlf_and_bom() {
        let (fm, body) = frontmatter::split("\u{feff}---\r\nbpm: 120\r\n---\r\nbody");
        assert_eq!(fm, Some("bpm: 120"));
        assert_eq!(body, "body");
    }

    #[test]
    fn frontmatter_split_without_block_is_identity() {
        let (fm, body) = frontmatter::split("s(\"bd\")");
        assert_eq!(fm, None);
        assert_eq!(body, "s(\"bd\")");
    }

    #[test]
    fn frontmatter_split_unclosed_is_identity() {
        let raw = "---\nname: x\nno close";
        assert_eq!(frontmatter::split(raw), (None, raw));
    }

    #[test]
    fn frontmatter_parse_scalars_and_arrays() {
        let fm = frontmatter::parse(
            "name: \"My Song\"\nbpm: 128\ntags: [house, 'four-floor']\nlist:\n  - a\n  - b\n",
        );
        assert_eq!(fm.scalar("name").as_deref(), Some("My Song"));
        assert_eq!(fm.scalar("bpm").as_deref(), Some("128"));
        assert_eq!(
            fm.array("tags"),
            Some(vec!["house".into(), "four-floor".into()])
        );
        assert_eq!(fm.array("list"), Some(vec!["a".into(), "b".into()]));
    }

    #[test]
    fn tempo_reads_setbpm() {
        assert_eq!(tempo::scan_bpm("setbpm(124);\nrest"), Some(124.0));
    }

    #[test]
    fn tempo_converts_setcpm() {
        // 30 cpm = 120 bpm at 4 beats/cycle.
        assert_eq!(tempo::scan_bpm("setcpm(30);"), Some(120.0));
    }

    #[test]
    fn tempo_converts_setcps() {
        // 0.5 cps = 120 bpm at 4 beats/cycle.
        assert_eq!(tempo::scan_bpm("setcps(0.5);"), Some(120.0));
    }

    #[test]
    fn tempo_skips_comment_lines() {
        assert_eq!(tempo::scan_bpm("// setbpm(90)\nsetbpm(140)"), Some(140.0));
    }

    #[test]
    fn tempo_none_without_directive() {
        assert_eq!(tempo::scan_bpm("s(\"bd*4\")"), None);
    }

    #[test]
    fn slug_filename_replaces_and_caps() {
        assert_eq!(slug::filename("My Song (v2)!", "x", None), "My-Song--v2");
        assert_eq!(slug::filename("!!!", "stem", None), "stem");
        assert_eq!(
            slug::filename(&"a".repeat(200), "midi", Some(100)).len(),
            100
        );
    }

    #[test]
    fn slugify_lowercases_and_collapses() {
        assert_eq!(slug::slugify("My Song (v2)"), "my-song-v2");
        assert_eq!(slug::slugify("  "), "untitled");
    }
}
