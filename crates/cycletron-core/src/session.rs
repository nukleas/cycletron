use crate::types::*;
use chrono::Utc;
use std::path::PathBuf;
use uuid::Uuid;

/// Manages the state of a single composition session.
pub struct Session {
    pub id: String,
    pub messages: Vec<ChatMessage>,
    pub current_pattern: Option<String>,
    pub pattern_history: Vec<PatternEntry>,
    pub tempo: f64,
    pub playback: PlaybackState,
    /// Index into pattern_history for undo/redo.
    history_index: Option<usize>,
    /// Path of the file currently backing this session, if any.
    pub file_path: Option<PathBuf>,
    /// Code content as it was last written to / read from disk.
    /// Used to detect unsaved changes (dirty state).
    pub last_saved_snapshot: Option<String>,
}

/// An entry in the pattern history.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PatternEntry {
    pub id: String,
    pub code: String,
    pub label: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub source: PatternSource,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatternSource {
    Ai,
    User,
    Corpus,
}

impl Session {
    pub fn new(default_tempo: f64) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            messages: Vec::new(),
            current_pattern: None,
            pattern_history: Vec::new(),
            tempo: default_tempo,
            playback: PlaybackState::Stopped,
            history_index: None,
            file_path: None,
            last_saved_snapshot: None,
        }
    }

    /// Record that the session's working code was persisted to `path`.
    pub fn mark_saved(&mut self, path: PathBuf, code: String) {
        self.file_path = Some(path);
        self.last_saved_snapshot = Some(code.clone());
        self.current_pattern = Some(code);
    }

    /// Load external code into the session as the current buffer.
    /// `path` is set when the code comes from a file (so Save reuses it).
    pub fn load_code(&mut self, code: String, path: Option<PathBuf>) {
        self.file_path = path;
        self.last_saved_snapshot = Some(code.clone());
        self.current_pattern = Some(code);
    }

    /// Reset to a blank in-memory buffer with no backing file.
    pub fn new_file(&mut self) {
        self.file_path = None;
        self.last_saved_snapshot = None;
        self.current_pattern = None;
        self.pattern_history.clear();
        self.history_index = None;
    }

    pub fn add_user_message(&mut self, content: String) -> &ChatMessage {
        self.messages.push(ChatMessage {
            id: Uuid::new_v4().to_string(),
            role: ChatRole::User,
            content,
            timestamp: Utc::now(),
            tools: Vec::new(),
        });
        self.messages.last().unwrap()
    }

    pub fn add_assistant_message(&mut self, content: String) -> &ChatMessage {
        self.add_assistant_message_with_tools(content, Vec::new())
    }

    /// A line shown in the transcript but never sent to the model, such as
    /// "the reply was cut off".
    pub fn add_system_message(&mut self, content: String) -> &ChatMessage {
        self.messages.push(ChatMessage {
            id: Uuid::new_v4().to_string(),
            role: ChatRole::System,
            content,
            timestamp: Utc::now(),
            tools: Vec::new(),
        });
        self.messages.last().unwrap()
    }

    /// Record an assistant turn together with the compact [`ToolTrace`]s it
    /// produced, so the tool exchange survives into later turns' context instead
    /// of collapsing to text-only.
    pub fn add_assistant_message_with_tools(
        &mut self,
        content: String,
        tools: Vec<ToolTrace>,
    ) -> &ChatMessage {
        self.messages.push(ChatMessage {
            id: Uuid::new_v4().to_string(),
            role: ChatRole::Assistant,
            content,
            timestamp: Utc::now(),
            tools,
        });
        self.messages.last().unwrap()
    }

    pub fn set_pattern(&mut self, code: String) {
        self.push_pattern(code.clone(), "pattern", PatternSource::Ai);
        self.current_pattern = Some(code);
    }

    pub fn set_pattern_from_user(&mut self, code: String) {
        self.push_pattern(code.clone(), "user edit", PatternSource::User);
        self.current_pattern = Some(code);
    }

    fn push_pattern(&mut self, code: String, label: &str, source: PatternSource) {
        // Truncate any redo history
        if let Some(idx) = self.history_index {
            self.pattern_history.truncate(idx + 1);
        }

        let entry = PatternEntry {
            id: Uuid::new_v4().to_string(),
            code,
            label: label.to_string(),
            timestamp: Utc::now(),
            source,
        };
        self.pattern_history.push(entry);
        self.history_index = Some(self.pattern_history.len() - 1);
    }

    /// Undo to previous pattern. Returns the pattern code if available.
    pub fn undo(&mut self) -> Option<&str> {
        let idx = self.history_index?;
        if idx == 0 {
            return None;
        }
        self.history_index = Some(idx - 1);
        let code = &self.pattern_history[idx - 1].code;
        self.current_pattern = Some(code.clone());
        Some(code)
    }

    /// Redo to next pattern. Returns the pattern code if available.
    pub fn redo(&mut self) -> Option<&str> {
        let idx = self.history_index?;
        if idx + 1 >= self.pattern_history.len() {
            return None;
        }
        self.history_index = Some(idx + 1);
        let code = &self.pattern_history[idx + 1].code;
        self.current_pattern = Some(code.clone());
        Some(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undo_redo_and_branch_truncation() {
        let mut s = Session::new(120.0);
        assert_eq!(s.undo(), None);
        assert_eq!(s.redo(), None);

        s.set_pattern("s(\"bd\")".into());
        s.set_pattern_from_user("s(\"bd sd\")".into());
        s.set_pattern("s(\"bd sd hh\")".into());

        assert_eq!(s.undo(), Some("s(\"bd sd\")"));
        assert_eq!(s.current_pattern.as_deref(), Some("s(\"bd sd\")"));
        assert_eq!(s.undo(), Some("s(\"bd\")"));
        assert_eq!(s.undo(), None);

        assert_eq!(s.redo(), Some("s(\"bd sd\")"));
        // Pushing a new pattern discards the future redo branch.
        s.set_pattern("s(\"cp*4\")".into());
        assert_eq!(s.redo(), None);
        assert_eq!(s.pattern_history.len(), 3);
        assert_eq!(s.undo(), Some("s(\"bd sd\")"));
    }

    #[test]
    fn file_lifecycle_and_messages() {
        let mut s = Session::new(128.0);
        s.load_code(
            "setbpm(128);\ns(\"bd*4\")".into(),
            Some(PathBuf::from("/a.strudel")),
        );
        assert_eq!(
            s.file_path.as_deref(),
            Some(std::path::Path::new("/a.strudel"))
        );
        assert_eq!(s.last_saved_snapshot, s.current_pattern);

        s.mark_saved(PathBuf::from("/b.strudel"), "s(\"hh*8\")".into());
        assert_eq!(
            s.file_path.as_deref(),
            Some(std::path::Path::new("/b.strudel"))
        );
        assert_eq!(s.last_saved_snapshot.as_deref(), Some("s(\"hh*8\")"));

        s.add_user_message("hi".into());
        s.add_assistant_message("hello".into());
        s.add_system_message("notice".into());
        assert_eq!(s.messages.len(), 3);

        s.set_pattern("s(\"sd\")".into());
        s.new_file();
        assert!(s.file_path.is_none());
        assert!(s.current_pattern.is_none());
        assert!(s.pattern_history.is_empty());
        assert_eq!(s.undo(), None);
    }
}
