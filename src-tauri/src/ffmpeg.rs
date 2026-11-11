//! Finding ffmpeg. An app opened from the Finder or a desktop launcher gets a
//! bare PATH without Homebrew's or the user's shell additions, so the usual
//! install locations are searched as well. On Windows ffmpeg is a console
//! program, so it is started without a console window.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const NAME: &str = if cfg!(windows) {
    "ffmpeg.exe"
} else {
    "ffmpeg"
};

/// Searched after `FFMPEG_PATH` and the PATH.
const KNOWN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/opt/local/bin",
];

/// The ffmpeg binary: `FFMPEG_PATH` when set (it must exist), else the PATH,
/// then the usual install locations.
pub fn find() -> Result<Option<PathBuf>, String> {
    if let Some(p) = std::env::var_os("FFMPEG_PATH") {
        let p = PathBuf::from(p);
        return if p.is_file() {
            Ok(Some(p))
        } else {
            Err(format!(
                "FFMPEG_PATH is {}, which isn't a file",
                p.display()
            ))
        };
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    Ok(std::env::split_paths(&path)
        .chain(KNOWN_DIRS.iter().map(PathBuf::from))
        .map(|dir| dir.join(NAME))
        .find(|p| p.is_file()))
}

/// `find`, or an error saying how to install it.
pub fn require(purpose: &str) -> Result<PathBuf, String> {
    find()?.ok_or_else(|| {
        format!(
            "{purpose} needs ffmpeg, and it isn't installed. Install it (macOS: `brew install ffmpeg`; \
             Linux: your package manager; Windows: `winget install Gyan.FFmpeg`) or set FFMPEG_PATH \
             to the binary."
        )
    })
}

/// A command for ffmpeg (or another console tool) that opens no console window on Windows.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Whether this ffmpeg was built with the named encoder (e.g. `libx264`).
/// Distribution builds sometimes leave the patent- or GPL-encumbered ones out.
pub fn has_encoder(ffmpeg: &Path, name: &str) -> bool {
    command(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|line| line.split_whitespace().nth(1) == Some(name))
        })
}
