//! Reading the desktop's colour scheme, so Cycletron can match it.
//!
//! Omarchy publishes the active theme's palette as a flat `colors.toml` under
//! `~/.local/state/omarchy/current/theme/`. Switching themes deletes that
//! directory and moves a new one into place, so the file is watched by polling
//! its path rather than by holding a handle to an inode that won't survive.
//!
//! Nothing here is Omarchy-specific beyond the path: any desktop that drops a
//! `key = "#rrggbb"` table there gets the same treatment.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

/// Emitted with the new palette whenever the theme changes on disk.
pub const CHANGED_EVENT: &str = "desktop-theme-changed";

const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
pub struct DesktopTheme {
    /// `"dark"` or `"light"`, as the theme declares itself.
    pub mode: String,
    /// The palette under the names the theme file uses — `background`,
    /// `accent`, `bright_magenta`, and so on. Mapping those onto Cycletron's
    /// own tokens is the frontend's job, since that is where the tokens live.
    pub colors: BTreeMap<String, String>,
}

fn colors_path() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    // Omarchy 4 publishes the live palette under ~/.local/state. Earlier
    // releases kept the same file under ~/.config, and either path is a
    // `key = "#rrggbb"` table, so we accept both.
    let quattro = home.join(".local/state/omarchy/current/theme/colors.toml");
    if quattro.exists() {
        return Some(quattro);
    }
    let legacy = home.join(".config/omarchy/current/theme/colors.toml");
    if legacy.exists() {
        return Some(legacy);
    }
    Some(quattro)
}

/// The current desktop palette, or `None` where no desktop publishes one.
#[tauri::command]
pub fn get_desktop_theme() -> Option<DesktopTheme> {
    let body = std::fs::read_to_string(colors_path()?).ok()?;
    Some(parse(&body))
}

/// `colors.toml` is a flat table of `key = "value"` — no sections, no arrays,
/// no multi-line strings — so a TOML dependency would buy nothing here.
fn parse(body: &str) -> DesktopTheme {
    let mut mode = "dark".to_string();
    let mut colors = BTreeMap::new();

    for line in body.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, rest)) = line.split_once('=') else {
            continue;
        };
        // Values are quoted, and colours contain '#', so take what is between
        // the quotes rather than trying to strip trailing comments.
        let rest = rest.trim();
        let Some(value) = rest
            .strip_prefix('"')
            .and_then(|v| v.split('"').next())
            .filter(|v| !v.is_empty())
        else {
            continue;
        };

        match key.trim() {
            "mode" => mode = value.to_string(),
            name => {
                colors.insert(name.to_string(), value.to_string());
            }
        }
    }

    DesktopTheme { mode, colors }
}

/// Watch for theme switches. Polls, because the whole theme directory is
/// replaced on every switch. Re-resolves the path each tick so a later
/// Omarchy upgrade (or a fallback file appearing) is picked up without a
/// restart.
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_seen: Option<SystemTime> = colors_path()
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|meta| meta.modified().ok());

        loop {
            std::thread::sleep(POLL_INTERVAL);
            let modified = colors_path()
                .and_then(|path| std::fs::metadata(path).ok())
                .and_then(|meta| meta.modified().ok());
            if modified == last_seen {
                continue;
            }
            last_seen = modified;

            // A vanished file means the desktop has no theme to follow right
            // now; say so rather than leaving the last one painted on.
            let _ = app.emit(CHANGED_EVENT, get_desktop_theme());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_flat_colour_table() {
        let theme = parse(
            r##"
mode = "light"

# A comment line
accent = "#7aa2f7"
background = "#1a1b26"
not_a_pair
empty = ""
"##,
        );

        assert_eq!(theme.mode, "light");
        assert_eq!(theme.colors.get("accent").unwrap(), "#7aa2f7");
        assert_eq!(theme.colors.get("background").unwrap(), "#1a1b26");
        assert!(!theme.colors.contains_key("empty"));
        assert!(!theme.colors.contains_key("mode"));
    }

    #[test]
    fn defaults_to_dark_when_the_theme_is_silent() {
        assert_eq!(parse("accent = \"#ffffff\"").mode, "dark");
    }
}
