//! Section-level compression: a song is a *timeline of section labels* plus the
//! section definitions. Repeated sections are defined once and referenced by
//! label, and the timeline itself is run-length compressed — so a form like
//! intro / A / A / B / A / A / B collapses to `<i a!2 b a!2 b>` over four unique
//! section bodies. Emitted as strudel `pickRestart` (the form mechanism), with
//! `.slow(n)` giving each section `n` cycles.
//!
//! This composes with [`crate::factor`]: each voice *inside* a section body is a
//! bar sequence compressed the same way, so both levels of repetition are
//! factored out.

use crate::factor;
use crate::mini::Mini;

/// A named section: `label` is referenced from the timeline; `body` is the
/// pattern expression (e.g. a `stack(...)` or `note(...)` string).
pub struct Section {
    pub label: String,
    pub body: String,
}

/// A song as a compressed arrangement.
pub struct Song {
    pub title: String,
    pub bpm: u32,
    /// Cycles each section lasts (`.slow(n)`).
    pub section_cycles: u32,
    /// Unique section definitions.
    pub sections: Vec<Section>,
    /// The arrangement: one label per section slot, in order.
    pub timeline: Vec<String>,
}

impl Song {
    /// The run-length-compressed section timeline (e.g. `<i a!2 b>`).
    pub fn timeline_mini(&self) -> Mini {
        let bars: Vec<Mini> = self.timeline.iter().map(Mini::atom).collect();
        factor::compress(&bars)
    }

    /// Emit the compressed `.strudel` document.
    pub fn to_strudel(&self) -> String {
        let timeline = self.timeline_mini().emit();
        let defs = self
            .sections
            .iter()
            .map(|s| format!("    {}: {}", s.label, s.body))
            .collect::<Vec<_>>()
            .join(",\n");
        format!(
            "// {}\nsetbpm({});\n\n\"{}\"\n  .slow({})\n  .pickRestart({{\n{}\n  }})\n",
            self.title, self.bpm, timeline, self.section_cycles, defs
        )
    }

    /// Characters in the emitted document vs. a fully-expanded arrangement
    /// (timeline written out with every section body inlined at each slot).
    pub fn ratio(&self) -> (usize, usize) {
        let compressed = self.to_strudel().len();
        // Expanded: every timeline slot inlines its whole body, no reuse.
        let body_of = |label: &str| {
            self.sections
                .iter()
                .find(|s| s.label == label)
                .map(|s| s.body.len())
                .unwrap_or(0)
        };
        let expanded: usize = self.timeline.iter().map(|l| body_of(l)).sum::<usize>()
            + self.timeline.len() * 6; // rough per-slot separator overhead
        (expanded, compressed)
    }
}

/// Chunk a bar sequence into fixed-length sections, dedup identical sections,
/// and build a [`Song`]. Each section becomes a `<bars>` slowcat wrapped by
/// `wrap` (e.g. `|b| format!("s(\"{b}\")")`), played `section_len` cycles via
/// `.slow(section_len)`. Recurring sections are defined once; the label timeline
/// is run-length compressed. Lossless: with `.slow(section_len)` each picked
/// section replays its own bars in order.
pub fn sectionize(
    title: &str,
    bpm: u32,
    bars: &[Mini],
    section_len: usize,
    wrap: impl Fn(&str) -> String,
) -> Song {
    let mut sections: Vec<Section> = Vec::new();
    let mut timeline: Vec<String> = Vec::new();
    for chunk in bars.chunks(section_len.max(1)) {
        let wrapped = wrap(&Mini::Alt(chunk.to_vec()).emit());
        let label = match sections.iter().find(|s| s.body == wrapped) {
            Some(s) => s.label.clone(),
            None => {
                let l = format!("s{}", sections.len());
                sections.push(Section {
                    label: l.clone(),
                    body: wrapped,
                });
                l
            }
        };
        timeline.push(label);
    }
    Song {
        title: title.into(),
        bpm,
        section_cycles: section_len as u32,
        sections,
        timeline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_song() -> Song {
        // Realistic bodies (multi-voice stacks) reused across a long form — the
        // case where section reuse actually pays for the pickRestart wrapper.
        let verse = "stack(s(\"bd ~ ~ bd ~ ~ bd ~\"), note(\"c2 ~ g2 ~\").s(\"sawtooth\").lpf(600))";
        let chorus = "stack(s(\"bd*4, ~ cp ~ cp, hh*8\"), note(\"<c3 g3 a3 f3>\").s(\"sawtooth\").lpf(1200))";
        Song {
            title: "test form".into(),
            bpm: 120,
            section_cycles: 4,
            sections: vec![
                Section { label: "i".into(), body: "s(\"bd*4\")".into() },
                Section { label: "a".into(), body: verse.into() },
                Section { label: "b".into(), body: chorus.into() },
            ],
            // intro, then verse/chorus repeated many times → heavy reuse.
            timeline: ["i", "a", "a", "b", "a", "a", "b", "a", "a", "b"]
                .map(String::from)
                .to_vec(),
        }
    }

    #[test]
    fn timeline_run_length_compresses() {
        let s = demo_song();
        // i a a b a a b → period 3 after the intro? factor finds the loop.
        let tl = s.timeline_mini().emit();
        assert!(tl.contains('!'), "expected run-length compression, got {tl}");
        // and it reproduces the original label sequence
        let bars: Vec<Mini> = s.timeline.iter().map(Mini::atom).collect();
        assert!(crate::verify::reproduces(&bars, &s.timeline_mini()));
    }

    #[test]
    fn document_validates_and_saves_space() {
        let s = demo_song();
        crate::verify::validate_doc(&s.to_strudel())
            .expect("pickRestart document should play");
        let (expanded, compressed) = s.ratio();
        assert!(compressed < expanded, "{compressed} !< {expanded}");
    }
}
