//! Evaluate pattern source via the same cascade the live app and corpus-check use.
//!
//! strudel-rs no longer exposes a single `strudel_dsl::execute` helper; this
//! module restores the structural-file → DSL → mini-notation fallback chain.

use strudel_dsl::{EvalOutput, evaluate_file, eval_dsl_with_tempo, parse_strudel_file};
use strudel_mini::{evaluate as eval_mini, parse as parse_mini};

/// Parse + evaluate pattern source, returning the pattern and optional tempo.
pub fn execute(code: &str) -> Result<EvalOutput, String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("empty pattern".to_string());
    }

    // 1. Structural `.strudel` file (tracks / directives / bindings / fns)
    if let Ok(file) = parse_strudel_file(code) {
        let has_content = !file.tracks.is_empty()
            || !file.directives.is_empty()
            || !file.bindings.is_empty()
            || !file.functions.is_empty();
        if has_content {
            let out = evaluate_file(&file).map_err(|e| e.to_string())?;
            return Ok(EvalOutput {
                pattern: out.pattern,
                tempo: out.tempo,
            });
        }
    }

    // 2. Standalone DSL expression (with optional setbpm/setcpm)
    match eval_dsl_with_tempo(code) {
        Ok(out) => return Ok(out),
        Err(dsl_err) => {
            // 3. Bare mini-notation
            if let Ok(ast) = parse_mini(code)
                && let Ok(pattern) = eval_mini(&ast)
            {
                return Ok(EvalOutput {
                    pattern,
                    tempo: None,
                });
            }
            Err(dsl_err.to_string())
        }
    }
}
