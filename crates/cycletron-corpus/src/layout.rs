//! Corpus-tree layout policy: which files and directories the loaders (and
//! the corpus-check gate, demos, and recipe tooling) treat as content vs
//! staging/documentation. One place, so the rules can't drift.

use std::path::Path;

/// Markdown files that document a directory rather than being recipes
/// (`README.md`, `_template.md`, …).
pub fn is_doc_file(path: &Path) -> bool {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(|stem| stem.starts_with('_') || stem.eq_ignore_ascii_case("readme"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_files_detected() {
        assert!(is_doc_file(Path::new("corpus/genres/README.md")));
        assert!(is_doc_file(Path::new("corpus/genres/_template.md")));
        assert!(!is_doc_file(Path::new("corpus/genres/house.md")));
    }
}
