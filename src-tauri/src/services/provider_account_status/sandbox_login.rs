//! Whether the benchmark sandbox spends a Claude account under the login the
//! app reads its usage with. 10-18: the sandbox's b55a sign-in was the owner's
//! Claude Code login, so the app read 0 % used on b55a's own login all day
//! while the sandbox spent another one. A sandbox on another login makes the
//! app's usage read say nothing about what the sandbox spends.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Deserialize;
use tauri::AppHandle;

use crate::services::{benchmark_sandbox, distill_root, provider_accounts};

/// What `account_id` reads is a login the sandbox does not spend: both
/// report an account uuid and they differ. Unknown on either side (helpers
/// from before the sandbox reported it, an app login with no `.claude.json`)
/// is no mismatch, so nothing changes until it is known. Nothing is read
/// while the sandbox reports no login for the account.
pub(crate) fn mismatch(app: &AppHandle, account_id: &str) -> bool {
    let Some(sandbox) = benchmark_sandbox::sandbox_login("claude", account_id) else {
        return false;
    };
    let Ok(account) = provider_accounts::account(app, account_id) else {
        return false;
    };
    if account.provider_id != "claude-acp" {
        return false;
    }
    let mismatch = differs(app_login(app, &account).as_deref(), Some(&sandbox));
    report(account_id, mismatch);
    mismatch
}

/// Whether two known account uuids differ.
fn differs(app: Option<&str>, sandbox: Option<&str>) -> bool {
    matches!((app, sandbox), (Some(app), Some(sandbox)) if app != sandbox)
}

/// The fields of a CLI home's `.claude.json` read here: the account uuid,
/// nothing else of the document is kept.
#[derive(Deserialize)]
struct ClaudeHome {
    #[serde(rename = "oauthAccount")]
    oauth_account: Option<OauthAccount>,
}

#[derive(Deserialize)]
struct OauthAccount {
    #[serde(rename = "accountUuid")]
    account_uuid: Option<String>,
}

/// By CLI home file, when it was last read and the login it named.
type LoginReads = HashMap<PathBuf, (SystemTime, Option<String>)>;

/// The account uuid of the login the app keeps for `account`, from its CLI
/// home's `.claude.json`, read again only when the file changed.
fn app_login(app: &AppHandle, account: &provider_accounts::ProviderAccount) -> Option<String> {
    static READ: Mutex<Option<LoginReads>> = Mutex::new(None);
    let root = distill_root::app_root(app).ok()?;
    let path = provider_accounts::account_home(app, account)
        .ok()?
        .join(".claude.json");
    distill_root::reject_document_links(&root, &path).ok()?;
    let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
    let mut read = READ
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cache = read.get_or_insert_with(HashMap::new);
    if let Some((_, login)) = cache.get(&path).filter(|(seen, _)| *seen == modified) {
        return login.clone();
    }
    let login = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ClaudeHome>(&bytes).ok())
        .and_then(|home| home.oauth_account?.account_uuid)
        .and_then(|id| uuid::Uuid::parse_str(&id).ok())
        .map(|id| id.to_string());
    cache.insert(path, (modified, login.clone()));
    login
}

/// Logs a mismatch when it is first seen and when it clears.
fn report(account_id: &str, mismatch: bool) {
    static SEEN: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());
    let mut seen = SEEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let before = seen
        .insert(account_id.to_owned(), mismatch)
        .unwrap_or(false);
    if mismatch && !before {
        log::warn!(
            "[benchmarks] the benchmark sandbox is signed in to account {account_id} as another login than the app reads; its usage counts as unknown until the sandbox login is renewed (bench-login)"
        );
    } else if before && !mismatch {
        log::info!(
            "[benchmarks] the sandbox login of account {account_id} matches the app's again"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_two_known_different_logins_are_a_mismatch() {
        let a = "0d3c2f0e-6a1b-4c9a-9b1e-3f6d2a7c8e01";
        let b = "7a9e1c42-5d3b-4f60-8a2c-1e4b6d9f0a23";
        assert!(differs(Some(a), Some(b)));
        assert!(!differs(Some(a), Some(a)));
        // Old helpers report nothing; an app login may not say either.
        assert!(!differs(Some(a), None));
        assert!(!differs(None, Some(b)));
        assert!(!differs(None, None));
    }

    #[test]
    fn only_the_account_uuid_is_read_from_a_cli_home() {
        let home: ClaudeHome = serde_json::from_str(
            r#"{"oauthAccount":{"accountUuid":"0D3C2F0E-6A1B-4C9A-9B1E-3F6D2A7C8E01","emailAddress":"invented@example.test"},"projects":{}}"#,
        )
        .unwrap();
        assert_eq!(
            home.oauth_account
                .and_then(|account| account.account_uuid)
                .as_deref(),
            Some("0D3C2F0E-6A1B-4C9A-9B1E-3F6D2A7C8E01")
        );
        let none: ClaudeHome = serde_json::from_str(r#"{"projects":{}}"#).unwrap();
        assert!(none.oauth_account.is_none());
    }
}
