use cycletron_core::types::*;
use std::path::{Path, PathBuf};
use tracing::info;

/// In-memory corpus index backed by Vec. Fast enough for ~250 entries.
pub struct InMemoryCorpusIndex {
    entries: Vec<CorpusEntry>,
    corpus_path: PathBuf,
}

impl InMemoryCorpusIndex {
    /// Load corpus from the filesystem.
    pub fn load(corpus_path: &Path) -> anyhow::Result<Self> {
        Self::load_with_curated(corpus_path, None)
    }

    /// Load corpus from the filesystem, optionally merging in a hand-curated
    /// directory. Curated entries are loaded first so they have priority when
    /// IDs collide.
    pub fn load_with_curated(
        corpus_path: &Path,
        curated_path: Option<&Path>,
    ) -> anyhow::Result<Self> {
        let mut entries: Vec<CorpusEntry> = Vec::new();

        if let Some(curated) = curated_path {
            if curated.exists() {
                let curated_entries = crate::loader::load_curated_dir(curated)?;
                info!(
                    "curated corpus: {} entries from {}",
                    curated_entries.len(),
                    curated.display()
                );
                entries.extend(curated_entries);
            } else {
                tracing::warn!("curated corpus dir not found at {}", curated.display());
            }
        }

        let metadata_path = corpus_path.join("inventory/normalized-metadata.jsonl");

        if metadata_path.exists() {
            entries.extend(crate::loader::load_metadata(&metadata_path)?);
        } else {
            tracing::warn!("metadata index not found at {}", metadata_path.display());
        }

        info!("corpus loaded: {} entries", entries.len());

        Ok(Self {
            entries,
            corpus_path: corpus_path.to_path_buf(),
        })
    }

    pub fn search(&self, query: &CorpusQuery) -> Vec<CorpusEntry> {
        let limit = query.limit.unwrap_or(5);

        self.entries
            .iter()
            .filter(|e| {
                // Tag filter: entry must have ALL requested tags
                if !query.tags.is_empty()
                    && !query.tags.iter().all(|t| {
                        e.tags
                            .iter()
                            .any(|et| et.to_lowercase().contains(&t.to_lowercase()))
                    })
                {
                    return false;
                }

                // Tempo range filter
                if let Some(min) = query.tempo_min {
                    if e.tempo.map_or(true, |t| t < min) {
                        return false;
                    }
                }
                if let Some(max) = query.tempo_max {
                    if e.tempo.map_or(true, |t| t > max) {
                        return false;
                    }
                }

                // Complexity filter
                if let Some(ref c) = query.complexity {
                    if e.complexity.as_ref().map_or(true, |ec| ec != c) {
                        return false;
                    }
                }

                // Sounds filter: entry must have at least one matching sound
                if !query.sounds.is_empty()
                    && !query.sounds.iter().any(|s| {
                        e.sounds
                            .iter()
                            .any(|es| es.to_lowercase().contains(&s.to_lowercase()))
                    })
                {
                    return false;
                }

                // Keyword filter: search in title, filename, and tags
                if let Some(ref kw) = query.keyword {
                    let kw_lower = kw.to_lowercase();
                    let in_title = e
                        .title
                        .as_ref()
                        .map_or(false, |t| t.to_lowercase().contains(&kw_lower));
                    let in_filename = e.filename.to_lowercase().contains(&kw_lower);
                    let in_tags = e.tags.iter().any(|t| t.to_lowercase().contains(&kw_lower));
                    if !in_title && !in_filename && !in_tags {
                        return false;
                    }
                }

                true
            })
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&CorpusEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn get_source(&self, id: &str) -> cycletron_core::Result<String> {
        let entry = self
            .get(id)
            .ok_or_else(|| cycletron_core::Error::Corpus(format!("entry not found: {id}")))?;
        // Curated entries carry their source inline — no disk hit needed.
        if let Some(src) = &entry.source_code {
            return Ok(src.clone());
        }
        crate::loader::load_source(&self.corpus_path, &entry.filename)
            .map_err(|e| cycletron_core::Error::Corpus(e.to_string()))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
