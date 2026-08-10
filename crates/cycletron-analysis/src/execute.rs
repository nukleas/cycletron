//! Evaluate pattern source via strudel-rs's unified execute cascade.
//!
//! `strudel_dsl::execute` runs structural-file → DSL → mini-notation fallback.

use strudel_dsl::EvalOutput;

/// Parse + evaluate pattern source, returning the pattern and optional tempo.
pub fn execute(code: &str) -> Result<EvalOutput, String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("empty pattern".to_string());
    }
    strudel_dsl::execute(code).map_err(|e| e.to_string())
}
