use super::tools_doc::current_document;
use super::{ToolErr, ToolResult, opt_usize, req_str};
use crate::state::AppState;
use cycletron_agent::types::*;
use cycletron_analysis as strudel;
use cycletron_core::types::{CorpusQuery, ToolCategory, ToolOutcome};
use tokio::sync::mpsc;

pub(super) fn tool_search_corpus(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let query = CorpusQuery {
        tags: input["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        tempo_min: input["tempo_min"].as_f64(),
        tempo_max: input["tempo_max"].as_f64(),
        complexity: input["complexity"].as_str().map(String::from),
        sounds: input["sounds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        keyword: input["keyword"].as_str().map(String::from),
        limit: input["limit"].as_u64().map(|n| n as usize),
    };

    let corpus = state.corpus.lock();
    match &*corpus {
        Some(index) => {
            let results = index.search(&query);
            let text = serde_json::to_string_pretty(&results).map_err(ToolErr::io)?;
            Ok(ToolOutcome::ok(
                format!("{} corpus match(es)", results.len()),
                text,
            ))
        }
        None => Ok(ToolOutcome::ok("corpus not loaded — no matches", "[]")),
    }
}

pub(super) fn tool_get_example(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let id = req_str(input, "id")?;
    let corpus = state.corpus.lock();
    match &*corpus {
        Some(index) => index
            .get_source(id)
            .map(|src| ToolOutcome::ok(format!("example {id}"), src))
            .map_err(ToolErr::not_found),
        None => Err(ToolErr::precondition("corpus not loaded")),
    }
}

// --- Library awareness (read-only) -------------------------------------------
// The agent can see and read the user's OWN saved songs, not just the curated
// corpus. All three tools are read-only and confined to the library root.

/// One line per song for the agent: name, tempo, tags, sounds, path, preview.
fn format_song_line(s: &crate::library_index::LibrarySong) -> String {
    let bpm = s
        .bpm
        .map(|b| format!("{b:.0} BPM"))
        .unwrap_or_else(|| "—".into());
    let tags = if s.tags.is_empty() {
        String::new()
    } else {
        format!(" · #{}", s.tags.join(" #"))
    };
    let sounds = if s.sounds.is_empty() {
        String::new()
    } else {
        format!(
            " · sounds: {}",
            s.sounds
                .iter()
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "• {} [{bpm}]{tags}  @{}{sounds}\n    {}",
        s.name, s.rel_path, s.preview
    )
}

/// List the user's saved songs (newest first). Optional `limit` (default 30).
pub(super) fn tool_list_library(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let root = state.library_root();
    let warn = crate::library_index::root_warning(&root)
        .map(|w| format!("{w}\n\n"))
        .unwrap_or_default();
    let idx = crate::library_index::LibraryIndex::build(&root);
    if idx.songs.is_empty() {
        return Ok(ToolOutcome::ok(
            "library is empty",
            format!("{warn}Your library is empty — no saved songs yet."),
        ));
    }
    let limit = input["limit"].as_u64().map(|n| n as usize).unwrap_or(30);
    let shown = idx.songs.len().min(limit);
    let mut out = format!(
        "{warn}Your library: {} song(s){}\n",
        idx.songs.len(),
        if shown < idx.songs.len() {
            format!(" (showing newest {shown})")
        } else {
            String::new()
        }
    );
    for s in idx.songs.iter().take(limit) {
        out.push_str(&format_song_line(s));
        out.push('\n');
    }
    out.push_str("\nUse read_song with an @path to open one.");
    Ok(ToolOutcome::ok(
        format!("{} song(s) in the library", idx.songs.len()),
        out,
    ))
}

/// Search the user's saved songs by keyword / tag / sound / tempo range.
pub(super) fn tool_search_library(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let q = crate::library_index::LibraryQuery {
        keyword: input["keyword"].as_str().map(String::from),
        tag: input["tag"].as_str().map(String::from),
        sound: input["sound"].as_str().map(String::from),
        bpm_min: input["bpm_min"].as_f64(),
        bpm_max: input["bpm_max"].as_f64(),
        limit: input["limit"].as_u64().map(|n| n as usize).or(Some(15)),
    };
    let root = state.library_root();
    let warn = crate::library_index::root_warning(&root)
        .map(|w| format!("{w}\n\n"))
        .unwrap_or_default();
    let idx = crate::library_index::LibraryIndex::build(&root);
    let hits = idx.search(&q);
    if hits.is_empty() {
        return Ok(ToolOutcome::failed(
            ToolCategory::NotFound,
            format!(
                "{warn}No songs in your library match that. Try list_library to see everything."
            ),
        ));
    }
    let mut out = format!("{warn}{} matching song(s):\n", hits.len());
    let n = hits.len();
    for s in hits {
        out.push_str(&format_song_line(s));
        out.push('\n');
    }
    Ok(ToolOutcome::ok(format!("{n} matching song(s)"), out))
}

/// Open one of the user's saved songs (by its @rel_path) to remix or continue it.
pub(super) fn tool_read_song(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let path = input["path"]
        .as_str()
        .ok_or_else(|| {
            ToolErr::bad_argument("missing 'path' — use the @path from list_library/search_library")
        })?
        .trim()
        .trim_start_matches('@');
    let root = state.library_root();
    let doc = crate::library_index::read_song(&root, path)?;
    // Charge this read against the per-turn egress budget; if it would exceed the
    // ceiling, refuse — the content is NOT returned, so nothing leaves the machine.
    state
        .account_read(doc.code.len())
        .map_err(ToolErr::budget)?;
    let fm = doc.frontmatter.unwrap_or_default();
    let header = format!(
        "// {} — {}{}\n",
        fm.name.unwrap_or_else(|| path.to_string()),
        fm.bpm
            .map(|b| format!("{b:.0} BPM"))
            .unwrap_or_else(|| "tempo unset".into()),
        if fm.tags.is_empty() {
            String::new()
        } else {
            format!(" · #{}", fm.tags.join(" #"))
        },
    );
    Ok(ToolOutcome::ok(
        format!("read @{path}"),
        format!("{header}{}", doc.code),
    ))
}

// --- Library writes (Tier B) — optimistic + reversible, root-confined --------

/// Notify the frontend that the library changed: refresh the file tree + toast.
/// Mirrors the `__set_code_and_play` sentinel pattern (tools have no AppHandle).
fn emit_library_changed(event_tx: &mpsc::UnboundedSender<AgentEvent>, rel_path: &str) {
    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__library_changed".to_string(),
        payload: rel_path.to_string(),
    });
}

/// Save agent-supplied code as a named song in the library.
pub(super) fn tool_save_song(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let name = req_str(input, "name")?;
    let code = req_str(input, "code")?;
    let folder = input["folder"].as_str();
    let root = state.library_root();
    let rel = crate::library_index::save_song(
        &root,
        state.app_data_dir().as_deref(),
        name,
        code,
        folder,
    )?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("saved @{rel}"),
        format!(
            "Saved '{name}' to your library at @{rel} (prior version snapshotted; undo from the file's history)."
        ),
    ))
}

/// Save the CURRENT editor buffer as a named song.
pub(super) fn tool_save_current_as(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let name = req_str(input, "name")?;
    let folder = input["folder"].as_str();
    let code = current_document(state)?;
    let root = state.library_root();
    let rel = crate::library_index::save_song(
        &root,
        state.app_data_dir().as_deref(),
        name,
        &code,
        folder,
    )?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("saved @{rel}"),
        format!("Saved the current song as '{name}' at @{rel}."),
    ))
}

pub(super) fn tool_rename_song(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let path = req_str(input, "path")?;
    let new_name = req_str(input, "new_name")?;
    let root = state.library_root();
    let rel = crate::library_index::rename_song(&root, path, new_name)?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("renamed to @{rel}"),
        format!("Renamed to '{new_name}' — now at @{rel}."),
    ))
}

pub(super) fn tool_move_song(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let path = req_str(input, "path")?;
    let folder = req_str(input, "folder")?;
    let root = state.library_root();
    let rel = crate::library_index::move_song(&root, path, folder)?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("moved to @{rel}"),
        format!("Moved to @{rel}."),
    ))
}

pub(super) fn tool_new_folder(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let path = req_str(input, "path")?;
    let root = state.library_root();
    let rel = crate::library_index::create_folder(&root, path)?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("created @{rel}"),
        format!("Created folder @{rel}."),
    ))
}

/// Report the sounds currently playable (synths, drums, GM instruments, and
/// any user-loaded sample banks) so the agent picks names that actually exist.
pub(super) fn tool_list_sounds(state: &AppState) -> ToolResult {
    let text =
        serde_json::to_string_pretty(&crate::sounds::sound_catalog(state)).map_err(ToolErr::io)?;
    Ok(ToolOutcome::ok("sound catalog", text))
}

/// Report the DSL method/function/keyword surface the validator accepts, so the
/// agent uses real names instead of guessing. Backed by the generated
/// `dsl-surface.json` (ground truth = `docs/STRUDEL_RS_SUPPORTED.md`).
pub(super) fn tool_list_methods(input: &serde_json::Value) -> ToolResult {
    let kind = input["kind"].as_str();
    let category = input["category"].as_str();
    Ok(ToolOutcome::ok(
        "method listing",
        strudel::methods_listing(kind, category),
    ))
}

/// Resolve which generator to run. Models (small local ones especially) fill the
/// specific param (`genre`, `hex`, `motif`, …) but often omit the `generator`
/// discriminator because it feels redundant — so infer it from what's present,
/// defaulting to `genre` (the overwhelmingly common request).
fn infer_generator(input: &serde_json::Value) -> &'static str {
    if let Some(g) = input["generator"].as_str() {
        return match g {
            "infinity" => "infinity",
            "hexbeat" => "hexbeat",
            "numerals" => "numerals",
            "palindrome" => "palindrome",
            "automaton" => "automaton",
            _ => "genre",
        };
    }
    let has = |k: &str| !input[k].is_null();
    if has("hex") {
        "hexbeat"
    } else if has("motif") {
        "palindrome"
    } else if has("numerals") {
        "numerals"
    } else if has("rule") || has("gens") {
        "automaton"
    } else if has("genre") {
        "genre"
    } else if has("count") || has("root") {
        "infinity"
    } else {
        "genre"
    }
}

/// Generate ready-to-play strudel code from an algorithmic-composition
/// primitive (`cycletron_gen`). Returns complete `.strudel` source the agent
/// can then validate / play / edit. Missing params fall back to the same
/// defaults as the `gen-pattern` CLI.
pub(super) fn tool_generate_pattern(input: &serde_json::Value) -> ToolResult {
    let generator = infer_generator(input);

    let code = match generator {
        "genre" => {
            let genre = input["genre"].as_str().unwrap_or("house");
            let seed = input["seed"].as_u64().unwrap_or(7);
            cycletron_gen::compose::by_name(genre, seed)
                .map_err(ToolErr::bad_argument)
                .map(|piece| {
                    let code = piece.to_strudel();
                    // Family names and aliases route to one flagship — say so, and
                    // name the siblings, so "trance" → uplifting-trance is a
                    // visible choice rather than a silent collapse.
                    let requested = genre.trim().to_ascii_lowercase().replace([' ', '_'], "-");
                    match cycletron_gen::spec::find(genre) {
                        Some(spec) if spec.name != requested => {
                            let siblings: Vec<String> = cycletron_gen::map::families()
                                .iter()
                                .find(|f| f.genres.iter().any(|g| g.name == spec.name))
                                .map(|f| {
                                    f.genres
                                        .iter()
                                        .filter(|g| g.name != spec.name)
                                        .map(|g| g.name.clone())
                                        .collect()
                                })
                                .unwrap_or_default();
                            let others = if siblings.is_empty() {
                                String::new()
                            } else {
                                format!("; the map also has: {}", siblings.join(", "))
                            };
                            format!("// routed '{requested}' → {}{others}\n{code}", spec.name)
                        }
                        _ => code,
                    }
                })?
        }
        "infinity" => {
            let count = opt_usize(input, "count", 16);
            let root = input["root"].as_i64().unwrap_or(60) as i32;
            cycletron_gen::infinity(count, root)
        }
        "hexbeat" => {
            let hex = input["hex"].as_str().unwrap_or("a4f2");
            cycletron_gen::hexbeat(hex).map_err(ToolErr::bad_argument)?
        }
        "numerals" => {
            let key = input["key"].as_str().unwrap_or("C");
            let numerals = input["numerals"].as_str().unwrap_or("ii V I vi");
            cycletron_gen::numerals(key, numerals).map_err(ToolErr::bad_argument)?
        }
        "palindrome" => {
            let motif = input["motif"].as_str().unwrap_or("c4 e4 g4 b4");
            cycletron_gen::palindrome(motif)
        }
        "automaton" => {
            let rule = input["rule"].as_u64().unwrap_or(90).min(255) as u8;
            let width = opt_usize(input, "width", 8);
            let gens = opt_usize(input, "gens", 4);
            cycletron_gen::automaton(rule, width, gens).map_err(ToolErr::bad_argument)?
        }
        other => {
            return Err(ToolErr::bad_argument(format!(
                "unknown generator '{other}'; supported: genre, infinity, hexbeat, numerals, palindrome, automaton"
            )));
        }
    };
    Ok(ToolOutcome::ok(format!("generated ({generator})"), code))
}

pub(super) fn tool_genre_recipe(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let recipes = state.recipes.lock();
    if recipes.is_empty() {
        return Ok(ToolOutcome::failed(
            ToolCategory::NotFound,
            "No genre recipes are loaded yet (corpus/genres/ is empty).",
        ));
    }

    let query = input["genre"].as_str().unwrap_or("").trim();
    if query.is_empty() {
        // List mode.
        let mut s = String::from("Genre recipes available (call genre_recipe with one):\n");
        for r in recipes.iter() {
            let bpm = r
                .bpm
                .map(|(lo, hi)| format!(" [{lo:.0}–{hi:.0} BPM]"))
                .unwrap_or_default();
            let sig = r.signature.as_deref().unwrap_or("");
            s.push_str(&format!("- {}{bpm} — {sig}\n", r.genre));
        }
        return Ok(ToolOutcome::ok(
            format!("{} recipe(s) available", recipes.len()),
            s,
        ));
    }

    let matches: Vec<_> = recipes.iter().filter(|r| r.matches(query)).collect();
    if matches.is_empty() {
        let names: Vec<&str> = recipes.iter().map(|r| r.genre.as_str()).collect();
        return Ok(ToolOutcome::failed(
            ToolCategory::NotFound,
            format!(
                "No recipe matches '{query}'. Available: {}.",
                names.join(", ")
            ),
        ));
    }
    let names: Vec<&str> = matches.iter().map(|r| r.genre.as_str()).collect();
    Ok(ToolOutcome::ok(
        format!("recipe: {}", names.join(", ")),
        matches
            .iter()
            .map(|r| format_recipe(r))
            .collect::<Vec<_>>()
            .join("\n\n---\n\n"),
    ))
}

/// Render a recipe as agent-readable markdown-ish text: constraints header,
/// then each section's prose + playable fragments, then sources.
fn format_recipe(r: &cycletron_corpus::Recipe) -> String {
    use std::fmt::Write;
    let mut s = String::new();

    let aliases = if r.aliases.is_empty() {
        String::new()
    } else {
        format!(" ({})", r.aliases.join(", "))
    };
    let _ = writeln!(s, "# {}{aliases}", r.genre);
    if let Some(sig) = &r.signature {
        let _ = writeln!(s, "{sig}");
    }
    let mut facts: Vec<String> = Vec::new();
    if let Some((lo, hi)) = r.bpm {
        facts.push(format!("BPM {lo:.0}–{hi:.0}"));
    }
    if let Some(sw) = r.swing {
        facts.push(format!("swing {sw}"));
    }
    if !r.scales.is_empty() {
        facts.push(format!("scales: {}", r.scales.join(", ")));
    }
    if !r.key_sounds.is_empty() {
        facts.push(format!("sounds: {}", r.key_sounds.join(", ")));
    }
    if !facts.is_empty() {
        let _ = writeln!(s, "{}", facts.join(" · "));
    }
    if !r.artists.is_empty() {
        let _ = writeln!(s, "Artists: {}", r.artists.join(", "));
    }

    for sec in &r.sections {
        let _ = writeln!(s, "\n## {}", sec.title);
        if !sec.prose.is_empty() {
            let _ = writeln!(s, "{}", sec.prose);
        }
        for frag in &sec.fragments {
            let _ = writeln!(s, "```strudel\n{}\n```", frag.code);
        }
    }

    if !r.sources.is_empty() {
        let _ = writeln!(s, "\nSources: {}", r.sources.join(", "));
    }
    s
}

#[cfg(test)]
mod generator_inference_tests {
    use super::infer_generator;
    use serde_json::json;

    #[test]
    fn infers_generator_from_the_param_present() {
        // The failure the local-model eval caught: genre set, discriminator omitted.
        assert_eq!(infer_generator(&json!({"genre": "acid-house"})), "genre");
        assert_eq!(infer_generator(&json!({"hex": "a4f2"})), "hexbeat");
        assert_eq!(infer_generator(&json!({"motif": "c4 e4 g4"})), "palindrome");
        assert_eq!(infer_generator(&json!({"numerals": "ii V I"})), "numerals");
        assert_eq!(infer_generator(&json!({"rule": 90})), "automaton");
        assert_eq!(infer_generator(&json!({"count": 16})), "infinity");
        // explicit discriminator still wins; empty defaults to genre.
        assert_eq!(infer_generator(&json!({"generator": "hexbeat"})), "hexbeat");
        assert_eq!(infer_generator(&json!({})), "genre");
    }
}
