//! Shared plumbing for the subscription-OAuth backends (xAI SuperGrok and
//! ChatGPT/Codex). Each backend owns its token/status shapes and its login +
//! refresh flow; the pieces that were byte-identical between `xai_oauth` and
//! `codex_oauth` — a private `0600` token file keyed by a per-backend app-data
//! dir, unverified JWT/base64 decode, the home dir, and the wall clock — live
//! here so the security-sensitive bits exist exactly once.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// A per-backend on-disk token store: an app-data directory set once at startup
/// plus a fixed file name. Holds no token state itself — it reads and writes the
/// typed token blob on demand, so callers stay stateless.
pub struct TokenStore {
    dir: Mutex<Option<PathBuf>>,
    file: &'static str,
    /// Human label for the "not initialized" error (e.g. `"xAI"`, `"Codex"`).
    label: &'static str,
}

impl TokenStore {
    pub const fn new(file: &'static str, label: &'static str) -> Self {
        Self {
            dir: Mutex::new(None),
            file,
            label,
        }
    }

    /// Call once at app startup with the resolved app-data directory.
    pub fn init(&self, app_data_dir: &Path) {
        if let Ok(mut guard) = self.dir.lock() {
            *guard = Some(app_data_dir.to_path_buf());
        }
    }

    fn path(&self) -> Result<PathBuf, String> {
        self.dir
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .map(|d| d.join(self.file))
            .ok_or_else(|| format!("{} OAuth store not initialized", self.label))
    }

    /// Load and deserialize the stored tokens, or `None` if absent/unreadable.
    pub fn load<T: DeserializeOwned>(&self) -> Option<T> {
        let raw = fs::read_to_string(self.path().ok()?).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Persist tokens to the `0600` store, creating the parent dir as needed.
    pub fn save<T: Serialize>(&self, tokens: &T) -> Result<(), String> {
        let path = self.path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let raw = serde_json::to_string_pretty(tokens).map_err(|e| e.to_string())?;
        write_private(&path, raw.as_bytes())
    }

    /// Delete the stored tokens (idempotent — missing file is fine).
    pub fn clear(&self) -> Result<(), String> {
        let _ = fs::remove_file(self.path()?);
        Ok(())
    }
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

/// Is an access token still usable, refreshing `skew` seconds early?
pub fn still_valid(expires_at: i64, skew: i64, access_token: &str) -> bool {
    expires_at - skew > now_unix() && !access_token.is_empty()
}

// ── OAuth token-endpoint refresh (shared wire format + classification) ──────

/// The OAuth token endpoint's response shape — identical for both backends.
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    pub expires_in: Option<i64>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// A successful refresh: the new access token, the (possibly rotated) refresh
/// token, and whatever else the endpoint returned. Backends derive their own
/// expiry/claims from these.
#[derive(Debug)]
pub struct RefreshedGrant {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: Option<String>,
    pub expires_in: Option<i64>,
}

/// Why a refresh failed, classified so each backend can attach its own
/// user-facing guidance (and clear its store on a dead grant).
#[derive(Debug)]
pub enum RefreshError {
    /// The grant is dead (invalid_grant / 400 / 401) — re-login required.
    InvalidGrant { err: String, desc: String },
    /// HTTP 403 — the grant works but the account isn't entitled; re-login
    /// will not help.
    Forbidden { desc: String },
    Other(String),
}

/// POST a `refresh_token` grant and classify the outcome. `label` names the
/// backend in transport-level error messages.
pub async fn refresh_grant(
    token_url: &str,
    client_id: &str,
    refresh: &str,
    label: &str,
) -> Result<RefreshedGrant, RefreshError> {
    let client = reqwest::Client::new();
    let resp = client
        .post(token_url)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh),
        ])
        .send()
        .await
        .map_err(|e| RefreshError::Other(format!("{label} token refresh failed: {e}")))?;

    let status = resp.status();
    let body: TokenResponse = resp
        .json()
        .await
        .map_err(|e| RefreshError::Other(format!("{label} refresh parse failed: {e}")))?;

    if !status.is_success() || body.error.is_some() {
        let err = body.error.unwrap_or_else(|| status.to_string());
        let desc = body.error_description.unwrap_or_default();
        if status.as_u16() == 403 {
            return Err(RefreshError::Forbidden { desc });
        }
        if err == "invalid_grant" || status.as_u16() == 400 || status.as_u16() == 401 {
            return Err(RefreshError::InvalidGrant { err, desc });
        }
        return Err(RefreshError::Other(format!(
            "{label} refresh failed: {err} {desc}"
        )));
    }

    let access = body
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RefreshError::Other("refresh response missing access_token".to_string()))?;
    // Refresh tokens rotate — persist the new one, else keep the old.
    let new_refresh = body
        .refresh_token
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| refresh.to_string());
    Ok(RefreshedGrant {
        access_token: access,
        refresh_token: new_refresh,
        id_token: body.id_token,
        expires_in: body.expires_in,
    })
}

/// Wall-clock time in Unix epoch seconds (0 on the impossible pre-epoch error).
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The user's home directory (`$HOME` / `%USERPROFILE%`), falling back to `.`.
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

// ── JWT helpers (unverified decode) ─────────────────────────────────────────

/// Decode a JWT's payload segment into JSON. Unverified — we only read claims
/// (email, exp, account id) we already trust the transport for.
pub fn jwt_payload(jwt: &str) -> Option<serde_json::Value> {
    let payload = jwt.split('.').nth(1)?;
    let padded = match payload.len() % 4 {
        2 => format!("{payload}=="),
        3 => format!("{payload}="),
        _ => payload.to_string(),
    };
    let bytes = base64_url_decode(&padded)?;
    serde_json::from_slice(&bytes).ok()
}

/// The `email` claim from a JWT, if present.
pub fn email_from_jwt(jwt: &str) -> Option<String> {
    jwt_payload(jwt)?.get("email")?.as_str().map(str::to_string)
}

/// The `exp` (expiry, Unix seconds) claim from a JWT, if present.
pub fn exp_from_jwt(jwt: &str) -> Option<i64> {
    jwt_payload(jwt)?.get("exp")?.as_i64()
}

/// Minimal URL-safe base64 decode (no external crate). Tolerates missing
/// padding and `-`/`_` alphabet; ignores trailing `=`.
pub fn base64_url_decode(s: &str) -> Option<Vec<u8>> {
    let standard = s.replace('-', "+").replace('_', "/");
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let bytes: Vec<u8> = standard
        .bytes()
        .filter(|&b| b != b'=')
        .map(|b| T.iter().position(|&c| c == b).unwrap_or(0) as u8)
        .collect();
    let mut i = 0;
    while i < bytes.len() {
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
    fn base64_and_jwt_payload_decode() {
        // Payload segment of a JWT: {"email":"a@b.c"}
        let b64 = "eyJlbWFpbCI6ImFAYi5jIn0";
        let bytes = base64_url_decode(b64).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["email"], "a@b.c");

        // And through the full JWT helper (header.payload.sig shape).
        let jwt = format!("aaa.{b64}.bbb");
        assert_eq!(email_from_jwt(&jwt).as_deref(), Some("a@b.c"));
    }
}
