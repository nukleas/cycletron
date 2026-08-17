//! ChatGPT / Codex CLI OAuth (subscription).
//!
//! Same idea as SuperGrok OAuth: use your **ChatGPT Plus / Pro / Codex plan**
//! instead of a metered `OPENAI_API_KEY`.
//!
//! Credentials match what `codex login` writes to `~/.codex/auth.json`:
//!
//! ```json
//! {
//!   "tokens": {
//!     "access_token": "...",
//!     "refresh_token": "...",
//!     "id_token": "...",
//!     "account_id": "<uuid>"
//!   },
//!   "last_refresh": "..."
//! }
//! ```
//!
//! Cycletron copies them into app-data (`codex-oauth.json`) so refresh is
//! owned here and does not thrash the Codex CLI's rotated refresh token.
//!
//! Inference uses the Codex Responses backend
//! (`https://chatgpt.com/backend-api/codex`), not `api.openai.com`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::oauth_store::{self, TokenStore};

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
const TOKEN_FILE: &str = "codex-oauth.json";
const EXPIRY_SKEW_SECS: i64 = 300; // 5 min — matches Codex CLI practice

static STORE: TokenStore = TokenStore::new(TOKEN_FILE, "Codex");

pub fn init(app_data_dir: &Path) {
    STORE.init(app_data_dir);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexTokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: Option<String>,
    pub account_id: String,
    /// Unix epoch seconds (from JWT `exp` or refresh `expires_in`).
    pub expires_at: i64,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexOAuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub expires_at: Option<i64>,
    pub source: Option<String>,
    /// Whether `~/.codex/auth.json` has an importable ChatGPT session.
    pub codex_cli_available: bool,
}

fn still_valid(t: &CodexTokens) -> bool {
    oauth_store::still_valid(t.expires_at, EXPIRY_SKEW_SECS, &t.access_token)
}

// ── Status / credentials ──────────────────────────────────────────────────

pub fn status() -> CodexOAuthStatus {
    let t: Option<CodexTokens> = STORE.load();
    CodexOAuthStatus {
        signed_in: t
            .as_ref()
            .is_some_and(|x| !x.access_token.is_empty() || !x.refresh_token.is_empty()),
        email: t.as_ref().and_then(|x| x.email.clone()),
        account_id: t.as_ref().map(|x| x.account_id.clone()),
        expires_at: t.as_ref().map(|x| x.expires_at),
        source: t.as_ref().and_then(|x| x.source.clone()),
        codex_cli_available: codex_cli_session().is_some(),
    }
}

pub fn has_session() -> bool {
    STORE
        .load::<CodexTokens>()
        .is_some_and(|t| !t.access_token.is_empty() || !t.refresh_token.is_empty())
}

/// Access token + account id for request headers (no network).
pub fn peek_credential() -> Option<(String, String)> {
    let t: CodexTokens = STORE.load()?;
    if t.access_token.is_empty() || t.account_id.is_empty() {
        return None;
    }
    Some((t.access_token, t.account_id))
}

pub async fn ensure_fresh() -> Result<(String, String), String> {
    let Some(tokens) = STORE.load::<CodexTokens>() else {
        return Err(
            "Not signed in with Codex. Open Preferences → Codex → Import CLI session or Sign in."
                .into(),
        );
    };
    if still_valid(&tokens) {
        return Ok((tokens.access_token, tokens.account_id));
    }
    if tokens.refresh_token.is_empty() {
        return Err("Codex session expired and no refresh token is stored. Sign in again.".into());
    }
    let refreshed = refresh_token(&tokens.refresh_token).await?;
    STORE.save(&refreshed)?;
    Ok((refreshed.access_token, refreshed.account_id))
}

pub fn logout() -> Result<(), String> {
    STORE.clear()
}

// ── Import from Codex CLI ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CodexCliAuth {
    #[serde(default)]
    tokens: Option<CodexCliTokens>,
}

#[derive(Debug, Deserialize)]
struct CodexCliTokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    account_id: Option<String>,
}

fn codex_auth_path() -> PathBuf {
    oauth_store::home_dir().join(".codex").join("auth.json")
}

fn codex_cli_session() -> Option<CodexTokens> {
    let raw = fs::read_to_string(codex_auth_path()).ok()?;
    let file: CodexCliAuth = serde_json::from_str(&raw).ok()?;
    let t = file.tokens?;
    let access = t.access_token.filter(|s| !s.is_empty())?;
    let refresh = t.refresh_token.unwrap_or_default();
    let account_id = t
        .account_id
        .filter(|s| !s.is_empty())
        .or_else(|| account_id_from_jwt(&access))
        .unwrap_or_default();
    if account_id.is_empty() {
        return None;
    }
    let expires_at = oauth_store::exp_from_jwt(&access).unwrap_or_else(|| oauth_store::now_unix() + 3600);
    let email = t
        .id_token
        .as_deref()
        .and_then(oauth_store::email_from_jwt)
        .or_else(|| oauth_store::email_from_jwt(&access));
    Some(CodexTokens {
        access_token: access,
        refresh_token: refresh,
        id_token: t.id_token,
        account_id,
        expires_at,
        email,
        source: Some("codex-cli".into()),
    })
}

pub fn import_from_codex_cli() -> Result<CodexOAuthStatus, String> {
    let mut tokens = codex_cli_session().ok_or_else(|| {
        format!(
            "No Codex CLI session at {}. Run `codex login` first, or Sign in with ChatGPT.",
            codex_auth_path().display()
        )
    })?;
    tokens.source = Some("codex-cli-import".into());
    STORE.save(&tokens)?;
    tracing::info!(
        target: "cycletron::codex_oauth",
        email = ?tokens.email,
        account_id = %tokens.account_id,
        "imported Codex / ChatGPT OAuth session"
    );
    Ok(status())
}

// ── Token refresh ─────────────────────────────────────────────────────────

use crate::oauth_store::TokenResponse;

async fn refresh_token(refresh: &str) -> Result<CodexTokens, String> {
    use crate::oauth_store::RefreshError;
    let grant = oauth_store::refresh_grant(TOKEN_URL, CLIENT_ID, refresh, "Codex")
        .await
        .map_err(|e| match e {
            RefreshError::InvalidGrant { err, desc } => {
                let _ = STORE.clear();
                format!(
                    "Codex session revoked or expired ({err} {desc}). Run `codex login` or Sign in again."
                )
            }
            RefreshError::Forbidden { desc } => format!("Codex refresh failed: 403 Forbidden {desc}"),
            RefreshError::Other(msg) => msg,
        })?;

    let prev: Option<CodexTokens> = STORE.load();
    let account_id = account_id_from_jwt(&grant.access_token)
        .or_else(|| prev.as_ref().map(|p| p.account_id.clone()))
        .unwrap_or_default();
    if account_id.is_empty() {
        return Err("refresh response missing ChatGPT account id".into());
    }
    let expires_at = oauth_store::exp_from_jwt(&grant.access_token)
        .or_else(|| grant.expires_in.map(|e| oauth_store::now_unix() + e))
        .unwrap_or_else(|| oauth_store::now_unix() + 3600);
    let email = grant
        .id_token
        .as_deref()
        .and_then(oauth_store::email_from_jwt)
        .or_else(|| prev.as_ref().and_then(|p| p.email.clone()));

    Ok(CodexTokens {
        access_token: grant.access_token,
        refresh_token: grant.refresh_token,
        id_token: grant.id_token.or_else(|| prev.and_then(|p| p.id_token)),
        account_id,
        expires_at,
        email,
        source: Some("refresh".into()),
    })
}

// ── Browser PKCE login (same as `codex login`) ────────────────────────────

/// Run the full browser PKCE loop (binds `localhost:1455`, opens browser, waits).
/// Blocks the async task until callback or timeout (~5 min).
pub async fn login_with_browser() -> Result<CodexOAuthStatus, String> {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::mpsc;

    let verifier = random_urlsafe(64);
    let challenge = pkce_challenge_s256(&verifier);
    let state = random_urlsafe(24);

    let auth_url = format!(
        "{AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs",
        urlencoding_minimal(CLIENT_ID),
        urlencoding_minimal(REDIRECT_URI),
        urlencoding_minimal(SCOPE),
        urlencoding_minimal(&challenge),
        urlencoding_minimal(&state),
    );

    let listener = TcpListener::bind("127.0.0.1:1455").map_err(|e| {
        format!(
            "Could not bind localhost:1455 for Codex login ({e}). \
             Close any running `codex login` / another Cycletron sign-in, or run `codex login` and Import CLI session."
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    // Open browser on the async runtime thread.
    if let Err(e) = open::that(&auth_url) {
        tracing::warn!(target: "cycletron::codex_oauth", "failed to open browser: {e}");
    }

    let (tx, rx) = mpsc::channel::<Result<(String, String), String>>();
    let expected_state = state.clone();
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            if std::time::Instant::now() > deadline {
                let _ = tx.send(Err("Codex sign-in timed out (5 min). Try again.".into()));
                return;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let line = req.lines().next().unwrap_or("");
                    // GET /auth/callback?code=...&state=... HTTP/1.1
                    let path = line.split_whitespace().nth(1).unwrap_or("");
                    let query = path.split('?').nth(1).unwrap_or("");
                    let mut code = None;
                    let mut got_state = None;
                    for pair in query.split('&') {
                        let mut it = pair.splitn(2, '=');
                        let k = it.next().unwrap_or("");
                        let v = it.next().unwrap_or("");
                        match k {
                            "code" => code = Some(urlencoding_decode(v)),
                            "state" => got_state = Some(urlencoding_decode(v)),
                            _ => {}
                        }
                    }
                    let html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
                        <html><body style='font-family:system-ui;padding:2rem'>\
                        <h2>Cycletron - signed in with ChatGPT</h2>\
                        <p>You can close this tab and return to the app.</p>\
                        </body></html>";
                    let _ = stream.write_all(html);
                    let _ = stream.flush();

                    if got_state.as_deref() != Some(expected_state.as_str()) {
                        let _ = tx.send(Err("OAuth state mismatch (CSRF). Try again.".into()));
                        return;
                    }
                    match code {
                        Some(c) if !c.is_empty() => {
                            let _ = tx.send(Ok((c, expected_state)));
                        }
                        _ => {
                            let _ = tx.send(Err("Callback missing authorization code.".into()));
                        }
                    }
                    return;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("callback server error: {e}")));
                    return;
                }
            }
        }
    });

    // Wait for the callback without blocking the runtime with a sync recv.
    let code = loop {
        match rx.try_recv() {
            Ok(Ok((code, _))) => break code,
            Ok(Err(e)) => return Err(e),
            Err(mpsc::TryRecvError::Empty) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err("Codex login callback thread ended unexpectedly".into());
            }
        }
    };

    // Exchange code for tokens.
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;

    let http_status = resp.status();
    let body: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("token exchange parse failed: {e}"))?;
    if !http_status.is_success() || body.error.is_some() {
        let err = body.error.unwrap_or_else(|| http_status.to_string());
        let desc = body.error_description.unwrap_or_default();
        return Err(format!("Codex token exchange failed: {err} {desc}"));
    }

    let access = body
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "token exchange missing access_token".to_string())?;
    let refresh = body
        .refresh_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "token exchange missing refresh_token".to_string())?;
    let account_id = account_id_from_jwt(&access)
        .ok_or_else(|| "token missing chatgpt_account_id claim".to_string())?;
    let expires_at = oauth_store::exp_from_jwt(&access)
        .or_else(|| body.expires_in.map(|e| oauth_store::now_unix() + e))
        .unwrap_or_else(|| oauth_store::now_unix() + 3600);
    let email = body
        .id_token
        .as_deref()
        .and_then(oauth_store::email_from_jwt)
        .or_else(|| oauth_store::email_from_jwt(&access));

    let tokens = CodexTokens {
        access_token: access,
        refresh_token: refresh,
        id_token: body.id_token,
        account_id,
        expires_at,
        email,
        source: Some("browser-pkce".into()),
    };
    STORE.save(&tokens)?;
    tracing::info!(
        target: "cycletron::codex_oauth",
        email = ?tokens.email,
        "Codex browser login succeeded"
    );
    Ok(status())
}

// ── JWT / PKCE helpers ─────────────────────────────────────────────────────

/// The Codex/ChatGPT account id claim from an access-token JWT (Codex-specific;
/// generic JWT payload/email/exp decode lives in [`crate::oauth_store`]).
fn account_id_from_jwt(jwt: &str) -> Option<String> {
    let v = oauth_store::jwt_payload(jwt)?;
    // Nested claim used by Codex / ChatGPT OAuth access tokens.
    v.pointer("/https://api.openai.com/auth/chatgpt_account_id")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .or_else(|| {
            v.get("chatgpt_account_id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
        })
}

fn base64_url_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = if i + 1 < bytes.len() {
            bytes[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < bytes.len() {
            bytes[i + 2] as u32
        } else {
            0
        };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(T[((n >> 6) & 63) as usize] as char);
        }
        if i + 2 < bytes.len() {
            out.push(T[(n & 63) as usize] as char);
        }
        i += 3;
    }
    out
}

fn random_urlsafe(n_bytes: usize) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    // Prefer OS randomness.
    let mut buf = vec![0u8; n_bytes];
    if getrandom_fill(&mut buf).is_err() {
        let mut h = DefaultHasher::new();
        oauth_store::now_unix().hash(&mut h);
        std::process::id().hash(&mut h);
        let seed = h.finish();
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((seed.wrapping_mul(i as u64 + 1)) % 256) as u8;
        }
    }
    base64_url_encode(&buf)
}

fn getrandom_fill(buf: &mut [u8]) -> Result<(), ()> {
    // Use /dev/urandom on unix without an extra crate.
    #[cfg(unix)]
    {
        use std::io::Read;
        let mut f = fs::File::open("/dev/urandom").map_err(|_| ())?;
        f.read_exact(buf).map_err(|_| ())
    }
    #[cfg(not(unix))]
    {
        let _ = buf;
        Err(())
    }
}

fn pkce_challenge_s256(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(verifier.as_bytes());
    base64_url_encode(&hash)
}

fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
