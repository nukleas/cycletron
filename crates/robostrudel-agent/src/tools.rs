use crate::types::ToolDefinition;
use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// A tool handler function: takes JSON input, returns string result.
pub type ToolHandler = Arc<
    dyn Fn(serde_json::Value) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
        + Send
        + Sync,
>;

/// Registry of tools available to the agent.
pub struct ToolRegistry {
    definitions: Vec<ToolDefinition>,
    handlers: HashMap<String, ToolHandler>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            definitions: Vec::new(),
            handlers: HashMap::new(),
        }
    }

    /// Register a tool with its definition and handler.
    pub fn register(&mut self, definition: ToolDefinition, handler: ToolHandler) {
        self.handlers.insert(definition.name.clone(), handler);
        self.definitions.push(definition);
    }

    /// Get all tool definitions (for sending to Claude API).
    pub fn definitions(&self) -> &[ToolDefinition] {
        &self.definitions
    }

    /// Execute a tool by name with the given input.
    pub async fn execute(&self, name: &str, input: serde_json::Value) -> Result<String, String> {
        let handler = self
            .handlers
            .get(name)
            .ok_or_else(|| format!("unknown tool: {name}"))?;
        handler(input).await
    }
}

/// Create the standard tool definitions for the music composition agent.
pub fn music_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "search_corpus".to_string(),
            description: "Search the strudel music corpus for patterns and examples. \
                Returns matching entries with metadata."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "tags": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Musical tags to filter by (e.g., 'acid', 'house', 'breakbeat')"
                    },
                    "role": {
                        "type": "string",
                        "enum": ["drum-groove", "bassline", "melodic-hook", "harmony-loop",
                                 "texture-bed", "transition-seed", "arrangement-seed", "remix-seed"],
                        "description": "Musical role to search for"
                    },
                    "tempo_min": {
                        "type": "number",
                        "description": "Minimum tempo in BPM"
                    },
                    "tempo_max": {
                        "type": "number",
                        "description": "Maximum tempo in BPM"
                    },
                    "sounds": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Sound/instrument names to search for (e.g., 'bd', 'sine', '303')"
                    },
                    "keyword": {
                        "type": "string",
                        "description": "Keyword to search in titles and code"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default 5)"
                    }
                }
            }),
        },
        ToolDefinition {
            name: "get_example".to_string(),
            description: "Get the full source code of a corpus entry by ID.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The corpus entry ID"
                    }
                },
                "required": ["id"]
            }),
        },
        ToolDefinition {
            name: "list_sounds".to_string(),
            description:
                "List the sounds currently playable: built-in synth/oscillator names, the \
                default drum sample banks, common General MIDI instruments (gm_*, which stream \
                in on first use), and any custom sample banks the user has loaded from their \
                own folders. Call this before writing `s(...)` if unsure what's available, so \
                you don't reference a name that falls back to a sine."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolDefinition {
            name: "generate_pattern".to_string(),
            description:
                "Generate a ready-to-play strudel pattern from an algorithmic-composition \
                primitive. Returns complete `.strudel` code (comment + setbpm + chain) that \
                already passes validation — a strong starting point you can play directly or \
                edit further. Generators (and the params each uses):\n\
                - 'genre' (full piece): a complete, musically-coherent arrangement — aligned \
                  drum grid, in-key bass, diatonic chords, and a generated melody/arp — built \
                  from music-theory primitives and round-trip verified, so it is never \
                  rhythmically misaligned or out of key. PREFER THIS for a full genre pattern. \
                  60+ genres across the whole electronic map are supported (house, techno, \
                  trance, dnb, dubstep, uk-garage, gabber, hardstyle, trap, phonk, amapiano, \
                  footwork, synthwave, chiptune, dub, idm, ebm, italo-disco, …); family names \
                  and common aliases route too. Params: genre (kebab-case name), seed \
                  (integer, varies the melodic parts; default 7).\n\
                - 'infinity' (melody): Per Nørgård's self-similar series. Params: count (notes, \
                  default 16), root (root MIDI note, default 60 = C4).\n\
                - 'hexbeat' (rhythm): a hex string is decoded to a 1-bar kick pattern, 4 steps \
                  per digit. Param: hex (e.g. 'a4f2', default 'a4f2').\n\
                - 'numerals' (harmony): a Roman-numeral progression becomes diatonic chords. \
                  Params: key (e.g. 'C', 'F#', default 'C'), numerals (e.g. 'ii V I vi').\n\
                - 'palindrome' (form): mirror a motif into a symmetric arch. Param: motif \
                  (space-separated notes, e.g. 'c4 e4 g4 b4').\n\
                - 'automaton' (motion): a Wolfram cellular automaton drives an evolving hat \
                  line, one row per cycle. Params: rule (0-255, default 90), width (default 8), \
                  gens (cycles, default 4)."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "generator": {
                        "type": "string",
                        "enum": ["genre", "infinity", "hexbeat", "numerals", "palindrome", "automaton"],
                        "description": "Which generator to run"
                    },
                    "genre": { "type": "string", "description": "genre: kebab-case name from the genre map (e.g. deep-house, psytrance, gabber, amapiano, synthwave); family names and aliases also route" },
                    "seed": { "type": "integer", "description": "genre: varies the generated melodic parts (default 7)" },
                    "count": { "type": "integer", "description": "infinity: number of notes (default 16)" },
                    "root": { "type": "integer", "description": "infinity: root MIDI note (default 60)" },
                    "hex": { "type": "string", "description": "hexbeat: hex string, e.g. 'a4f2'" },
                    "key": { "type": "string", "description": "numerals: key root, e.g. 'C' or 'F#' (default 'C')" },
                    "numerals": { "type": "string", "description": "numerals: Roman-numeral progression, e.g. 'ii V I vi'" },
                    "motif": { "type": "string", "description": "palindrome: space-separated notes, e.g. 'c4 e4 g4 b4'" },
                    "rule": { "type": "integer", "description": "automaton: Wolfram rule 0-255 (default 90)" },
                    "width": { "type": "integer", "description": "automaton: number of steps per cycle (default 8)" },
                    "gens": { "type": "integer", "description": "automaton: number of cycles/generations (default 4)" }
                },
                "required": ["generator"]
            }),
        },
        ToolDefinition {
            name: "validate_pattern".to_string(),
            description:
                "Validate strudel pattern code. Returns 'valid' or error details — and, when \
                the syntax is fine, also lints for SILENT failures that parse but never sound: \
                unknown sound names (silent layer), a chord symbol used without .voicing(), \
                pan outside 0..1 (negative pan = NaN = silence), and expected gm_* first-cycle \
                streaming silence. Treat every [warn] as a dead layer to fix before playing."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Strudel pattern code to validate"
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "review_pattern".to_string(),
            description:
                "The combined quality gate — ONE call that runs the whole pre-play checklist: \
                validation, a compact digest (bpm, events, loop period, voices, sounds), the \
                silence lint (unknown sounds / unvoiced chords / bad pan / gm first-cycle), the \
                mix critique (clipping, mono, clashes, low-end), and — when the code uses \
                pickRestart or arrange — the form critique (section lengths, energy arc, \
                robotic loops). PREFER THIS over separate validate/critique/critique_form calls \
                when reviewing a full pattern or multi-section song: it cuts the round-trip tax \
                to a single turn. Ends with a verdict; fix every warn before playing."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Strudel pattern code to review"
                    },
                    "cycles": {
                        "type": "integer",
                        "description": "How many cycles to scan (default 8, max 64). Raise for long song forms."
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "inspect_pattern".to_string(),
            description:
                "Evaluate pattern code and report what it ACTUALLY emits — your ears while \
                composing. Returns, over the first N cycles: a per-cycle event list (onset \
                time, voice, note+MIDI, gain/pan/effects), the distinct sounds that fire, the \
                pitch range, the detected loop length (how many cycles until it repeats), the \
                max simultaneous voices, whether it uses panning, and any SILENT cycles. \
                Use this after writing or editing a pattern to verify it does what you intend \
                before playing — e.g. to catch a `<...>` branch that never triggers, an empty \
                cycle, a melody stuck in one octave, or a stack that's secretly mono. \
                Validation only checks that code parses; this checks that it's musical."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Strudel pattern code to inspect"
                    },
                    "cycles": {
                        "type": "integer",
                        "description": "How many cycles to query (default 8, max 64). \
                            Use more to see longer song forms / slowcat variation."
                    },
                    "verbosity": {
                        "type": "string",
                        "enum": ["auto", "summary", "events"],
                        "description": "auto (default): full event log for ≤4 cycles, summary \
                            beyond. summary: high-level facts + per-cycle event counts only. \
                            events: always the full per-event log."
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "analyze_arrangement".to_string(),
            description:
                "Analyze a pattern's ARRANGEMENT over time — its structure, not its moment. \
                Scans up to N cycles, detects the loop length, and segments it into sections \
                wherever the active instrumentation changes (a part entering or leaving). \
                Returns: the song form as letters (e.g. 'A A B A'), and for each section its \
                cycle range, wall-clock time window (needs a tempo in the code), the \
                instruments sounding, and the event density. Use this to reason about song \
                structure and length — to check a build actually adds energy section by \
                section, that a drop drops, that sections are the bars you intended, or to \
                find where to place a transition. Complements inspect_pattern (which shows a \
                single moment); this shows the whole timeline."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Strudel pattern code to analyze"
                    },
                    "max_cycles": {
                        "type": "integer",
                        "description": "How many cycles to scan for the loop / form (default 32, \
                            max 64). Raise for long song forms."
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "critique_pattern".to_string(),
            description:
                "Musically lint a pattern — does it sound GOOD, not just parse. (Use \
                validate_pattern for correctness.) Evaluates the pattern over its loop and \
                reports findings: clipping risk (too many loud voices stacked at one instant), \
                silent cycles, a mono mix (everything centre-panned), simultaneous semitone \
                clashes, no low-end anchor (no kick/sub and the bass sits too high), and a \
                melody stuck on one pitch. Each finding is a 'warn' (likely a problem) or a \
                'note' (stylistic). Call it before playing to catch mix problems, or after a \
                user says it sounds muddy/thin/harsh to find why."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Strudel pattern code to critique"
                    },
                    "cycles": {
                        "type": "integer",
                        "description": "How many cycles to scan (default 16, max 64)."
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "critique_form".to_string(),
            description:
                "Critique a pattern's FORM — whether it's arranged like a song, not one looping \
                bar. (Use critique_pattern for mix issues, analyze_arrangement for the raw \
                structure.) Reports: sections whose length isn't a whole number of 4-bar phrases; \
                no energy contrast (every section the same density); the busiest section being \
                first instead of building to a peak; a melody that repeats the same 1-bar phrase \
                under a long section (robotic loop); and — when pickRestart labels are present — a \
                low-energy section (intro/break/outro) as busy as the drop, or a drop that doesn't \
                step up from the section before it. Call it after writing a multi-section song \
                (especially with pickRestart) to check the arrangement earns its sections; fix any \
                'warn' before playing."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Strudel pattern code to critique for form"
                    },
                    "cycles": {
                        "type": "integer",
                        "description": "How many cycles to scan for the full form (default 32, \
                            max 64). Raise for long songs."
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "genre_recipe".to_string(),
            description:
                "Look up how to make a GENRE in strudel-rs terms. Returns a curated recipe: \
                the tempo range, scales, defining sounds, reference artists, and — crucially — \
                complete, PLAYABLE strudel fragments (drum core, bassline, signature effect \
                chain, etc.) that are gated by corpus-check, so every fragment is guaranteed \
                to parse and emit on this engine. Call this BEFORE writing a pattern in a named \
                style so you use real idioms instead of guessing, and lift/adapt the fragments \
                directly. Call with no genre to list the styles that have a recipe."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "genre": {
                        "type": "string",
                        "description": "Genre or style name (e.g. 'acid techno', 'acid'). \
                            Matches genre names and aliases. Omit to list available recipes."
                    }
                }
            }),
        },
        ToolDefinition {
            name: "play_pattern".to_string(),
            description:
                "Play a strudel pattern through the existing WASM REPL/editor playback path. \
                Replaces any currently playing pattern."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Strudel pattern code to play"
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "stop".to_string(),
            description: "Stop audio playback.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolDefinition {
            name: "set_tempo".to_string(),
            description: "Set the playback tempo in BPM.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "bpm": {
                        "type": "number",
                        "description": "Tempo in beats per minute"
                    }
                },
                "required": ["bpm"]
            }),
        },
    ]
}
