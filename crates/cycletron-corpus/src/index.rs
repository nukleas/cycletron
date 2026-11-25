use cycletron_core::types::*;
use std::path::{Path, PathBuf};
use tracing::info;

/// Lowercased copies of each entry's searchable fields, precomputed at load
/// time so `search()` allocates nothing per entry.
struct SearchKeys {
    tags: Vec<String>,
    sounds: Vec<String>,
    title: Option<String>,
    filename: String,
}

impl SearchKeys {
    fn of(e: &CorpusEntry) -> Self {
        Self {
            tags: e.tags.iter().map(|t| t.to_lowercase()).collect(),
            sounds: e.sounds.iter().map(|s| s.to_lowercase()).collect(),
            title: e.title.as_ref().map(|t| t.to_lowercase()),
            filename: e.filename.to_lowercase(),
        }
    }
}

/// In-memory corpus index backed by Vec. Fast enough for ~250 entries.
pub struct InMemoryCorpusIndex {
    entries: Vec<CorpusEntry>,
    /// `keys[i]` belongs to `entries[i]`.
    keys: Vec<SearchKeys>,
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
            let mut seen: std::collections::HashSet<String> =
                entries.iter().map(|e| e.id.clone()).collect();
            for entry in crate::loader::load_metadata(&metadata_path)? {
                if seen.insert(entry.id.clone()) {
                    entries.push(entry);
                }
            }
        } else {
            tracing::warn!("metadata index not found at {}", metadata_path.display());
        }

        info!("corpus loaded: {} entries", entries.len());

        let keys = entries.iter().map(SearchKeys::of).collect();
        Ok(Self {
            entries,
            keys,
            corpus_path: corpus_path.to_path_buf(),
        })
    }

    pub fn search(&self, query: &CorpusQuery) -> Vec<CorpusEntry> {
        let limit = query.limit.unwrap_or(5);

        // Lowercase the query ONCE; entry-side casing was normalized at load.
        let q_tags: Vec<String> = query.tags.iter().map(|t| t.to_lowercase()).collect();
        let q_sounds: Vec<String> = query.sounds.iter().map(|s| s.to_lowercase()).collect();
        let q_keyword = query.keyword.as_ref().map(|k| k.to_lowercase());

        self.entries
            .iter()
            .zip(&self.keys)
            .filter(|(e, k)| {
                // Tag filter: entry must have ALL requested tags
                if !q_tags.is_empty()
                    && !q_tags
                        .iter()
                        .all(|t| k.tags.iter().any(|et| et.contains(t)))
                {
                    return false;
                }

                // Tempo range filter
                if let Some(min) = query.tempo_min
                    && e.tempo.is_none_or(|t| t < min)
                {
                    return false;
                }
                if let Some(max) = query.tempo_max
                    && e.tempo.is_none_or(|t| t > max)
                {
                    return false;
                }

                // Complexity filter
                if let Some(ref c) = query.complexity
                    && e.complexity.as_ref() != Some(c)
                {
                    return false;
                }

                // Sounds filter: entry must have at least one matching sound
                if !q_sounds.is_empty()
                    && !q_sounds
                        .iter()
                        .any(|s| k.sounds.iter().any(|es| es.contains(s)))
                {
                    return false;
                }

                // Keyword filter: search in title, filename, and tags
                if let Some(ref kw) = q_keyword {
                    let in_title = k.title.as_ref().is_some_and(|t| t.contains(kw));
                    let in_filename = k.filename.contains(kw);
                    let in_tags = k.tags.iter().any(|t| t.contains(kw));
                    if !in_title && !in_filename && !in_tags {
                        return false;
                    }
                }

                true
            })
            .take(limit)
            .map(|(e, _)| e.clone())
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

#[cfg(test)]
mod tests {
    use super::*;
    use cycletron_core::types::{CorpusEntry, CorpusQuery};

    fn entry(
        id: &str,
        title: Option<&str>,
        tags: &[&str],
        tempo: Option<f64>,
        complexity: Option<&str>,
        sounds: &[&str],
    ) -> CorpusEntry {
        CorpusEntry {
            id: id.into(),
            filename: format!("{id}.strudel"),
            file_type: Some("strudel".into()),
            title: title.map(str::to_string),
            author: None,
            tags: tags.iter().map(|s| (*s).to_string()).collect(),
            tempo,
            complexity: complexity.map(str::to_string),
            sounds: sounds.iter().map(|s| (*s).to_string()).collect(),
            effects: Vec::new(),
            scales: Vec::new(),
            features: Vec::new(),
            source_code: Some(format!("// {id}\ns(\"bd\")")),
        }
    }

    fn index_of(entries: Vec<CorpusEntry>) -> InMemoryCorpusIndex {
        let keys = entries.iter().map(SearchKeys::of).collect();
        InMemoryCorpusIndex {
            entries,
            keys,
            corpus_path: PathBuf::new(),
        }
    }

    #[test]
    fn search_filters_by_tags_tempo_complexity_sounds_keyword_and_limit() {
        let idx = index_of(vec![
            entry(
                "house-1",
                Some("Warm Deep House"),
                &["house", "four-floor"],
                Some(124.0),
                Some("intermediate"),
                &["bd", "RolandTR909_hh"],
            ),
            entry(
                "dnb-1",
                Some("Liquid Roller"),
                &["dnb", "breakbeat"],
                Some(174.0),
                Some("complex"),
                &["bd", "sd", "gm_epiano1"],
            ),
            entry(
                "ambient-1",
                Some("Slow Pads"),
                &["ambient", "pads"],
                Some(80.0),
                Some("simple"),
                &["sine", "triangle"],
            ),
        ]);

        // Tag AND matching (case-insensitive)
        let res = idx.search(&CorpusQuery {
            tags: vec!["HOUSE".into(), "four".into()],
            ..Default::default()
        });
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].id, "house-1");

        // Tempo bounds
        let res = idx.search(&CorpusQuery {
            tempo_min: Some(100.0),
            tempo_max: Some(140.0),
            ..Default::default()
        });
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].id, "house-1");

        // Complexity
        let res = idx.search(&CorpusQuery {
            complexity: Some("simple".into()),
            ..Default::default()
        });
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].id, "ambient-1");

        // Sounds OR matching
        let res = idx.search(&CorpusQuery {
            sounds: vec!["epiano".into(), "triangle".into()],
            ..Default::default()
        });
        assert_eq!(res.len(), 2);

        // Keyword + limit
        let res = idx.search(&CorpusQuery {
            keyword: Some("liquid".into()),
            limit: Some(1),
            ..Default::default()
        });
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].id, "dnb-1");
        assert!(idx.get_source("dnb-1").unwrap().contains("dnb-1"));
        assert!(idx.get_source("missing").is_err());
    }

    #[test]
    fn curated_entries_deduplicate_colliding_bulk_ids() {
        let dir =
            std::env::temp_dir().join(format!("cycletron_corpus_dedup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let curated = dir.join("curated");
        let bulk = dir.join("bulk");
        std::fs::create_dir_all(curated.join("rhythm")).unwrap();
        std::fs::create_dir_all(bulk.join("inventory")).unwrap();
        std::fs::write(
            curated.join("rhythm/beat.strudel"),
            "// Curated\ns(\"bd*4\")\n",
        )
        .unwrap();
        let bulk_line = serde_json::json!({
            "id": "curated/rhythm/beat",
            "filename": "beat.strudel",
            "file_type": "strudel",
            "content_kind": "code",
            "title": "Bulk Duplicate",
            "tags": ["rhythm"],
        });
        std::fs::write(
            bulk.join("inventory/normalized-metadata.jsonl"),
            format!("{bulk_line}\n"),
        )
        .unwrap();

        let idx = InMemoryCorpusIndex::load_with_curated(&bulk, Some(&curated)).unwrap();
        let all = idx.search(&CorpusQuery {
            limit: Some(10),
            ..Default::default()
        });
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title.as_deref(), Some("Curated"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
