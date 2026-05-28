pub fn validate_code(code: &str) -> Result<(), String> {
    if code.trim().is_empty() {
        return Ok(());
    }
    // `execute` internally walks the structural-file → standalone-DSL →
    // mini-notation fallback chain, replacing the hand-rolled cascade we
    // used to maintain here.
    strudel_dsl::execute(code).map(|_| ()).map_err(|e| e.to_string())
}
