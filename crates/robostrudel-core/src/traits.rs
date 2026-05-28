use crate::types::*;

/// Trait for corpus index implementations.
/// Start with in-memory Vec<CorpusEntry>, upgrade to SQLite/embeddings later.
pub trait CorpusIndex: Send + Sync {
    /// Search the corpus with structured filters.
    fn search(&self, query: &CorpusQuery) -> Vec<CorpusEntry>;

    /// Get a single entry by ID.
    fn get(&self, id: &str) -> Option<&CorpusEntry>;

    /// Get the full source code for an entry.
    fn get_source(&self, id: &str) -> crate::Result<String>;

    /// Search for parts by musical role.
    fn search_parts(&self, role: MusicalRole, limit: usize) -> Vec<CorpusPart>;

    /// Total number of entries.
    fn len(&self) -> usize;

    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Trait for the three-tier memory system.
pub trait MemoryStore: Send + Sync {
    /// Recall memories for a given tier and optional context keyword.
    fn recall(&self, tier: MemoryTier, context: Option<&str>) -> Vec<Memory>;

    /// Record a new memory.
    fn record(&mut self, memory: Memory) -> crate::Result<()>;

    /// Get all Tier 1 (always-loaded) memories for prompt injection.
    fn always_loaded(&self) -> Vec<Memory> {
        self.recall(MemoryTier::AlwaysLoaded, None)
    }
}

/// Trait for the learning capture system.
pub trait LearningCapture: Send + Sync {
    /// Log a session outcome.
    fn log_outcome(&mut self, outcome: SessionOutcome) -> crate::Result<()>;

    /// Detect patterns that should be promoted (>= 3 successes, >= 2 sessions).
    fn detect_promotions(&self) -> Vec<PromotionCandidate>;
}

/// A candidate for promotion from session learning to permanent knowledge.
#[derive(Debug, Clone)]
pub struct PromotionCandidate {
    pub kind: PromotionKind,
    pub description: String,
    pub evidence_count: u32,
    pub session_count: u32,
}

#[derive(Debug, Clone)]
pub enum PromotionKind {
    /// Pattern should be added to gold set.
    GoldSet { pattern_code: String },
    /// User preference should be promoted to T1 memory.
    Preference { key: String, value: String },
    /// Prompt template should be updated.
    PromptRefinement {
        template_name: String,
        suggestion: String,
    },
}
