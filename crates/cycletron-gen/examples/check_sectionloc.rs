use strudel_core::{ContextKey, Value};
fn main() {
    let doc = "let g = s(\"bd sd\");\narrange([2, g], [1, s(\"hh\")])";
    let file = strudel_dsl::parse_strudel_file(doc).unwrap();
    let out = strudel_dsl::evaluate_file(file).unwrap();
    let haps = out.pattern.query_arc(0i32, 1i32);
    let g_off = doc.find("[2, g]").unwrap() + 4;
    let sec: Vec<_> = haps.iter().filter_map(|h| match h.context.get(&ContextKey::SectionLoc) {
        Some(Value::Location(l)) => Some((l.start(), l.end())), _ => None }).collect();
    let note = haps.iter().filter(|h| h.context.get(&ContextKey::Locations).is_some()).count();
    println!("`g` reference is at doc offset {g_off}");
    println!("SectionLoc stamps on active haps: {sec:?}");
    println!("note-level Locations present on {note}/{} haps", haps.len());
    assert!(sec.iter().any(|(s, _)| *s == g_off), "section loc must point at `g`");
    assert!(note > 0, "note locations must still be present");
    println!("\nTWO-LEVEL LOCATIONS: OK");
}
