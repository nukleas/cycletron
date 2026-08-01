//! Single source of truth for which providers authenticate via subscription
//! OAuth (SuperGrok, ChatGPT/Codex) instead of a stored API key.
//!
//! Both the credential resolver ([`crate::state::resolve_provider_credential`])
//! and the pre-request refresh in `send_message` used to string-match `"grok"`
//! / `"codex"` independently — so adding an OAuth provider meant editing the
//! command layer *and* the state layer. Keeping the provider-id dispatch here
//! means those callers never name a provider, and a new OAuth backend is one
//! arm in each match below.

/// If `provider_id` authenticates via subscription OAuth and has a live session,
/// refresh its access token so the bearer isn't stale before we build the
/// client. Returns `true` when a refresh was attempted — the caller should then
/// rebuild the agent client to pick up the new token. A failed refresh is logged
/// (not fatal) and still returns `true`, since the stale token may yet work.
pub async fn refresh_if_stale(provider_id: &str) -> bool {
    let refresh_err = match provider_id {
        "grok" if crate::xai_oauth::has_session() => crate::xai_oauth::ensure_fresh().await.err(),
        "codex" if crate::codex_oauth::has_session() => {
            crate::codex_oauth::ensure_fresh().await.err()
        }
        _ => return false,
    };
    if let Some(e) = refresh_err {
        tracing::warn!(target: "cycletron::oauth", "{provider_id} token refresh failed: {e}");
    }
    true
}

/// The bearer access token from `provider_id`'s OAuth session, if one exists.
/// `None` for API-key providers (and when no session is signed in).
pub fn peek_access_token(provider_id: &str) -> Option<String> {
    match provider_id {
        "grok" => crate::xai_oauth::peek_access_token(),
        // Codex carries an account id too; `build_agent_client` reads the full
        // credential via `codex_oauth::peek_credential`. Here we only need the
        // bearer for generic credential resolution.
        "codex" => crate::codex_oauth::peek_credential().map(|(token, _account)| token),
        _ => None,
    }
}
