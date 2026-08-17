//! Mini-notation as a typed tree — "strudel in reverse".
//!
//! The strudel-rs pipeline goes `string -> parse -> Pattern -> events`. This
//! module goes the other way: build a [`Mini`] tree from musical intent and
//! *emit* a string the parser accepts. Because the tree is structured, the
//! emitter can never produce a malformed string (unbalanced brackets, a lane
//! with the wrong step count) — correctness is enforced by construction, not by
//! hoping a hand-written string is right.
//!
//! Pair this with [`crate::verify`] to close the loop: emit → parse-back →
//! confirm the events match what you built.

/// A node in a mini-notation tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mini {
    /// A bare token: `bd`, `c3`, `0`. Caller guarantees it is a legal atom.
    Atom(String),
    /// Rest / silence — `~`.
    Rest,
    /// Space-separated sequence (fastcat): the slots divide the cycle evenly.
    Seq(Vec<Mini>),
    /// Comma-separated parallel layers (stack).
    Stack(Vec<Mini>),
    /// Angle-bracket alternation (slowcat): one element per cycle, `<a b c>`.
    Alt(Vec<Mini>),
    /// An explicit `[ ... ]` group (compresses its contents into one slot).
    Group(Box<Mini>),
    /// Speed up in place: `x*n`.
    Fast(Box<Mini>, u32),
    /// Slow down: `x/n`.
    Slow(Box<Mini>, u32),
    /// Replicate in place: `x!n` — expands to `n` copies occupying `n` slots
    /// (so inside `< >` it spans `n` cycles). The compressor's run-length tool.
    Replicate(Box<Mini>, u32),
    /// Euclid / Bjorklund: `x(k,n)` or `x(k,n,rot)`.
    Euclid {
        base: Box<Mini>,
        k: u32,
        n: u32,
        rot: u32,
    },
}

impl Mini {
    /// A sound/note atom from anything string-like.
    pub fn atom(s: impl Into<String>) -> Self {
        Mini::Atom(s.into())
    }

    /// Number of top-level slots this node occupies in a sequence (1 unless it
    /// is a bare `Seq`, which spreads its children).
    fn is_compound(&self) -> bool {
        matches!(self, Mini::Seq(_) | Mini::Stack(_))
    }

    /// Emit a standalone mini-notation string (no surrounding quotes).
    pub fn emit(&self) -> String {
        match self {
            Mini::Atom(s) => s.clone(),
            Mini::Rest => "~".to_string(),
            Mini::Seq(items) => items
                .iter()
                .map(Mini::emit_slot)
                .collect::<Vec<_>>()
                .join(" "),
            Mini::Stack(items) => items.iter().map(Mini::emit).collect::<Vec<_>>().join(", "),
            Mini::Alt(items) => {
                let inner = items
                    .iter()
                    .map(Mini::emit_slot)
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("<{inner}>")
            }
            Mini::Group(inner) => format!("[{}]", inner.emit()),
            Mini::Fast(b, n) => format!("{}*{n}", b.emit_slot()),
            Mini::Slow(b, n) => format!("{}/{n}", b.emit_slot()),
            Mini::Replicate(b, n) => format!("{}!{n}", b.emit_slot()),
            Mini::Euclid { base, k, n, rot } => {
                if *rot == 0 {
                    format!("{}({k},{n})", base.emit_slot())
                } else {
                    format!("{}({k},{n},{rot})", base.emit_slot())
                }
            }
        }
    }

    /// Emit as a single sequence slot — wraps compound forms (`Seq`, `Stack`) in
    /// brackets so they occupy exactly one slot. Self-delimiting forms (`Alt`,
    /// `Group`) and single tokens pass through unbracketed.
    fn emit_slot(&self) -> String {
        if self.is_compound() {
            format!("[{}]", self.emit())
        } else {
            self.emit()
        }
    }

    /// Wrap in a `note("…")` document fragment (for melodic material).
    pub fn as_note(&self) -> String {
        format!("note(\"{}\")", self.emit())
    }

    /// Wrap in an `s("…")` document fragment (for sounds).
    pub fn as_sound(&self) -> String {
        format!("s(\"{}\")", self.emit())
    }
}

#[cfg(test)]
mod tests {
    use super::Mini::*;
    use super::*;

    #[test]
    fn emits_flat_sequence() {
        let m = Seq(vec![Mini::atom("bd"), Rest, Mini::atom("sd"), Rest]);
        assert_eq!(m.emit(), "bd ~ sd ~");
    }

    #[test]
    fn brackets_nested_sequence() {
        // A Seq inside a Seq must occupy one slot → [ ].
        let inner = Seq(vec![Mini::atom("bd"), Mini::atom("bd")]);
        let m = Seq(vec![Mini::atom("bd"), inner, Rest]);
        assert_eq!(m.emit(), "bd [bd bd] ~");
    }

    #[test]
    fn emits_stack_alt_fast_euclid() {
        assert_eq!(
            Stack(vec![Mini::atom("bd"), Mini::atom("hh")]).emit(),
            "bd, hh"
        );
        assert_eq!(
            Alt(vec![Mini::atom("c3"), Mini::atom("e3")]).emit(),
            "<c3 e3>"
        );
        assert_eq!(Fast(Box::new(Mini::atom("hh")), 16).emit(), "hh*16");
        assert_eq!(
            Euclid {
                base: Box::new(Mini::atom("bd")),
                k: 3,
                n: 8,
                rot: 0
            }
            .emit(),
            "bd(3,8)"
        );
    }
}
