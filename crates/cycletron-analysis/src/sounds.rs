//! Catalog of the built-in sounds the engine can always play (synths,
//! wavetables, default drums, drum-machine kits, GM picks). Lives here so both
//! the CLI tools and the app's silence linter share one known-sound set; the
//! app adds user-loaded sample banks on top.

/// Built-in synth/oscillator names (from `strudel-sounds` + new wavetables).
pub const SYNTHS: &[&str] = &[
    "sine",
    "triangle",
    "sawtooth",
    "square",
    "pulse",
    "fm",
    "supersaw",
    "supersquare",
    "superpwm",
    "superzow",
    "white",
    "pink",
    "brown",
    "crackle",
    "sbd",
];

/// Wavetable synths — richer timbres, 20 tables baked at WASM compile time.
/// Use with `note("…").s("wt_flute")` etc.
pub const WAVETABLES: &[&str] = &[
    "wt_flute",
    "wt_clarinet",
    "wt_oboe",
    "wt_violin",
    "wt_cello",
    "wt_trumpet",
    "wt_bassoon",
    "wt_organ",
    "wt_piano",
    "wt_bell",
    "wt_pluck",
    "wt_bass",
    "wt_lead",
    "wt_pad",
    "wt_choir",
    "wt_strings",
    "wt_sine",
    "wt_tri",
    "wt_square",
    "wt_saw",
];

/// Drum sample banks loaded by default at startup.
///
/// `bd`/`sd`/`hh`/`oh`/`cr`/toms/congas are multi-variant (`s("hh:2")`).
/// `rim` is the same bank as `rs`. `rd`/`sh`/`tb`/`brk` come from uzu-drumkit.
pub const DEFAULT_DRUMS: &[&str] = &[
    "bd", "sd", "sn", "hh", "cp", "oh", "ht", "mt", "lt", "cr", "cb", "rs", "rim", "rd", "sh",
    "tb", "brk", "cl", "ma", "lc", "mc", "hc",
];

/// Percussion & texture "color" banks — CC0 recordings (VCSL) bundled in
/// `ui/public/samples/` and loaded in the background at startup (see
/// `PERCUSSION_COLORS` in `ui/sample-loader.ts`, which must stay in sync).
/// Each bank is a single raw fortissimo one-shot (anvil, brake drum, claves…)
/// with no `:n` variants; agent guidance treats them as sparse
/// genre-appropriate accents, not default percussion.
pub const PERCUSSION: &[&str] = &[
    "perc",
    "click",
    "metal",
    "east",
    "hand",
    "industrial",
    "space",
    "arpy",
    "tabla",
    "jvbass",
];

/// Melodic / speech expansion banks — short CC0 slices from the Tidal
/// Clean-Samples ecosystem (see `INSTRUMENT_BANKS` in `ui/sample-loader.ts`,
/// which must stay in sync). Multi-variant unpitched one-shots: use
/// `s("flbass:2")` for a different take. Not chromatically multisampled —
/// for in-tune pitched melodies prefer `gm_*` or `wt_*`.
pub const INSTRUMENTS: &[&str] = &["flbass", "uke", "cpluck", "cbow", "speech"];

/// Bundled VCSL instruments (CC0), note-mapped: `note("c4 e4").s("kalimba")`
/// plays in tune from the nearest recorded note, like a downloaded set's
/// pitched banks. See `VCSL_PITCHED` in `ui/sample-tables.ts` (must stay in
/// sync) and ATTRIBUTION.md.
pub const VCSL_PITCHED: &[&str] = &[
    "kalimba",
    "marimba",
    "vibraphone",
    "glockenspiel",
    "tubularbells",
    "harp",
    "ocarina",
    "recorder_alto_sus",
    "balafon",
    "harmonica",
    "steinway",
    "strumstick",
    "psaltery_pluck",
    "dantranh",
];

/// Bundled VCSL percussion (CC0): indexed one-shots with `:n` variants
/// (`s("bongo:2")`), several hits or dynamics per bank. See `VCSL_ONESHOTS`
/// in `ui/sample-tables.ts` (must stay in sync).
pub const VCSL_ONESHOTS: &[&str] = &[
    "gong",
    "timpani",
    "didgeridoo",
    "bongo",
    "shaker_small",
    "tambourine",
    "agogo",
    "guiro",
    "sleighbells",
    "triangles",
    "framedrum",
    "darbuka",
];

/// Single source of truth for how `.bank()` behaves, surfaced to the agent via
/// `list_sounds` (see `src-tauri/src/sounds.rs`) so the claim lives in exactly
/// one place. The `.bank()` half of this is verified against the real engine by
/// [`crate::engine_contract`]; keep them consistent.
pub const DRUM_MACHINE_NOTE: &str = "Two equivalent forms: s(\"RolandTR808_bd\") or s(\"bd\").bank(\"RolandTR808\"). \
     .bank() IS supported and rewrites every sample name in the pattern to {Bank}_{sound}, \
     so a voice the kit lacks goes silent — e.g. LinnDrum has no cr, so \
     s(\"bd cr\").bank(\"LinnDrum\") drops the crash. .bank() only affects samples; \
     it no-ops on synths/GM.";

/// Bundled drum machine kits and their voices.
/// Bank names are `{MachineName}_{voice}`, e.g. `s("RolandTR808_bd")`.
/// `.bank()` prefix lookup IS implemented in the engine, so `s("bd").bank("RolandTR808")`
/// resolves to the same sample — the two forms are interchangeable.
pub const MACHINE_KITS: &[(&str, &str, &[&str])] = &[
    (
        "RolandTR808",
        "TR-808",
        &["bd", "sd", "hh", "oh", "cp", "rim", "lt", "mt", "ht", "cb"],
    ),
    (
        "RolandTR909",
        "TR-909",
        &["bd", "sd", "hh", "oh", "cp", "rd", "rim"],
    ),
    (
        "RolandTR707",
        "TR-707",
        &["bd", "sd", "hh", "oh", "cp", "lt", "ht"],
    ),
    ("LinnDrum", "LinnDrum", &["bd", "sd", "hh", "cp"]),
    ("BossDR55", "DR-55", &["bd", "sd", "hh", "rim"]),
];

/// Every General MIDI voice the engine dispatches, straight from the
/// soundfont crate's own table so the list can never drift from the pinned
/// engine. 128 programs; the piano family shares a bank name and selects the
/// program with a `:n` variant (`gm_piano:7` is bright piano).
pub fn gm_instruments() -> &'static [&'static str] {
    static GM: std::sync::LazyLock<Vec<&'static str>> = std::sync::LazyLock::new(|| {
        (0u8..128)
            .filter_map(strudel_soundfont::GmInstrument::new_checked)
            .map(strudel_soundfont::GmInstrument::to_str)
            .collect()
    });
    &GM
}

static BUILTIN: std::sync::LazyLock<std::collections::HashSet<String>> =
    std::sync::LazyLock::new(|| {
        let mut set: std::collections::HashSet<String> = SYNTHS
            .iter()
            .chain(WAVETABLES.iter())
            .chain(DEFAULT_DRUMS.iter())
            .chain(PERCUSSION.iter())
            .chain(INSTRUMENTS.iter())
            .chain(VCSL_PITCHED.iter())
            .chain(VCSL_ONESHOTS.iter())
            .chain(gm_instruments().iter())
            .map(std::string::ToString::to_string)
            .collect();
        for (machine, _, voices) in MACHINE_KITS {
            for v in *voices {
                set.insert(format!("{machine}_{v}"));
            }
        }
        set
    });

/// Every sound name that resolves without user-loaded banks: synths,
/// wavetables, default drums, drum-machine voices, and all 128 General MIDI
/// voices. Built once; used by the silence linter.
pub fn builtin_sound_set() -> &'static std::collections::HashSet<String> {
    &BUILTIN
}

/// The resolvable sound set for lint/repair: the static builtin catalog plus
/// any user-loaded sample banks, layered without copying the builtin names.
pub struct SoundSet {
    builtin: &'static std::collections::HashSet<String>,
    user: Vec<String>,
}

impl SoundSet {
    pub fn builtin_only() -> Self {
        Self {
            builtin: builtin_sound_set(),
            user: Vec::new(),
        }
    }

    pub fn with_user_banks(user: Vec<String>) -> Self {
        Self {
            builtin: builtin_sound_set(),
            user,
        }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.builtin.contains(name) || self.user.iter().any(|u| u == name)
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.builtin
            .iter()
            .map(String::as_str)
            .chain(self.user.iter().map(String::as_str))
    }

    /// A set that resolves nothing — for exercising catalog-gated paths.
    #[cfg(test)]
    pub(crate) fn empty() -> Self {
        static NONE: std::sync::LazyLock<std::collections::HashSet<String>> =
            std::sync::LazyLock::new(std::collections::HashSet::new);
        Self {
            builtin: &NONE,
            user: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gm_list_is_the_full_general_midi_map() {
        let gm = gm_instruments();
        assert_eq!(gm.len(), 128);
        for name in [
            "gm_piano",
            "gm_piano:7",
            "gm_koto",
            "gm_steel_drums",
            "gm_pad_warm",
        ] {
            assert!(gm.contains(&name), "{name} missing");
        }
        assert!(gm.iter().all(|n| n.starts_with("gm_")));
        assert!(builtin_sound_set().contains("gm_koto"));
    }

    #[test]
    fn bundled_vcsl_banks_are_known_sounds() {
        let set = builtin_sound_set();
        for name in VCSL_PITCHED.iter().chain(VCSL_ONESHOTS) {
            assert!(set.contains(*name), "{name}");
        }
        assert_eq!(VCSL_PITCHED.len() + VCSL_ONESHOTS.len(), 26);
    }
}
