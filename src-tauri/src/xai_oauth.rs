//! xAI SuperGrok / SuperHeavy OAuth (device-code + refresh).
//!
//! Lets Cycletron use a consumer xAI subscription instead of (or alongside)
//! a metered `XAI_API_KEY`. Flow matches the public Grok CLI client:
//!
//! - Issuer: `https://auth.x.ai`
//! - Device code: `POST /oauth2/device/code`
//! - Token / refresh: `POST /oauth2/token`
//! - Public `client_id` (no secret): Grok CLI
//!
//! Tokens are stored in app-data (`xai-oauth.json`, mode 0600). We can also
//! **import** a session from `~/.grok/auth.json` (Grok Build / Grok CLI) and
//! then own refresh from that point so we don't fight Grok Build over rotated
//! refresh tokens.
//!
//! Note: some SuperGrok tiers get HTTP 403/402 on `api.x.ai` with OAuth; the
//! Grok CLI chat proxy (`cli-chat-proxy.grok.com`) is the subscription path
//! used by Grok Build. SuperHeavy often has broader entitlement — if chat
//! completions fail after a successful login, try the proxy base URL or an
//! API key from console.x.ai.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::oauth_store::{self, TokenStore};

/// Public Grok CLI OIDC client (no secret; device + PKCE clients use `none`).
const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const TOKEN_FILE: &str = "xai-oauth.json";
/// Refresh this many seconds before JWT/expiry.
const EXPIRY_SKEW_SECS: i64 = 120;

static STORE: TokenStore = TokenStore::new(TOKEN_FILE, "xAI");

/// Call once at app startup with the resolved app-data directory.
pub fn init(app_data_dir: &Path) {
    STORE.init(app_data_dir);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix epoch seconds when the access token expires (best-effort).
    pub expires_at: i64,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OAuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub expires_at: Option<i64>,
    pub source: Option<String>,
    /// Whether `~/.grok/auth.json` has an importable session.
    pub grok_build_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
    /// Opaque device_code for the poll command (never show in UI).
    pub device_code: String,
}

fn still_valid(tokens: &OAuthTokens) -> bool {
    oauth_store::still_valid(tokens.expires_at, EXPIRY_SKEW_SECS, &tokens.access_token)
}

// ── Public status / credential resolution ─────────────────────────────────

pub fn status() -> OAuthStatus {
    let tokens: Option<OAuthTokens> = STORE.load();
    OAuthStatus {
        signed_in: tokens
            .as_ref()
            .is_some_and(|t| !t.access_token.is_empty() || !t.refresh_token.is_empty()),
        email: tokens.as_ref().and_then(|t| t.email.clone()),
        expires_at: tokens.as_ref().map(|t| t.expires_at),
        source: tokens.as_ref().and_then(|t| t.source.clone()),
        grok_build_available: grok_build_session().is_some(),
    }
}

/// True when we have a usable OAuth session (valid access token, or refreshable).
pub fn has_session() -> bool {
    STORE
        .load::<OAuthTokens>()
        .is_some_and(|t| !t.access_token.is_empty() || !t.refresh_token.is_empty())
}

/// Return a non-expired access token without network I/O. Prefer calling
/// [`ensure_fresh`] first from an async context so the token is refreshed.
pub fn peek_access_token() -> Option<String> {
    let t: OAuthTokens = STORE.load()?;
    if still_valid(&t) {
        Some(t.access_token)
    } else {
        // Stale but present — still return it so a just-started request can
        // fail with 401 and the next ensure_fresh can recover. Prefer ensure_fresh.
        if t.access_token.is_empty() {
            None
        } else {
            Some(t.access_token)
        }
    }
}

/// Refresh if needed and return a valid access token.
pub async fn ensure_fresh() -> Result<String, String> {
    let Some(tokens) = STORE.load::<OAuthTokens>() else {
        return Err(
            "Not signed in with xAI. Open Preferences → Grok → Sign in with SuperGrok.".into(),
        );
    };
    if still_valid(&tokens) {
        return Ok(tokens.access_token);
    }
    if tokens.refresh_token.is_empty() {
        return Err("xAI session expired and no refresh token is stored. Sign in again.".into());
    }
    let refreshed = refresh_token(&tokens.refresh_token).await?;
    STORE.save(&refreshed)?;
    Ok(refreshed.access_token)
}

pub fn logout() -> Result<(), String> {
    STORE.clear()
}

// ── Import from Grok Build (`~/.grok/auth.json`) ──────────────────────────

#[derive(Debug, Deserialize)]
struct GrokBuildEntry {
    key: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<String>,
    email: Option<String>,
}

fn grok_auth_path() -> PathBuf {
    oauth_store::home_dir().join(".grok").join("auth.json")
}

fn grok_build_session() -> Option<OAuthTokens> {
    let raw = fs::read_to_string(grok_auth_path()).ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw).ok()?;
    // Prefer the Grok CLI client entry; otherwise first entry with tokens.
    let preferred_key = format!("https://auth.x.ai::{CLIENT_ID}");
    let entry_val = map.get(&preferred_key).or_else(|| map.values().next())?;
    let entry: GrokBuildEntry = serde_json::from_value(entry_val.clone()).ok()?;
    let access = entry.key.filter(|s| !s.is_empty())?;
    let refresh = entry.refresh_token.unwrap_or_default();
    let expires_at = entry
        .expires_at
        .as_deref()
        .and_then(parse_rfc3339)
        .unwrap_or_else(|| oauth_store::now_unix() + 3600);
    Some(OAuthTokens {
        access_token: access,
        refresh_token: refresh,
        expires_at,
        email: entry.email,
        source: Some("grok-build".into()),
    })
}

fn parse_rfc3339(s: &str) -> Option<i64> {
    // chrono is already a workspace dep of the app.
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
        .or_else(|| {
            // Also accept plain unix seconds as string.
            s.parse::<i64>().ok()
        })
}

/// Copy the Grok Build session into Cycletron's store (then we own refresh).
pub fn import_from_grok_build() -> Result<OAuthStatus, String> {
    let mut tokens = grok_build_session().ok_or_else(|| {
        format!(
            "No Grok Build session at {}. Run `grok login` first, or use Sign in with SuperGrok.",
            grok_auth_path().display()
        )
    })?;
    tokens.source = Some("grok-build-import".into());
    STORE.save(&tokens)?;
    tracing::info!(
        target: "cycletron::xai_oauth",
        email = ?tokens.email,
        "imported xAI OAuth session from Grok Build"
    );
    Ok(status())
}

// ── Device-code login ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

use crate::oauth_store::TokenResponse;

/// Start device authorization; open `verification_uri_complete` in a browser.
pub async fn start_device_login() -> Result<DeviceStart, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|e| format!("device code request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("device code HTTP {status}: {body}"));
    }
    let body: DeviceCodeResponse = resp
        .json()
        .await
        .map_err(|e| format!("device code parse failed: {e}"))?;
    Ok(DeviceStart {
        user_code: body.user_code,
        verification_uri: body.verification_uri,
        verification_uri_complete: body.verification_uri_complete,
        expires_in: body.expires_in,
        interval: body.interval.unwrap_or(5).max(1),
        device_code: body.device_code,
    })
}

/// Poll until the user approves the device code (or timeout / deny).
pub async fn poll_device_login(
    device_code: &str,
    interval_secs: u64,
    expires_in: u64,
) -> Result<OAuthStatus, String> {
    let client = reqwest::Client::new();
    let deadline = oauth_store::now_unix() + expires_in as i64;
    let mut interval = Duration::from_secs(interval_secs.max(1));

    loop {
        if oauth_store::now_unix() >= deadline {
            return Err("xAI sign-in timed out. Try again.".into());
        }
        tokio::time::sleep(interval).await;

        let resp = client
            .post(TOKEN_URL)
            .header("Accept", "application/json")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", CLIENT_ID),
                ("device_code", device_code),
            ])
            .send()
            .await
            .map_err(|e| format!("token poll failed: {e}"))?;

        let body: TokenResponse = resp
            .json()
            .await
            .map_err(|e| format!("token poll parse failed: {e}"))?;

        if let Some(err) = body.error.as_deref() {
            match err {
                "authorization_pending" => continue,
                "slow_down" => {
                    interval = Duration::from_secs((interval.as_secs() + 5).min(30));
                    continue;
                }
                "access_denied" | "authorization_denied" => {
                    return Err("xAI sign-in was denied.".into());
                }
                "expired_token" => {
                    return Err("Device code expired. Start sign-in again.".into());
                }
                other => {
                    let desc = body.error_description.unwrap_or_default();
                    return Err(format!("xAI OAuth error: {other} {desc}"));
                }
            }
        }

        let access = body
            .access_token
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "token response missing access_token".to_string())?;
        let refresh = body.refresh_token.unwrap_or_default();
        if refresh.is_empty() {
            return Err(
                "token response missing refresh_token (offline_access scope required)".into(),
            );
        }
        let expires_in = body.expires_in.unwrap_or(3600);
        let email = body
            .id_token
            .as_deref()
            .and_then(oauth_store::email_from_jwt);
        let tokens = OAuthTokens {
            access_token: access,
            refresh_token: refresh,
            expires_at: oauth_store::now_unix() + expires_in,
            email,
            source: Some("device-code".into()),
        };
        STORE.save(&tokens)?;
        tracing::info!(
            target: "cycletron::xai_oauth",
            email = ?tokens.email,
            "xAI OAuth device login succeeded"
        );
        return Ok(status());
    }
}

async fn refresh_token(refresh: &str) -> Result<OAuthTokens, String> {
    use crate::oauth_store::RefreshError;
    let grant = oauth_store::refresh_grant(TOKEN_URL, CLIENT_ID, refresh, "xAI")
        .await
        .map_err(|e| match e {
            // 403 often means the grant is valid but the account is not
            // entitled to API access on this surface — re-login will not help.
            RefreshError::Forbidden { desc } => format!(
                "xAI OAuth refresh forbidden (HTTP 403): {desc}. \
                 Your subscription may not include API access via OAuth. \
                 Use an API key from console.x.ai, or upgrade SuperHeavy entitlement."
            ),
            // Invalid grant → clear local tokens so we stop retrying a dead refresh.
            RefreshError::InvalidGrant { err, desc } => {
                let _ = STORE.clear();
                format!("xAI session revoked or expired ({err} {desc}). Sign in again.")
            }
            RefreshError::Other(msg) => msg,
        })?;

    let prev: Option<OAuthTokens> = STORE.load();
    Ok(OAuthTokens {
        access_token: grant.access_token,
        refresh_token: grant.refresh_token,
        expires_at: oauth_store::now_unix() + grant.expires_in.unwrap_or(3600),
        email: prev.as_ref().and_then(|p| p.email.clone()),
        source: prev
            .as_ref()
            .and_then(|p| p.source.clone())
            .or(Some("refresh".into())),
    })
}
