//! Credential leases: what a benchmark session in the sandbox signs in with.
//!
//! The Distill app owns every provider sign-in a benchmark uses, and it is
//! the only process that refreshes one. A sandbox session gets a lease: a
//! copy of the app's current sign-in reduced to what a session runs on, with
//! no refresh token, so nothing in the sandbox can rotate the grant the app
//! keeps. A lease is held in memory only, from the moment it is read until
//! it is staged into the session's private sandbox folder.
//!
//! Every lease must outlast its session and stay clear of its CLI's own
//! renewal window ([`natural_window_ms`]): the app's CLIs refresh a grant
//! inside that window by themselves, and a lease never spans a rotation.
//!
//! Kimi keeps its own sandbox-only grant (see the benchmark operations
//! guide); it is never leased.
#![allow(dead_code)]
use crate::services::agent_host::execution::NativeProvider;
use crate::services::provider_rate_limits::grok;
use crate::services::{distill_root, provider_accounts};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use tauri::AppHandle;

/// How long every lease outlasts its session beyond its CLI's own renewal
/// window: the checks and the stop between admission and the end of the
/// session, and clock drift between Windows and the sandbox.
pub(crate) const MARGIN_MS: i64 = 120_000;

/// The Claude CLI renews a grant in its last five minutes.
pub(crate) const CLAUDE_RENEWAL_WINDOW_MS: i64 = 300_000;

/// The largest credential document a lease carries.
const MAX_DOCUMENT_BYTES: usize = 256 * 1024;

/// Whether `provider`'s sandbox sessions run on a lease of the app's sign-in.
pub(crate) fn leased(provider: NativeProvider) -> bool {
    provider != NativeProvider::Kimi
}

/// How long before a grant expires the app's own CLI for `provider` renews it
/// by itself: Claude in its last five minutes, Grok inside the window the
/// chat bridge starts it with. Codex renews by the age of its last refresh
/// or after a rejection, and an API key does not expire.
pub(crate) fn natural_window_ms(provider: NativeProvider) -> i64 {
    match provider {
        NativeProvider::Claude => CLAUDE_RENEWAL_WINDOW_MS,
        NativeProvider::Grok => grok::cli_renewal_window_ms(),
        NativeProvider::Codex | NativeProvider::Kimi | NativeProvider::Zai => 0,
    }
}

/// The earliest expiry a grant of `provider` needs for a lease that must
/// last until `until_ms`.
pub(crate) fn required_expiry(provider: NativeProvider, until_ms: i64) -> i64 {
    until_ms
        .saturating_add(natural_window_ms(provider))
        .saturating_add(MARGIN_MS)
}

/// Whether a grant that expires at `expires_at_ms` (none: it does not
/// expire) covers a lease of `provider` until `until_ms`.
pub(crate) fn covers(provider: NativeProvider, expires_at_ms: Option<i64>, until_ms: i64) -> bool {
    expires_at_ms.is_none_or(|expiry| expiry >= required_expiry(provider, until_ms))
}

/// One provider's session files, built from the app's sign-in: never a
/// refresh token. Its `Debug` names the files alone, and its bytes are
/// overwritten when it is dropped.
pub(crate) struct Lease {
    provider: NativeProvider,
    files: BTreeMap<&'static str, Vec<u8>>,
    expires_at_ms: Option<i64>,
}

impl fmt::Debug for Lease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Lease")
            .field("provider", &self.provider.key())
            .field("files", &self.files.keys().collect::<Vec<_>>())
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        for bytes in self.files.values_mut() {
            wipe(bytes);
        }
    }
}

/// Overwrites `bytes` so the copy does not linger in freed memory.
pub(crate) fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // SAFETY: `byte` is a valid, exclusive reference into `bytes`.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

impl Lease {
    pub(crate) fn provider(&self) -> NativeProvider {
        self.provider
    }

    /// When the access token the lease carries expires; none for a key that
    /// does not expire.
    pub(crate) fn expires_at_ms(&self) -> Option<i64> {
        self.expires_at_ms
    }

    pub(crate) fn file_names(&self) -> Vec<&'static str> {
        self.files.keys().copied().collect()
    }

    /// What `bench-auth stage` reads on standard input: every file by name,
    /// base64-encoded. The caller wipes it once it has been written.
    pub(crate) fn stage_input(&self) -> Vec<u8> {
        let files: Map<String, Value> = self
            .files
            .iter()
            .map(|(name, bytes)| {
                (
                    (*name).to_owned(),
                    Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
                )
            })
            .collect();
        json!({ "files": files }).to_string().into_bytes()
    }
}

fn invalid(provider: &str) -> String {
    format!("The Distill {provider} sign-in is unreadable; sign in again in Settings")
}

fn parse_document(provider: &str, bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(invalid(provider));
    }
    serde_json::from_slice(bytes).map_err(|_| invalid(provider))
}

fn serialize(value: &Value) -> Result<Vec<u8>, String> {
    refuse_refresh_tokens(value)?;
    serde_json::to_vec(value).map_err(|error| error.to_string())
}

/// Whether `key` names a refresh token in any spelling the providers use.
fn is_refresh_token_key(key: &str) -> bool {
    key.chars()
        .filter(|c| !matches!(c, '_' | '-'))
        .collect::<String>()
        .eq_ignore_ascii_case("refreshtoken")
}

/// Refuses a document that carries a refresh token anywhere: a field named
/// for one that is not empty. The second check of every builder below; the
/// sandbox helper makes the same check before it writes a file.
pub(crate) fn refuse_refresh_tokens(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (key, field) in fields {
                let empty = match field {
                    Value::Null => true,
                    Value::String(text) => text.is_empty(),
                    _ => false,
                };
                if is_refresh_token_key(key) && !empty {
                    return Err("A credential lease must never carry a refresh token".into());
                }
                refuse_refresh_tokens(field)?;
            }
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(refuse_refresh_tokens),
        _ => Ok(()),
    }
}

/// The fields of the Claude grant a session runs on.
const CLAUDE_GRANT_FIELDS: &[&str] = &[
    "accessToken",
    "expiresAt",
    "scopes",
    "subscriptionType",
    "rateLimitTier",
];

/// A Claude lease from the app home's `.credentials.json` and, when present,
/// its `.claude.json`: the grant's access token, expiry, scopes and plan, and
/// the profile's `oauthAccount` and `userID`, the subset a session needs to
/// know whose account it runs on.
pub(crate) fn claude(credentials: &[u8], profile: Option<&[u8]>) -> Result<Lease, String> {
    let document = parse_document("Claude", credentials)?;
    let grant = document
        .get("claudeAiOauth")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Claude"))?;
    if grant
        .get("accessToken")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(invalid("Claude"));
    }
    let expires_at_ms = grant
        .get("expiresAt")
        .and_then(Value::as_i64)
        .filter(|expiry| *expiry > 0)
        .ok_or_else(|| invalid("Claude"))?;
    let kept: Map<String, Value> = grant
        .iter()
        .filter(|(field, value)| {
            CLAUDE_GRANT_FIELDS.contains(&field.as_str())
                && match value {
                    Value::Array(items) => items.iter().all(Value::is_string),
                    Value::Object(_) => false,
                    _ => true,
                }
        })
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect();
    let mut files = BTreeMap::new();
    files.insert(
        ".credentials.json",
        serialize(&json!({ "claudeAiOauth": kept }))?,
    );
    if let Some(profile) = profile {
        // A profile the app cannot read is left out, as the sandbox left
        // out a missing one: the session still signs in with the grant.
        if let Ok(Value::Object(profile)) = parse_document("Claude", profile) {
            let mut subset = Map::new();
            if let Some(account) = profile.get("oauthAccount").filter(|v| v.is_object()) {
                subset.insert("oauthAccount".into(), account.clone());
            }
            if let Some(user) = profile.get("userID").filter(|v| v.is_string()) {
                subset.insert("userID".into(), user.clone());
            }
            files.insert(".claude.json", serialize(&Value::Object(subset))?);
        }
    }
    Ok(Lease {
        provider: NativeProvider::Claude,
        files,
        expires_at_ms: Some(expires_at_ms),
    })
}

/// When the JSON Web Token `token` expires (its `exp` claim), in ms.
pub(crate) fn jwt_expiry_ms(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("exp")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .and_then(|seconds| seconds.checked_mul(1000))
}

/// A Codex lease from the app home's `auth.json`: its ChatGPT tokens with an
/// empty refresh token, refreshed `now_ms` by its own account, so the CLI
/// sees no reason to refresh it before the access token expires. The
/// expiry is the access token's own.
pub(crate) fn codex(auth: &[u8], now_ms: i64) -> Result<Lease, String> {
    let document = parse_document("Codex", auth)?;
    let tokens = document
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "The Distill Codex account has no ChatGPT sign-in to lease; API-key accounts do not run in the sandbox".to_string()
        })?;
    let text = |field: &str| {
        tokens
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let access = text("access_token").ok_or_else(|| invalid("Codex"))?;
    let id = text("id_token").ok_or_else(|| invalid("Codex"))?;
    let expires_at_ms = jwt_expiry_ms(access).ok_or_else(|| invalid("Codex"))?;
    let mut leased = json!({
        "id_token": id,
        "access_token": access,
        "refresh_token": "",
    });
    if let Some(account) = text("account_id") {
        leased["account_id"] = json!(account);
    }
    let refreshed = chrono::DateTime::from_timestamp_millis(now_ms)
        .ok_or("Invalid lease time")?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut files = BTreeMap::new();
    files.insert(
        "auth.json",
        serialize(&json!({
            "OPENAI_API_KEY": null,
            "tokens": leased,
            "last_refresh": refreshed,
        }))?,
    );
    Ok(Lease {
        provider: NativeProvider::Codex,
        files,
        expires_at_ms: Some(expires_at_ms),
    })
}

/// The fields of a Grok sign-in entry a session runs on: the access token
/// (`key`), how and when it was issued, when it expires and whose it is.
const GROK_ENTRY_FIELDS: &[&str] = &[
    "key",
    "auth_mode",
    "create_time",
    "expires_at",
    "user_id",
    "email",
];

/// The Grok auth document `raw` with each sign-in entry reduced to
/// [`GROK_ENTRY_FIELDS`] holding plain values. Everything else stays with
/// the user's own Grok: refresh, ID and other session tokens under any name,
/// nested objects, and anything that is not an entry.
fn grok_document(raw: &[u8]) -> Result<Value, String> {
    let document = parse_document("Grok", raw)?;
    let entries = document.as_object().ok_or_else(|| invalid("Grok"))?;
    let kept: Map<String, Value> = entries
        .iter()
        .filter_map(|(issuer, entry)| {
            let fields = entry
                .as_object()?
                .iter()
                .filter(|(field, value)| {
                    GROK_ENTRY_FIELDS.contains(&field.as_str())
                        && !value.is_object()
                        && !value.is_array()
                })
                .map(|(field, value)| (field.clone(), value.clone()))
                .collect();
            Some((issuer.clone(), Value::Object(fields)))
        })
        .collect();
    Ok(Value::Object(kept))
}

/// A Grok lease from the user's Grok `auth.json`, which the app's Grok CLI
/// keeps. Its expiry is that of the session Grok picks from the document.
pub(crate) fn grok(raw: &[u8]) -> Result<Lease, String> {
    let document = grok_document(raw)?;
    let text = std::str::from_utf8(raw).map_err(|_| invalid("Grok"))?;
    let session = match grok::parse_grok_auth_session(text) {
        grok::GrokAuthReadResult::Ok(session) => session,
        grok::GrokAuthReadResult::Missing => {
            return Err("Sign in to Grok in Distill before running Grok benchmarks".into())
        }
        grok::GrokAuthReadResult::Error(_) => return Err(invalid("Grok")),
    };
    let expires_at_ms = session.expires_at_ms.ok_or_else(|| {
        "The Distill Grok sign-in has no expiry; only a Grok CLI sign-in is leased to the sandbox"
            .to_string()
    })?;
    let mut files = BTreeMap::new();
    files.insert("auth.json", serialize(&document)?);
    Ok(Lease {
        provider: NativeProvider::Grok,
        files,
        expires_at_ms: Some(expires_at_ms),
    })
}

/// A Z.ai lease: the account's saved Coding Plan key, as one printable line.
/// It does not expire.
pub(crate) fn zai(key: &str) -> Result<Lease, String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || !key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(
            "The saved Z.ai key is not one printable line; save it again in Distill".into(),
        );
    }
    let mut files = BTreeMap::new();
    files.insert("api-key", format!("{key}\n").into_bytes());
    Ok(Lease {
        provider: NativeProvider::Zai,
        files,
        expires_at_ms: None,
    })
}

/// The lease of `account`'s current sign-in in the app, for a sandbox
/// session of `provider`, at `now_ms`. The app's sign-in is read and never
/// written: Claude's and Codex's from the account's own home, Grok's from the
/// user's Grok CLI, Z.ai's key from its protected store.
pub(crate) fn read(
    app: &AppHandle,
    provider: NativeProvider,
    account_id: &str,
    now_ms: i64,
) -> Result<Lease, String> {
    match provider {
        NativeProvider::Kimi => Err("Kimi keeps its own sandbox sign-in".into()),
        NativeProvider::Grok => {
            if !provider_accounts::is_cli_login_account(provider.harness_id(), account_id) {
                return Err("Grok benchmarks run on the Grok CLI sign-in".into());
            }
            match std::fs::read(grok::grok_auth_path()) {
                Ok(raw) => {
                    let mut raw = raw;
                    let lease = grok(&raw);
                    wipe(&mut raw);
                    lease
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Err("Sign in to Grok in Distill before running Grok benchmarks".into())
                }
                Err(_) => Err(invalid("Grok")),
            }
        }
        NativeProvider::Claude | NativeProvider::Codex | NativeProvider::Zai => {
            let account = provider_accounts::account(app, account_id)?;
            if account.provider_id != provider.harness_id() {
                return Err("Account belongs to a different provider".into());
            }
            if provider_accounts::account_change_in_progress(&account.id) {
                return Err(
                    "Account authorization is being changed; try again when it completes".into(),
                );
            }
            if provider == NativeProvider::Zai {
                let mut key = provider_accounts::api_key(app, &account)?;
                let lease = zai(&key);
                // SAFETY: zeroes stay valid UTF-8.
                wipe(unsafe { key.as_bytes_mut() });
                return lease;
            }
            if account.auth_method != provider_accounts::AuthMethod::OAuth {
                return Err(format!(
                    "The {} account {} signs in with an API key; only subscription sign-ins run in the sandbox",
                    provider.key(),
                    account.id
                ));
            }
            let root = distill_root::app_root(app)?;
            let home = provider_accounts::account_home(app, &account)?;
            let read_file = |name: &str| -> Result<Option<Vec<u8>>, String> {
                let path = home.join(name);
                distill_root::reject_document_links(&root, &path)?;
                match std::fs::read(path) {
                    Ok(bytes) => Ok(Some(bytes)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(_) => Err(invalid(provider.key())),
                }
            };
            let signed_out = || {
                format!(
                    "The {} account {} is not signed in to Distill; sign in in Settings > AI providers",
                    provider.key(),
                    account.id
                )
            };
            if provider == NativeProvider::Claude {
                let mut credentials = read_file(".credentials.json")?.ok_or_else(signed_out)?;
                let mut profile = read_file(".claude.json")?;
                let lease = claude(&credentials, profile.as_deref());
                wipe(&mut credentials);
                if let Some(profile) = profile.as_mut() {
                    wipe(profile);
                }
                lease
            } else {
                let mut auth = read_file("auth.json")?.ok_or_else(signed_out)?;
                let lease = codex(&auth, now_ms);
                wipe(&mut auth);
                lease
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn text(lease: &Lease, name: &str) -> String {
        String::from_utf8(lease.files[name].clone()).unwrap()
    }

    fn jwt(exp: i64) -> String {
        let encode = |value: Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        format!(
            "{}.{}.invented-signature",
            encode(json!({"alg":"none"})),
            encode(json!({"exp": exp, "sub": "invented"}))
        )
    }

    /// No lease output carries a refresh token, whatever the source holds
    /// and under whatever name.
    #[test]
    fn no_lease_carries_a_refresh_token() {
        let claude = super::claude(
            json!({"claudeAiOauth": {
                "accessToken": "invented-access",
                "refreshToken": "invented-refresh",
                "expiresAt": NOW + 3_600_000,
                "scopes": ["user:inference"],
                "subscriptionType": "max",
                "nested": {"refresh_token": "nested-refresh"},
            }, "other": "kept-out"})
            .to_string()
            .as_bytes(),
            Some(
                json!({"oauthAccount": {"accountUuid": "invented-uuid", "emailAddress": "dev@example.com"},
                    "userID": "invented-user", "projects": {"E:/invented": {}}, "machineID": "invented"})
                .to_string()
                .as_bytes(),
            ),
        )
        .unwrap();
        let credentials: Value = serde_json::from_str(&text(&claude, ".credentials.json")).unwrap();
        let mut fields: Vec<&str> = credentials["claudeAiOauth"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            ["accessToken", "expiresAt", "scopes", "subscriptionType"]
        );
        let profile: Value = serde_json::from_str(&text(&claude, ".claude.json")).unwrap();
        let mut kept: Vec<&str> = profile
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        kept.sort_unstable();
        assert_eq!(kept, ["oauthAccount", "userID"]);
        assert_eq!(claude.expires_at_ms(), Some(NOW + 3_600_000));

        let codex = super::codex(
            json!({"OPENAI_API_KEY": null, "tokens": {
                "id_token": jwt(NOW / 1000 + 600), "access_token": jwt(NOW / 1000 + 864_000),
                "refresh_token": "invented-refresh", "account_id": "invented-account"},
                "last_refresh": "2026-01-01T00:00:00Z"})
            .to_string()
            .as_bytes(),
            NOW,
        )
        .unwrap();
        let auth: Value = serde_json::from_str(&text(&codex, "auth.json")).unwrap();
        assert_eq!(auth["tokens"]["refresh_token"], "");
        assert_eq!(auth["tokens"]["account_id"], "invented-account");
        assert_eq!(auth["last_refresh"], "2027-01-15T08:00:00Z");
        assert!(auth["OPENAI_API_KEY"].is_null());
        assert_eq!(codex.expires_at_ms(), Some(NOW + 864_000_000));

        let zai = super::zai(" invented-zai-key \n").unwrap();
        assert_eq!(text(&zai, "api-key"), "invented-zai-key\n");
        assert_eq!(zai.expires_at_ms(), None);

        for lease in [&claude, &codex, &zai] {
            for (name, bytes) in &lease.files {
                let body = String::from_utf8_lossy(bytes);
                assert!(!body.contains("invented-refresh"), "{name}");
                assert!(!body.contains("nested-refresh"), "{name}");
            }
            // Debug never shows a token.
            assert!(!format!("{lease:?}").contains("invented"));
        }
        // The stage input carries every file, encoded.
        let input: Value = serde_json::from_slice(&claude.stage_input()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(input["files"][".credentials.json"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, claude.files[".credentials.json"]);
    }

    /// Ported from the retired Windows benchmark bridge: only the fields a
    /// session runs on are handed over, no other token and nothing nested.
    #[test]
    fn a_grok_lease_strips_every_other_token() {
        let raw = json!({
            "https://auth.x.ai::scope": {
                "key": "fabricated-access",
                "auth_mode": "oidc",
                "create_time": "2026-10-01T00:00:00Z",
                "user_id": "fabricated-user",
                "refresh_token": "fabricated-refresh",
                "id_token": "fabricated-id-token",
                "session_token": "fabricated-session-token",
                "access_token": "fabricated-second-access",
                "email": "dev@example.com",
                "expires_at": "2030-01-01T00:00:00Z",
                "source": {"refreshToken": "nested-refresh", "issuer": "https://auth.x.ai"},
                "history": [{"refresh_token": "listed-refresh", "kept": 1}]
            },
            "version": 2
        })
        .to_string();
        let lease = grok(raw.as_bytes()).unwrap();
        let stripped = text(&lease, "auth.json");
        for gone in [
            "refresh",
            "id-token",
            "session-token",
            "second-access",
            "source",
            "history",
            "version",
        ] {
            assert!(!stripped.contains(gone), "{gone}: {stripped}");
        }
        let document: Value = serde_json::from_str(&stripped).unwrap();
        let entry = document["https://auth.x.ai::scope"].as_object().unwrap();
        let mut fields: Vec<&str> = entry.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "auth_mode",
                "create_time",
                "email",
                "expires_at",
                "key",
                "user_id"
            ]
        );
        assert_eq!(entry["key"], "fabricated-access");
        assert_eq!(
            lease.expires_at_ms(),
            Some(
                chrono::DateTime::parse_from_rfc3339("2030-01-01T00:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
        assert!(grok(b"not json").is_err());
        assert!(grok(b"[]").is_err());
        assert!(grok(b"{}").is_err());
    }

    #[test]
    fn unreadable_or_unbounded_sign_ins_are_refused() {
        // No access token, no expiry, or an API-key Codex sign-in.
        assert!(super::claude(br#"{"claudeAiOauth":{"expiresAt":1}}"#, None).is_err());
        assert!(super::claude(br#"{"claudeAiOauth":{"accessToken":"a"}}"#, None).is_err());
        assert!(super::claude(b"[]", None).is_err());
        assert!(super::codex(br#"{"OPENAI_API_KEY":"invented-key"}"#, NOW).is_err());
        assert!(super::codex(
            json!({"tokens": {"id_token": "x", "access_token": "not-a-jwt"}})
                .to_string()
                .as_bytes(),
            NOW
        )
        .is_err());
        assert!(super::zai("invented\nkey").is_err());
        assert!(super::zai("").is_err());
        // A Grok sign-in without an expiry is not leased.
        assert!(grok(br#"{"https://auth.x.ai":{"key":"invented","auth_mode":"oidc"}}"#).is_err());
        // An unreadable profile is left out; the grant still leases.
        let lease = super::claude(
            json!({"claudeAiOauth":{"accessToken":"a","expiresAt":NOW}})
                .to_string()
                .as_bytes(),
            Some(b"not json"),
        )
        .unwrap();
        assert_eq!(lease.file_names(), [".credentials.json"]);
    }

    #[test]
    fn a_refresh_token_is_refused_under_any_spelling() {
        for key in [
            "refresh_token",
            "refreshToken",
            "Refresh-Token",
            "REFRESHTOKEN",
        ] {
            assert!(refuse_refresh_tokens(&json!({"a": [{ key: "invented" }]})).is_err());
            assert!(refuse_refresh_tokens(&json!({ key: "" })).is_ok());
            assert!(refuse_refresh_tokens(&json!({ key: null })).is_ok());
        }
        assert!(refuse_refresh_tokens(&json!({"refresh_token": {"value": 1}})).is_err());
        // Other fields that merely mention a refresh are fine.
        assert!(refuse_refresh_tokens(&json!({"last_refresh": "2026-01-01T00:00:00Z"})).is_ok());
    }

    #[test]
    fn jwt_expiry_reads_the_exp_claim() {
        assert_eq!(jwt_expiry_ms(&jwt(1_900_000_000)), Some(1_900_000_000_000));
        assert_eq!(jwt_expiry_ms("a.b.c"), None);
        assert_eq!(jwt_expiry_ms("plain"), None);
        assert_eq!(jwt_expiry_ms(&jwt(0)), None);
    }

    /// A lease must outlast its session, the CLI's own renewal window and
    /// the margin: so no session ever runs while its CLI on Windows renews.
    #[test]
    fn coverage_keeps_every_lease_out_of_the_natural_window() {
        let until = NOW;
        let claude = NativeProvider::Claude;
        assert_eq!(
            required_expiry(claude, until),
            until + CLAUDE_RENEWAL_WINDOW_MS + MARGIN_MS
        );
        assert!(covers(claude, Some(until + 420_000), until));
        assert!(!covers(claude, Some(until + 419_999), until));
        // Codex has no window of its own, a key never expires.
        assert!(covers(
            NativeProvider::Codex,
            Some(until + MARGIN_MS),
            until
        ));
        assert!(!covers(
            NativeProvider::Codex,
            Some(until + MARGIN_MS - 1),
            until
        ));
        assert!(covers(NativeProvider::Zai, None, until));
        // Grok's window is the chat bridge's.
        assert_eq!(
            required_expiry(NativeProvider::Grok, until),
            until + grok::cli_renewal_window_ms() + MARGIN_MS
        );
        assert!(required_expiry(claude, i64::MAX) == i64::MAX);
        assert!(leased(NativeProvider::Zai) && !leased(NativeProvider::Kimi));
    }
}
