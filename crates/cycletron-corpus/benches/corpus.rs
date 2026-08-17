//! Benchmarks for corpus loading and search — the paths paid on every app
//! start / `reload_corpus` (load) and every agent `search_corpus` call.
//!
//! Run: `cargo bench -p cycletron-corpus --bench corpus`

use core::hint::black_box;
use std::path::Path;

use criterion::{Criterion, criterion_group, criterion_main};
use cycletron_core::types::CorpusQuery;
use cycletron_corpus::index::InMemoryCorpusIndex;
use cycletron_corpus::loader::load_curated_dir;

fn corpus_root() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus"))
}

fn query(tags: &[&str], sounds: &[&str], keyword: Option<&str>) -> CorpusQuery {
    CorpusQuery {
        tags: tags.iter().map(std::string::ToString::to_string).collect(),
        tempo_min: None,
        tempo_max: None,
        complexity: None,
        sounds: sounds
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
        keyword: keyword.map(std::string::ToString::to_string),
        limit: Some(5),
    }
}

fn bench_corpus(c: &mut Criterion) {
    let root = corpus_root();

    c.bench_function("load/curated_dir", |b| {
        b.iter(|| black_box(load_curated_dir(black_box(root)).unwrap()))
    });

    let index = InMemoryCorpusIndex::load_with_curated(root, Some(root)).unwrap();
    let mut group = c.benchmark_group("search");
    group.bench_function("tags", |b| {
        let q = query(&["techno", "curated"], &[], None);
        b.iter(|| black_box(index.search(black_box(&q))))
    });
    group.bench_function("sounds", |b| {
        let q = query(&[], &["bd"], None);
        b.iter(|| black_box(index.search(black_box(&q))))
    });
    group.bench_function("keyword", |b| {
        let q = query(&[], &[], Some("acid"));
        b.iter(|| black_box(index.search(black_box(&q))))
    });
    group.finish();
}

criterion_group!(benches, bench_corpus);
criterion_main!(benches);
