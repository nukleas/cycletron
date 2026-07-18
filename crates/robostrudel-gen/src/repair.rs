//! Re-Pair (Larsson & Moffat) grammar compression over a bar sequence.
//!
//! Where [`crate::factor`] only catches *consecutive* repeats, Re-Pair finds
//! recurring *phrases* wherever they occur. It repeatedly replaces the most
//! frequent adjacent pair of symbols with a new non-terminal, building a
//! straight-line grammar whose terminals are unique bars and whose rules are
//! recurring blocks. A song like Marble Machine — where an 8-bar groove returns
//! over and over between fills — collapses to "define the groove once, then
//! arrange references to it".
//!
//! The grammar is verified: [`Grammar::expand`] must reproduce the input bars.

use crate::mini::Mini;
use std::collections::HashMap;

/// A grammar symbol.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum Sym {
    /// Terminal: an index into [`Grammar::terminals`] (a unique bar).
    T(usize),
    /// Non-terminal: an index into [`Grammar::rules`] (a recurring phrase).
    N(usize),
}

/// A straight-line grammar: `start` expands (via `rules`) to the original bars.
pub struct Grammar {
    /// Unique bars, addressed by terminal index.
    pub terminals: Vec<Mini>,
    /// Each rule is a binary expansion `Nk → [a, b]` (Re-Pair rules are pairs).
    pub rules: Vec<[Sym; 2]>,
    /// The compressed top-level sequence.
    pub start: Vec<Sym>,
}

/// Run Re-Pair on a bar sequence.
pub fn repair(bars: &[Mini]) -> Grammar {
    // Intern bars → terminal symbols.
    let mut terminals: Vec<Mini> = Vec::new();
    let mut seq: Vec<Sym> = bars
        .iter()
        .map(|b| {
            let idx = terminals.iter().position(|t| t == b).unwrap_or_else(|| {
                terminals.push(b.clone());
                terminals.len() - 1
            });
            Sym::T(idx)
        })
        .collect();

    let mut rules: Vec<[Sym; 2]> = Vec::new();

    loop {
        // Count adjacent digrams (non-overlapping-safe: we replace greedily below).
        let mut counts: HashMap<(Sym, Sym), usize> = HashMap::new();
        for w in seq.windows(2) {
            *counts.entry((w[0], w[1])).or_default() += 1;
        }
        // Most frequent digram occurring at least twice.
        let best = counts
            .iter()
            .filter(|e| *e.1 >= 2)
            .max_by_key(|e| (*e.1, e.0.0, e.0.1))
            .map(|e| *e.0);
        let Some((a, b)) = best else { break };

        // New rule, then replace every non-overlapping (a,b) with it.
        let nt = Sym::N(rules.len());
        rules.push([a, b]);
        let mut next = Vec::with_capacity(seq.len());
        let mut i = 0;
        while i < seq.len() {
            if i + 1 < seq.len() && seq[i] == a && seq[i + 1] == b {
                next.push(nt);
                i += 2;
            } else {
                next.push(seq[i]);
                i += 1;
            }
        }
        seq = next;
    }

    Grammar {
        terminals,
        rules,
        start: seq,
    }
}

impl Grammar {
    /// Expand the grammar back to the full bar sequence.
    pub fn expand(&self) -> Vec<Mini> {
        let mut out = Vec::new();
        for &s in &self.start {
            self.expand_sym(s, &mut out);
        }
        out
    }

    fn expand_sym(&self, s: Sym, out: &mut Vec<Mini>) {
        match s {
            Sym::T(i) => out.push(self.terminals[i].clone()),
            Sym::N(i) => {
                let [a, b] = self.rules[i];
                self.expand_sym(a, out);
                self.expand_sym(b, out);
            }
        }
    }

    /// How many bars a symbol expands to (rule "length" in cycles).
    pub fn sym_len(&self, s: Sym) -> usize {
        match s {
            Sym::T(_) => 1,
            Sym::N(i) => {
                let [a, b] = self.rules[i];
                self.sym_len(a) + self.sym_len(b)
            }
        }
    }

    /// Grammar size in symbols: `|start| + Σ|rule bodies|`. The compression
    /// metric — compare to the number of input bars.
    pub fn size(&self) -> usize {
        self.start.len() + self.rules.len() * 2
    }

    /// Emit this voice as `let` phrase bindings + an `arrange(...)` call:
    /// recurring phrases (non-terminals used ≥2×) are defined once and
    /// referenced by name; the top level arranges them (and inline runs) with
    /// their cycle lengths. `wrap` turns a `<bars>` body into a pattern
    /// expression, e.g. `|b| format!("s(\"{b}\")")`.
    pub fn to_arrange(&self, wrap: &dyn Fn(&str) -> String) -> String {
        use std::collections::BTreeMap;
        let names: BTreeMap<usize, String> = self
            .reused_rules()
            .iter()
            .enumerate()
            .map(|(k, &(i, _, _))| (i, format!("p{k}")))
            .collect();

        let slowcat_body = |bars: Vec<Mini>| -> String {
            if bars.len() == 1 {
                bars.into_iter().next().unwrap().emit()
            } else {
                Mini::Alt(bars).emit()
            }
        };

        let mut out = String::new();
        for (&i, name) in &names {
            let mut bars = Vec::new();
            self.expand_sym(Sym::N(i), &mut bars);
            out.push_str(&format!("let {name} = {};\n", wrap(&slowcat_body(bars))));
        }

        let mut sections: Vec<String> = Vec::new();
        let mut pending: Vec<Mini> = Vec::new();
        for &s in &self.start {
            if let Sym::N(i) = s
                && let Some(name) = names.get(&i)
            {
                if !pending.is_empty() {
                    sections.push(format!(
                        "[{}, {}]",
                        pending.len(),
                        wrap(&slowcat_body(std::mem::take(&mut pending)))
                    ));
                }
                sections.push(format!("[{}, {name}]", self.sym_len(s)));
                continue;
            }
            self.expand_sym(s, &mut pending);
        }
        if !pending.is_empty() {
            sections.push(format!(
                "[{}, {}]",
                pending.len(),
                wrap(&slowcat_body(pending))
            ));
        }
        out.push_str(&format!("arrange({})", sections.join(", ")));
        out
    }

    /// Total reference count of each rule across `start` + all rule bodies.
    fn usage(&self) -> Vec<usize> {
        let mut u = vec![0usize; self.rules.len()];
        for &s in &self.start {
            if let Sym::N(i) = s {
                u[i] += 1;
            }
        }
        for r in &self.rules {
            for &s in r {
                if let Sym::N(i) = s {
                    u[i] += 1;
                }
            }
        }
        u
    }

    /// Choose which rules become named bindings: referenced ≥2× and spanning
    /// ≥`min_span` bars (naming a tiny phrase costs more than it saves).
    fn choose_names(
        &self,
        min_span: usize,
        prefix: &str,
    ) -> std::collections::BTreeMap<usize, String> {
        let usage = self.usage();
        let mut names = std::collections::BTreeMap::new();
        for i in 0..self.rules.len() {
            // Don't name pure-rest phrases — they inline compactly as `<-!n>`.
            if usage[i] >= 2 && self.sym_len(Sym::N(i)) >= min_span && !self.is_all_rest(Sym::N(i)) {
                let k = names.len();
                names.insert(i, format!("{prefix}{k}"));
            }
        }
        names
    }

    /// True if a symbol expands entirely to rest bars (`-`/`~`).
    fn is_all_rest(&self, sym: Sym) -> bool {
        match sym {
            Sym::T(i) => matches!(self.terminals[i].emit().as_str(), "-" | "~"),
            Sym::N(i) => {
                let [a, b] = self.rules[i];
                self.is_all_rest(a) && self.is_all_rest(b)
            }
        }
    }

    /// Cost-aware nested emit: phrase bindings that reference each other, so
    /// shared sub-phrases are written once, plus a top-level `arrange`.
    /// `prefix` namespaces the binding names (so multiple voices don't collide).
    pub fn to_arrange_nested(
        &self,
        wrap: &dyn Fn(&str) -> String,
        min_span: usize,
        prefix: &str,
    ) -> String {
        let names = self.choose_names(min_span, prefix);
        let mut out = String::new();
        // Bindings in ascending rule index → each references only earlier rules.
        for (&i, name) in &names {
            let [a, b] = self.rules[i];
            let body = self.render_syms(&[a, b], &names, wrap);
            out.push_str(&format!("let {name} = {body};\n"));
        }
        out.push_str(&self.render_syms(&self.start, &names, wrap));
        out
    }

    /// Render a symbol slice as a pattern expression: runs of inlined bars become
    /// `wrap("<bars>")`, named phrases become references, and mixed content is
    /// stitched with `arrange`.
    fn render_syms(
        &self,
        syms: &[Sym],
        names: &std::collections::BTreeMap<usize, String>,
        wrap: &dyn Fn(&str) -> String,
    ) -> String {
        enum Chunk {
            Bars(Vec<Mini>),
            Ref(String, usize),
        }
        let mut chunks: Vec<Chunk> = Vec::new();
        let mut push_bars = |chunks: &mut Vec<Chunk>, bar: Mini| {
            if let Some(Chunk::Bars(v)) = chunks.last_mut() {
                v.push(bar);
            } else {
                chunks.push(Chunk::Bars(vec![bar]));
            }
        };
        // Flatten: stop at named rules (emit a ref), inline everything else.
        fn walk(
            g: &Grammar,
            sym: Sym,
            names: &std::collections::BTreeMap<usize, String>,
            chunks: &mut Vec<Chunk>,
            push_bars: &mut dyn FnMut(&mut Vec<Chunk>, Mini),
        ) {
            match sym {
                Sym::T(i) => push_bars(chunks, g.terminals[i].clone()),
                Sym::N(i) => {
                    if let Some(name) = names.get(&i) {
                        chunks.push(Chunk::Ref(name.clone(), g.sym_len(sym)));
                    } else {
                        let [a, b] = g.rules[i];
                        walk(g, a, names, chunks, push_bars);
                        walk(g, b, names, chunks, push_bars);
                    }
                }
            }
        }
        for &s in syms {
            walk(self, s, names, &mut chunks, &mut push_bars);
        }

        let body_of = |bars: &[Mini]| -> String {
            if bars.len() == 1 {
                wrap(&bars[0].emit())
            } else {
                // run-length compress the slowcat: `<- - … ->` → `<-!16>`.
                wrap(&Mini::Alt(crate::factor::rle(bars)).emit())
            }
        };

        if chunks.len() == 1 {
            return match &chunks[0] {
                Chunk::Bars(b) => body_of(b),
                Chunk::Ref(name, _) => name.clone(),
            };
        }
        let sections: Vec<String> = chunks
            .iter()
            .map(|c| match c {
                Chunk::Bars(b) => format!("[{}, {}]", b.len(), body_of(b)),
                Chunk::Ref(name, cycles) => format!("[{cycles}, {name}]"),
            })
            .collect();
        format!("arrange({})", sections.join(", "))
    }

    /// Non-terminals actually referenced more than once (the phrases worth
    /// naming). Returns (rule index, times referenced, bars it spans).
    pub fn reused_rules(&self) -> Vec<(usize, usize, usize)> {
        let mut refs = vec![0usize; self.rules.len()];
        let mut bump = |s: Sym| {
            if let Sym::N(i) = s {
                refs[i] += 1;
            }
        };
        for &s in &self.start {
            bump(s);
        }
        let rule_syms: Vec<Sym> = self.rules.iter().flatten().copied().collect();
        for s in rule_syms {
            bump(s);
        }
        refs.iter()
            .enumerate()
            .filter(|(_, c)| **c >= 2)
            .map(|(i, &c)| (i, c, self.sym_len(Sym::N(i))))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars(v: &[&str]) -> Vec<Mini> {
        v.iter().map(|s| Mini::atom(*s)).collect()
    }

    #[test]
    fn grammar_reproduces_input() {
        // groove "a b c" recurs between fills — non-consecutive repetition.
        let seq = bars(&[
            "a", "b", "c", "x", "a", "b", "c", "y", "a", "b", "c", "z",
        ]);
        let g = repair(&seq);
        assert_eq!(g.expand(), seq, "grammar must reproduce the bars");
        // it found the recurring "a b c" phrase and shrank the sequence
        assert!(g.size() < seq.len(), "grammar {} !< {}", g.size(), seq.len());
    }

    #[test]
    fn finds_reused_phrase() {
        let seq = bars(&["a", "b", "a", "b", "a", "b", "a", "b"]);
        let g = repair(&seq);
        assert_eq!(g.expand(), seq);
        assert!(
            !g.reused_rules().is_empty(),
            "should name the recurring phrase"
        );
    }

    #[test]
    fn nested_arrange_lossless_and_smaller() {
        // A verbose 2-bar groove recurs 4× between fills → factored to a phrase
        // binding. (Compression only pays when bars carry real content.)
        let g0 = "[bd sd bd cp]";
        let g1 = "[hh oh hh oh bd]";
        let seq = bars(&[
            g0, g1, g0, g1, "[cr rim]", g0, g1, g0, g1, "[lt mt ht]", g0, g1, g0, g1,
        ]);
        let g = repair(&seq);
        let wrap = |s: &str| format!("s(\"{s}\")");
        let expr = g.to_arrange_nested(&wrap, 2, "p");
        let naive = wrap(&Mini::Alt(seq.clone()).emit());
        let cdoc = format!("setbpm(120);\n{expr}");
        let ndoc = format!("setbpm(120);\n{naive}");
        assert!(
            crate::verify::docs_equivalent(&cdoc, &ndoc, seq.len()).unwrap(),
            "nested arrange must play identically:\n{expr}"
        );
        assert!(expr.len() < naive.len(), "{} !< {}", expr.len(), naive.len());
    }

    #[test]
    fn through_composed_has_no_rules() {
        let seq = bars(&["a", "b", "c", "d", "e"]);
        let g = repair(&seq);
        assert_eq!(g.expand(), seq);
        assert!(g.rules.is_empty(), "nothing repeats → no rules");
    }
}
