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
                        "enum": ["infinity", "hexbeat", "numerals", "palindrome", "automaton"],
                        "description": "Which generator to run"
                    },
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
            description: "Validate strudel pattern code. Returns 'valid' or error details."
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
