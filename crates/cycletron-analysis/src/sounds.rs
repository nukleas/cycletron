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
pub const DEFAULT_DRUMS: &[&str] = &[
    "bd", "sd", "sn", "hh", "cp", "oh", "ht", "mt", "lt", "cr", "cb", "rs",
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

/// A representative slice of the General MIDI soundfont instruments that load on
/// demand. (Any `gm_*` General MIDI name works; these are common picks.)
pub const GM_INSTRUMENTS: &[&str] = &[
    "gm_piano",
    "gm_epiano1",
    "gm_harpsichord",
    "gm_acoustic_bass",
    "gm_electric_bass_finger",
    "gm_violin",
    "gm_cello",
    "gm_string_ensemble_1",
    "gm_trumpet",
    "gm_trombone",
    "gm_alto_sax",
    "gm_flute",
    "gm_clarinet",
    "gm_acoustic_guitar_nylon",
    "gm_overdriven_guitar",
    "gm_church_organ",
    "gm_synth_bass_1",
    "gm_lead_1_square",
    "gm_pad_warm",
    "gm_marimba",
    "gm_xylophone",
];

static BUILTIN: std::sync::LazyLock<std::collections::HashSet<String>> =
    std::sync::LazyLock::new(|| {
        let mut set: std::collections::HashSet<String> = SYNTHS
            .iter()
            .chain(WAVETABLES.iter())
            .chain(DEFAULT_DRUMS.iter())
            .chain(PERCUSSION.iter())
            .chain(INSTRUMENTS.iter())
            .chain(GM_INSTRUMENTS.iter())
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
/// wavetables, default drums, and drum-machine voices. `gm_*` names are NOT
/// enumerated (any GM name streams on demand) — callers should treat the
/// `gm_` prefix as known. Built once; used by the silence linter.
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
