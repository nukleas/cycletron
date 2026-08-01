use crate::types::ToolDefinition;
use serde_json::json;

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
            name: "list_library".to_string(),
            description: "List the USER'S OWN saved songs (their personal library, not the \
                curated corpus), newest first — name, tempo, tags, sounds, and a preview. Use \
                this to know what the user has already made, to reference or continue their work."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "description": "Max songs to list (default 30)" }
                }
            }),
        },
        ToolDefinition {
            name: "search_library".to_string(),
            description: "Search the USER'S OWN saved songs by keyword (name/tag/sound/path), \
                tag, sound name, or tempo range. Use it for requests like 'remix my acid track' \
                or 'what have I made around 90 BPM'."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "keyword": { "type": "string", "description": "Substring across name, tags, sounds, path" },
                    "tag": { "type": "string", "description": "Match a frontmatter tag" },
                    "sound": { "type": "string", "description": "A sound/sample name the song uses (e.g. '303', 'bd')" },
                    "bpm_min": { "type": "number", "description": "Minimum tempo in BPM" },
                    "bpm_max": { "type": "number", "description": "Maximum tempo in BPM" },
                    "limit": { "type": "integer", "description": "Max results (default 15)" }
                }
            }),
        },
        ToolDefinition {
            name: "read_song".to_string(),
            description: "Open one of the user's saved songs to read its full code — so you can \
                remix, continue, or reference it. Pass the @path from list_library/search_library. \
                Read-only and confined to the user's library."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The song's library path (the @path from list/search)" }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "save_song".to_string(),
            description: "Save code as a NAMED song in the user's library (persists to disk). Use \
                when the user says 'save this as …'. Overwriting an existing song is allowed and \
                snapshots the old version first, but announce the overwrite in your reply. Never \
                organize or overwrite unless the user asked."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Display name (becomes a slugified filename)" },
                    "code": { "type": "string", "description": "The strudel code to save" },
                    "folder": { "type": "string", "description": "Optional library subfolder to save into" }
                },
                "required": ["name", "code"]
            }),
        },
        ToolDefinition {
            name: "save_current_as".to_string(),
            description: "Save the CURRENT editor buffer as a named song in the library — for \
                'save what I'm hearing as …' without re-sending the code."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Display name (becomes a slugified filename)" },
                    "folder": { "type": "string", "description": "Optional library subfolder" }
                },
                "required": ["name"]
            }),
        },
        ToolDefinition {
            name: "rename_song".to_string(),
            description: "Rename a saved song (keeps its folder). Only when the user asks to rename."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The song's current @path" },
                    "new_name": { "type": "string", "description": "New display name" }
                },
                "required": ["path", "new_name"]
            }),
        },
        ToolDefinition {
            name: "move_song".to_string(),
            description: "Move a saved song into a library folder (created if needed). Only when \
                the user asks to organize."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The song's current @path" },
                    "folder": { "type": "string", "description": "Destination folder in the library" }
                },
                "required": ["path", "folder"]
            }),
        },
        ToolDefinition {
            name: "new_folder".to_string(),
            description: "Create a folder in the user's library (for organizing). Only when asked."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Folder path within the library" }
                },
                "required": ["path"]
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
            name: "list_methods".to_string(),
            description:
                "List the strudel-rs DSL surface the validator ACCEPTS: free functions \
                (stack, note, s, …), chainable pattern methods (fast, jux, lpf, room, chop, …), \
                and file-level keywords (setbpm, hush). This is ground truth — call it before \
                using any method/effect you are not 100% sure exists, instead of guessing a name \
                and failing at validate time. Optionally narrow by `kind` (function|method|keyword) \
                or by `category` (a section substring like 'filter', 'delay', 'reverb', 'fm'). \
                For SOUND names use list_sounds instead."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["function", "method", "keyword"],
                        "description": "Keep only this kind of symbol. Omit for all."
                    },
                    "category": {
                        "type": "string",
                        "description": "Case-insensitive substring of the doc section \
                            (e.g. 'filter', 'delay', 'reverb', 'fm', 'conditionals'). Omit for all."
                    }
                }
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
                        "description": "Which generator to run. OPTIONAL — defaults to 'genre', and is otherwise inferred from whichever param you set (hex→hexbeat, motif→palindrome, numerals→numerals, rule→automaton). For a genre/style request just pass `genre` and leave this out."
                    },
                    "genre": { "type": "string", "description": "The genre/style to generate — kebab-case name from the genre map (e.g. deep-house, psytrance, gabber, amapiano, synthwave); family names and aliases also route. Setting this runs the genre generator." },
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
                }
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
                "Play a WHOLE strudel document — use this to START A NEW SONG or replace the \
                entire arrangement. It swaps the full editor buffer. To CHANGE ONE PART of a \
                song that's already playing (the bass, the hats, a melody), do NOT call this — \
                use upsert_track / mute_track so you edit one track and hot-swap without \
                rewriting everything. When you write a new song here, split it into addressable \
                tracks: one `$: <expr> // @<id>` line per part, e.g. \
                `$: s(\"bd*4\") // @drums` and `$: note(\"c2 g2\").s(\"sawtooth\") // @bass`."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Full strudel document to play (prefer one `$: … // @id` \
                            track per part so parts stay individually editable)"
                    }
                },
                "required": ["code"]
            }),
        },
        ToolDefinition {
            name: "list_parts".to_string(),
            description:
                "List the addressable tracks (parts) of the song currently in the editor: each \
                track's @id (or index), whether it's muted, and a code preview. Call this before \
                upsert_track / mute_track so you target the right part. A song is made of `$:` \
                lines the engine stacks; each is one part."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolDefinition {
            name: "upsert_track".to_string(),
            description:
                "Surgically add or replace ONE track in the current song, then hot-swap — every \
                other track stays byte-identical (this is how you 'change the bass' or 'add a \
                lead' without rewriting the song). `id` selects the track by its @id or 1-based \
                index; if none matches, a new `$: <code> // @<id>` track is appended. `code` is \
                just that track's expression (e.g. `note(\"c2 g2\").s(\"sawtooth\").lpf(400)`), \
                NOT a full document — no `$:`, no `setbpm`. The whole result is re-validated \
                before it plays. Call list_parts first if unsure of the ids."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Track @id (e.g. 'bass') or 1-based index (e.g. '2'). \
                            A new, unused id creates a new track."
                    },
                    "code": {
                        "type": "string",
                        "description": "The track's strudel expression only (no `$:`, no directives)"
                    }
                },
                "required": ["id", "code"]
            }),
        },
        ToolDefinition {
            name: "mute_track".to_string(),
            description:
                "Silence one track without deleting it (comments it out), then hot-swap. \
                Reversible with unmute_track. Use for breakdowns/drops or to A/B a part. \
                `id` is the track @id or 1-based index (see list_parts)."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Track @id or 1-based index to mute"
                    }
                },
                "required": ["id"]
            }),
        },
        ToolDefinition {
            name: "unmute_track".to_string(),
            description:
                "Restore a track previously silenced with mute_track, then hot-swap. \
                `id` is the track @id or 1-based index."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Track @id or 1-based index to unmute"
                    }
                },
                "required": ["id"]
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
