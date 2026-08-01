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
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Public Grok CLI OIDC client (no secret; device + PKCE clients use `none`).
const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const SCOPE: &str =
    "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const TOKEN_FILE: &str = "xai-oauth.json";
/// Refresh this many seconds before JWT/expiry.
const EXPIRY_SKEW_SECS: i64 = 120;

static APP_DATA: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Call once at app startup with the resolved app-data directory.
pub fn init(app_data_dir: &Path) {
    if let Ok(mut guard) = APP_DATA.lock() {
        *guard = Some(app_data_dir.to_path_buf());
    }
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

// ── Storage ───────────────────────────────────────────────────────────────

fn token_path() -> Result<PathBuf, String> {
    APP_DATA
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .map(|d| d.join(TOKEN_FILE))
        .ok_or_else(|| "xAI OAuth store not initialized".into())
}

fn load_tokens() -> Option<OAuthTokens> {
    let path = token_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_tokens(tokens: &OAuthTokens) -> Result<(), String> {
    let path = token_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(tokens).map_err(|e| e.to_string())?;
    write_private(&path, raw.as_bytes())
}

fn clear_tokens() -> Result<(), String> {
    let path = token_path()?;
    let _ = fs::remove_file(path);
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| e.to_string())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn access_token_still_valid(tokens: &OAuthTokens) -> bool {
    tokens.expires_at - EXPIRY_SKEW_SECS > now_unix() && !tokens.access_token.is_empty()
}

// ── Public status / credential resolution ─────────────────────────────────

pub fn status() -> OAuthStatus {
    let tokens = load_tokens();
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
    load_tokens().is_some_and(|t| !t.access_token.is_empty() || !t.refresh_token.is_empty())
}

/// Return a non-expired access token without network I/O. Prefer calling
/// [`ensure_fresh`] first from an async context so the token is refreshed.
pub fn peek_access_token() -> Option<String> {
    let t = load_tokens()?;
    if access_token_still_valid(&t) {
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
    let Some(tokens) = load_tokens() else {
        return Err("Not signed in with xAI. Open Preferences → Grok → Sign in with SuperGrok.".into());
    };
    if access_token_still_valid(&tokens) {
        return Ok(tokens.access_token);
    }
    if tokens.refresh_token.is_empty() {
        return Err("xAI session expired and no refresh token is stored. Sign in again.".into());
    }
    let refreshed = refresh_token(&tokens.refresh_token).await?;
    save_tokens(&refreshed)?;
    Ok(refreshed.access_token)
}

pub fn logout() -> Result<(), String> {
    clear_tokens()
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
    dirs_home().join(".grok").join("auth.json")
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn grok_build_session() -> Option<OAuthTokens> {
    let raw = fs::read_to_string(grok_auth_path()).ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw).ok()?;
    // Prefer the Grok CLI client entry; otherwise first entry with tokens.
    let preferred_key = format!("https://auth.x.ai::{CLIENT_ID}");
    let entry_val = map
        .get(&preferred_key)
        .or_else(|| map.values().next())?;
    let entry: GrokBuildEntry = serde_json::from_value(entry_val.clone()).ok()?;
    let access = entry.key.filter(|s| !s.is_empty())?;
    let refresh = entry.refresh_token.unwrap_or_default();
    let expires_at = entry
        .expires_at
        .as_deref()
        .and_then(parse_rfc3339)
        .unwrap_or_else(|| now_unix() + 3600);
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
    let mut tokens = grok_build_session()
        .ok_or_else(|| {
            format!(
                "No Grok Build session at {}. Run `grok login` first, or use Sign in with SuperGrok.",
                grok_auth_path().display()
            )
        })?;
    tokens.source = Some("grok-build-import".into());
    save_tokens(&tokens)?;
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

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

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
pub async fn poll_device_login(device_code: &str, interval_secs: u64, expires_in: u64) -> Result<OAuthStatus, String> {
    let client = reqwest::Client::new();
    let deadline = now_unix() + expires_in as i64;
    let mut interval = Duration::from_secs(interval_secs.max(1));

    loop {
        if now_unix() >= deadline {
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
            return Err("token response missing refresh_token (offline_access scope required)".into());
        }
        let expires_in = body.expires_in.unwrap_or(3600);
        let email = body
            .id_token
            .as_deref()
            .and_then(email_from_jwt);
        let tokens = OAuthTokens {
            access_token: access,
            refresh_token: refresh,
            expires_at: now_unix() + expires_in,
            email,
            source: Some("device-code".into()),
        };
        save_tokens(&tokens)?;
        tracing::info!(
            target: "cycletron::xai_oauth",
            email = ?tokens.email,
            "xAI OAuth device login succeeded"
        );
        return Ok(status());
    }
}

async fn refresh_token(refresh: &str) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh),
        ])
        .send()
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?;

    let status = resp.status();
    let body: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("token refresh parse failed: {e}"))?;

    if !status.is_success() || body.error.is_some() {
        let err = body.error.unwrap_or_else(|| status.to_string());
        let desc = body.error_description.unwrap_or_default();
        // 403 often means the grant is valid but the account is not entitled
        // to API access on this surface — re-login will not help.
        if status.as_u16() == 403 {
            return Err(format!(
                "xAI OAuth refresh forbidden (HTTP 403): {desc}. \
                 Your subscription may not include API access via OAuth. \
                 Use an API key from console.x.ai, or upgrade SuperHeavy entitlement."
            ));
        }
        // Invalid grant → clear local tokens so we stop retrying a dead refresh.
        if err == "invalid_grant" || status.as_u16() == 400 || status.as_u16() == 401 {
            let _ = clear_tokens();
            return Err(format!(
                "xAI session revoked or expired ({err} {desc}). Sign in again."
            ));
        }
        return Err(format!("xAI refresh failed: {err} {desc}"));
    }

    let access = body
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "refresh response missing access_token".to_string())?;
    // Refresh tokens rotate — must persist the new one.
    let new_refresh = body
        .refresh_token
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| refresh.to_string());
    let expires_in = body.expires_in.unwrap_or(3600);
    let prev = load_tokens();
    Ok(OAuthTokens {
        access_token: access,
        refresh_token: new_refresh,
        expires_at: now_unix() + expires_in,
        email: prev.as_ref().and_then(|p| p.email.clone()),
        source: prev
            .as_ref()
            .and_then(|p| p.source.clone())
            .or(Some("refresh".into())),
    })
}

/// Best-effort email from an ID token payload (unverified decode).
fn email_from_jwt(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let padded = match payload.len() % 4 {
        2 => format!("{payload}=="),
        3 => format!("{payload}="),
        _ => payload.to_string(),
    };
    let bytes = base64_url_decode(&padded)?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("email")?.as_str().map(str::to_string)
}

fn base64_url_decode(s: &str) -> Option<Vec<u8>> {
    // Minimal URL-safe base64 decode without extra deps.
    let standard = s.replace('-', "+").replace('_', "/");
    // Manual base64 alphabet
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let bytes: Vec<u8> = standard
        .bytes()
        .filter(|&b| b != b'=')
        .map(|b| T.iter().position(|&c| c == b).unwrap_or(0) as u8)
        .collect();
    let mut i = 0;
    while i + 3 < bytes.len() || (i < bytes.len() && bytes.len() - i >= 2) {
        let remaining = bytes.len() - i;
        if remaining >= 4 {
            let n = ((bytes[i] as u32) << 18)
                | ((bytes[i + 1] as u32) << 12)
                | ((bytes[i + 2] as u32) << 6)
                | (bytes[i + 3] as u32);
            out.push(((n >> 16) & 0xff) as u8);
            out.push(((n >> 8) & 0xff) as u8);
            out.push((n & 0xff) as u8);
            i += 4;
        } else if remaining == 3 {
            let n = ((bytes[i] as u32) << 18)
                | ((bytes[i + 1] as u32) << 12)
                | ((bytes[i + 2] as u32) << 6);
            out.push(((n >> 16) & 0xff) as u8);
            out.push(((n >> 8) & 0xff) as u8);
            break;
        } else if remaining == 2 {
            let n = ((bytes[i] as u32) << 18) | ((bytes[i + 1] as u32) << 12);
            out.push(((n >> 16) & 0xff) as u8);
            break;
        } else {
            break;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_email_payload() {
        // {"email":"a@b.c"}
        let b64 = "eyJlbWFpbCI6ImFAYi5jIn0";
        let bytes = base64_url_decode(b64).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["email"], "a@b.c");
    }
}
