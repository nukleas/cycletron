//! The canonical list of agent tool names. Definitions (this crate) and
//! dispatch (the app's agent loop) both key off this enum, so a rename is a
//! single-point change and a tool added here without a dispatch arm is a
//! compile error (the dispatch match is exhaustive with no wildcard).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolName {
    SearchCorpus,
    GetExample,
    ListLibrary,
    SearchLibrary,
    ReadSong,
    SaveSong,
    SaveCurrentAs,
    RenameSong,
    MoveSong,
    NewFolder,
    ListSounds,
    ListMethods,
    GeneratePattern,
    ValidatePattern,
    ReviewPattern,
    InspectPattern,
    AnalyzeArrangement,
    CritiquePattern,
    CritiqueForm,
    GenreRecipe,
    PlayPattern,
    ListParts,
    ListSections,
    UpsertTrack,
    UpsertTracks,
    UpsertSection,
    UpsertSections,
    UpsertBinding,
    MuteTrack,
    UnmuteTrack,
    Stop,
    SetTempo,
}

impl ToolName {
    pub const ALL: [ToolName; 32] = [
        ToolName::SearchCorpus,
        ToolName::GetExample,
        ToolName::ListLibrary,
        ToolName::SearchLibrary,
        ToolName::ReadSong,
        ToolName::SaveSong,
        ToolName::SaveCurrentAs,
        ToolName::RenameSong,
        ToolName::MoveSong,
        ToolName::NewFolder,
        ToolName::ListSounds,
        ToolName::ListMethods,
        ToolName::GeneratePattern,
        ToolName::ValidatePattern,
        ToolName::ReviewPattern,
        ToolName::InspectPattern,
        ToolName::AnalyzeArrangement,
        ToolName::CritiquePattern,
        ToolName::CritiqueForm,
        ToolName::GenreRecipe,
        ToolName::PlayPattern,
        ToolName::ListParts,
        ToolName::ListSections,
        ToolName::UpsertTrack,
        ToolName::UpsertTracks,
        ToolName::UpsertSection,
        ToolName::UpsertSections,
        ToolName::UpsertBinding,
        ToolName::MuteTrack,
        ToolName::UnmuteTrack,
        ToolName::Stop,
        ToolName::SetTempo,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ToolName::SearchCorpus => "search_corpus",
            ToolName::GetExample => "get_example",
            ToolName::ListLibrary => "list_library",
            ToolName::SearchLibrary => "search_library",
            ToolName::ReadSong => "read_song",
            ToolName::SaveSong => "save_song",
            ToolName::SaveCurrentAs => "save_current_as",
            ToolName::RenameSong => "rename_song",
            ToolName::MoveSong => "move_song",
            ToolName::NewFolder => "new_folder",
            ToolName::ListSounds => "list_sounds",
            ToolName::ListMethods => "list_methods",
            ToolName::GeneratePattern => "generate_pattern",
            ToolName::ValidatePattern => "validate_pattern",
            ToolName::ReviewPattern => "review_pattern",
            ToolName::InspectPattern => "inspect_pattern",
            ToolName::AnalyzeArrangement => "analyze_arrangement",
            ToolName::CritiquePattern => "critique_pattern",
            ToolName::CritiqueForm => "critique_form",
            ToolName::GenreRecipe => "genre_recipe",
            ToolName::PlayPattern => "play_pattern",
            ToolName::ListParts => "list_parts",
            ToolName::ListSections => "list_sections",
            ToolName::UpsertTrack => "upsert_track",
            ToolName::UpsertTracks => "upsert_tracks",
            ToolName::UpsertSection => "upsert_section",
            ToolName::UpsertSections => "upsert_sections",
            ToolName::UpsertBinding => "upsert_binding",
            ToolName::MuteTrack => "mute_track",
            ToolName::UnmuteTrack => "unmute_track",
            ToolName::Stop => "stop",
            ToolName::SetTempo => "set_tempo",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|t| t.as_str() == s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every definition names an enum variant, every variant has a definition,
    /// and no name appears twice — the drift the enum exists to prevent.
    #[test]
    fn definitions_and_enum_agree() {
        let defs = crate::tools::music_tool_definitions();
        assert_eq!(defs.len(), ToolName::ALL.len(), "definition count vs enum count");
        let mut seen = std::collections::HashSet::new();
        for d in defs {
            assert!(
                ToolName::parse(&d.name).is_some(),
                "definition '{}' has no ToolName variant",
                d.name
            );
            assert!(seen.insert(d.name.as_str()), "duplicate definition '{}'", d.name);
        }
    }
}
