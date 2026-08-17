//! Corpus-tree layout policy: which files and directories the loaders (and
//! the corpus-check gate, demos, and recipe tooling) treat as content vs
//! staging/documentation. One place, so the rules can't drift.

use std::path::Path;

/// `_`-prefixed path components mark staging/scratch areas (`corpus/_examples`,
/// `genres/_drafts`) that hold unpicked candidates: no loader, gate, or demo
/// seeding should pick them up. `rel` must be relative to the corpus root.
pub fn is_underscore_hidden(rel: &Path) -> bool {
    rel.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('_'))
}

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
    fn underscore_components_hide() {
        assert!(is_underscore_hidden(Path::new("_examples/x.strudel")));
        assert!(is_underscore_hidden(Path::new("genres/_drafts/x.strudel")));
        assert!(!is_underscore_hidden(Path::new(
            "rhythm/four_floor.strudel"
        )));
    }

    #[test]
    fn doc_files_detected() {
        assert!(is_doc_file(Path::new("corpus/genres/README.md")));
        assert!(is_doc_file(Path::new("corpus/genres/_template.md")));
        assert!(!is_doc_file(Path::new("corpus/genres/house.md")));
    }
}
