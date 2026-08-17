//! Regenerate the per-genre example `.strudel` files under `corpus/genres/<g>/`
//! from the verified composers. Every file is validated before it is written.
//! Run: `cargo run -p cycletron-gen --example regen_corpus`.

use cycletron_gen::compose;
use std::path::PathBuf;

fn main() {
    // crates/cycletron-gen → repo root → corpus/genres
    let genres_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root")
        .join("corpus/genres");

    let seed = 7; // fixed → reproducible corpus
    let mut wrote = 0;
    for (folder, res) in compose::all(seed) {
        let piece = match res {
            Ok(p) => p,
            Err(e) => {
                eprintln!("SKIP {folder}: {e}");
                continue;
            }
        };
        let dir = genres_dir.join(&folder);
        std::fs::create_dir_all(&dir).expect("mkdir genre");
        let path = dir.join(format!("generated-{folder}.strudel"));
        std::fs::write(&path, piece.to_strudel()).expect("write");
        println!("wrote {}", path.display());
        wrote += 1;
    }
    println!("\n{wrote} genre example(s) regenerated (seed {seed}).");
}
