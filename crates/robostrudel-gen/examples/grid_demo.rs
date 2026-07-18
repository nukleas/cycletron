//! Build a full genre piece from first principles — aligned drum grid, in-key
//! bass, diatonic chords, generated melody — all round-trip verified against the
//! real strudel-rs evaluator. Run: `cargo run -p robostrudel-gen --example grid_demo`.

use robostrudel_gen::grid::Grid;
use robostrudel_gen::melody::{self, Dir};
use robostrudel_gen::mini::Mini;
use robostrudel_gen::scale::Scale;
use robostrudel_gen::verify::{verify_grid, verify_notes};

fn main() {
    // --- Drums: DnB two-step on one 16-step grid (cannot misalign) ---
    let drums = Grid::new(16)
        .hit("bd", &[0, 10])
        .hit("sd", &[4, 12])
        .every("hh", 1, 0);
    let lanes = verify_grid(&drums).expect("drums round-trip");

    // --- Everything melodic is addressed by scale degree → always in key ---
    let scale = Scale::parse("c minor").unwrap();

    // Bass: root, then the flat-7 and 5th — degrees 0, 6, 4 — low octave.
    let bass_degs = [0, 0, 6, 4];
    let bass = scale.to_mini(&bass_degs, 2);
    verify_notes(&scale.notes(&bass_degs, 2), &bass.emit()).expect("bass round-trip");

    // Chords: diatonic seventh chords on i, VI, III, VII (degrees 0,5,2,6),
    // each a voiced note-stack in one slowcat slot → `<[c3, d#3, g3, a#3] …>`.
    let chord_roots = [0, 5, 2, 6];
    let chords = Mini::Alt(
        chord_roots
            .iter()
            .map(|&d| {
                let voiced = Mini::Stack(
                    scale.seventh(d, 3).into_iter().map(Mini::atom).collect(),
                );
                Mini::Group(Box::new(voiced))
            })
            .collect(),
    );

    // Melody: an arpeggio of the i chord, up two octaves, then a scalar answer.
    let arp = melody::arpeggio(&[0, 2, 4], 2, scale.len(), Dir::UpDown);
    let answer = melody::run(6, 4, -1); // descending line from the flat-7
    let mel_degs: Vec<i32> = arp.iter().chain(answer.iter()).copied().collect();
    let melody = scale.to_mini(&mel_degs, 4);
    verify_notes(&scale.notes(&mel_degs, 4), &melody.emit()).expect("melody round-trip");

    println!("── generated DnB piece in C minor (all parts round-trip verified) ──\n");
    println!("// drums: {lanes} lanes, all 16-step aligned");
    println!("setbpm(174);");
    println!("stack(");
    println!("  s(\"{}\").gain(0.9),", drums.to_string());
    println!("  {}.s(\"gm_synth_bass_1\").lpf(500).gain(0.6),", bass.as_note());
    println!("  note(\"{}\").s(\"gm_epiano1\").struct(\"~ 1 ~ 1\").release(0.2).gain(0.4),", chords.emit());
    println!("  {}.s(\"triangle\").gain(0.4).room(0.3)", melody.as_note());
    println!(")");
    println!("\n// bass notes:   {:?}", scale.notes(&bass_degs, 2));
    println!("// melody notes: {:?}", scale.notes(&mel_degs, 4));
}
