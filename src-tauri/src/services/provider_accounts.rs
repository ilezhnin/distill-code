//! Persistent provider connections. The official CLIs own OAuth refresh;
//! Distill owns stable identities and selects a private CLI home per connection.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::AppHandle;

use super::{distill_root, env_key};

static STORE_LOCK: Mutex<()> = Mutex::new(());
static ACCOUNT_CHANGES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Prevent new work while account credentials are being changed. The runtime
/// separately drains an idle bridge and refuses changes during an active turn.
pub struct AccountChangeGuard(String);

pub fn begin_account_change(account_id: &str) -> Result<AccountChangeGuard, String> {
    let mut changes = ACCOUNT_CHANGES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Account change registry is unavailable")?;
    if !changes.insert(account_id.into()) {
        return Err("This account is already being changed".into());
    }
    Ok(AccountChangeGuard(account_id.into()))
}

impl Drop for AccountChangeGuard {
    fn drop(&mut self) {
        if let Ok(mut changes) = ACCOUNT_CHANGES.get_or_init(Mutex::default).lock() {
            changes.remove(&self.0);
        }
    }
}

pub fn account_change_in_progress(account_id: &str) -> bool {
    ACCOUNT_CHANGES
        .get_or_init(Mutex::default)
        .lock()
        .map(|changes| changes.contains(account_id))
        .unwrap_or(true)
}

/// Remove these from the actual child environment as well as the captured map.
/// `Command::envs` alone leaves inherited values in place.
pub const MANAGED_AUTH_ENV_KEYS: &[&str] = &[
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "OPENAI_FEDERATION_RULE_ID",
    "OPENAI_IDENTITY_TOKEN_FILE",
    "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
    "OPENAI_WORKLOAD_IDENTITY",
    "OPENAI_WORKLOAD_IDENTITY_TOKEN",
    "OPENAI_WORKLOAD_IDENTITY_TOKEN_FILE",
    "CODEX_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "ANTHROPIC_PROFILE",
    "CODEX_MANAGED_API_KEY",
    "CODEX_MANAGED_ID_TOKEN",
    "CODEX_MANAGED_ACCESS_TOKEN",
    "CODEX_MANAGED_ACCOUNT_ID",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_MANTLE",
    "DEFAULT_AUTH_REQUEST",
    "MODEL_PROVIDER",
    "CODEX_CONFIG",
    "CODEX_APP_SERVER_LOGIN_ISSUER",
    "CODEX_APP_SERVER_DEV_OPEN_APP_URL",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    #[serde(rename = "oauth")]
    OAuth,
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccount {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub auth_method: AuthMethod,
    pub enabled: bool,
    pub auto_switch: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountsSnapshot {
    pub accounts: Vec<ProviderAccount>,
    pub defaults: HashMap<String, String>,
    pub automatic_switching: HashMap<String, bool>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreDocument {
    schema_version: u32,
    #[serde(flatten)]
    snapshot: ProviderAccountsSnapshot,
}

fn store_lock() -> Result<MutexGuard<'static, ()>, String> {
    STORE_LOCK
        .lock()
        .map_err(|_| "Provider account store is unavailable".into())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn supports_managed_accounts(provider_id: &str) -> bool {
    matches!(provider_id, "codex-acp" | "claude-acp")
}

/// Providers whose own CLI keeps the sign-in (Grok, Kimi). Distill names that
/// sign-in with a fixed identity so benchmark configurations, routes and
/// activity can refer to it; it is never stored, and chats keep using the CLI
/// without an account.
pub fn uses_cli_login(provider_id: &str) -> bool {
    matches!(provider_id, "grok-acp" | "kimi-acp")
}

const CLI_LOGIN_PREFIX: &str = "cli-login-";

pub fn cli_login_account_id(provider_id: &str) -> Option<String> {
    uses_cli_login(provider_id).then(|| format!("{CLI_LOGIN_PREFIX}{provider_id}"))
}

pub fn is_cli_login_account(provider_id: &str, account_id: &str) -> bool {
    cli_login_account_id(provider_id).as_deref() == Some(account_id)
}

/// The CLI sign-in identity `account_id` names, whichever provider it is for.
fn cli_login_account(account_id: &str) -> Option<ProviderAccount> {
    cli_login_account_as(account_id, grok_cli_auth_method)
}

fn cli_login_account_as(
    account_id: &str,
    grok_auth_method: fn() -> AuthMethod,
) -> Option<ProviderAccount> {
    let provider_id = account_id.strip_prefix(CLI_LOGIN_PREFIX)?;
    let (label, auth_method) = match provider_id {
        "grok-acp" => ("Grok CLI sign-in", grok_auth_method()),
        "kimi-acp" => ("Kimi Code sign-in", AuthMethod::OAuth),
        _ => return None,
    };
    Some(ProviderAccount {
        id: account_id.into(),
        provider_id: provider_id.into(),
        label: label.into(),
        auth_method,
        enabled: true,
        auto_switch: false,
        created_at: 0,
        updated_at: 0,
    })
}

/// Grok signs in with its own session, or with `XAI_API_KEY` when it has
/// none. Without either an attempt fails at sign-in, not here.
fn grok_cli_auth_method() -> AuthMethod {
    use super::provider_rate_limits::grok::{read_grok_auth_session, GrokAuthReadResult};
    if !matches!(read_grok_auth_session(), GrokAuthReadResult::Ok(_))
        && super::shell_env::user_env_var("XAI_API_KEY").is_some_and(|key| !key.trim().is_empty())
    {
        AuthMethod::ApiKey
    } else {
        AuthMethod::OAuth
    }
}

fn validate_provider(provider_id: &str) -> Result<(), String> {
    if supports_managed_accounts(provider_id) {
        Ok(())
    } else {
        Err(format!(
            "Multiple accounts are not supported for '{provider_id}'"
        ))
    }
}

fn validate_identity(account: &ProviderAccount) -> Result<(), String> {
    validate_provider(&account.provider_id)?;
    if uuid::Uuid::parse_str(&account.id)
        .map(|id| id.to_string() != account.id)
        .unwrap_or(true)
    {
        return Err("Invalid provider account identity".into());
    }
    Ok(())
}

fn store_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("provider-accounts");
    distill_root::reject_document_links(root, &dir)?;
    Ok(dir)
}

fn account_dir(root: &Path, account: &ProviderAccount) -> Result<PathBuf, String> {
    validate_identity(account)?;
    let path = store_dir(root)?.join(&account.id);
    distill_root::reject_document_links(root, &path)?;
    Ok(path)
}

fn read_store(root: &Path) -> Result<ProviderAccountsSnapshot, String> {
    let path = store_dir(root)?.join("index.json");
    distill_root::reject_document_links(root, &path)?;
    let mut migrated = false;
    let mut snapshot = match fs::read(&path) {
        Ok(bytes) => {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
                "Provider account index is invalid; the original file was preserved"
            })?;
            match value["schemaVersion"].as_u64() {
                Some(1) => {
                    // Retire references to external CLI logins. Never copy or change
                    // their credentials, and keep every Distill-owned account intact.
                    let accounts = value["accounts"]
                        .as_array_mut()
                        .ok_or("Provider account index has no account list")?;
                    let mut retired = HashSet::new();
                    for account in accounts.iter() {
                        if account["authMethod"] == "system" {
                            let provider = account["providerId"]
                                .as_str()
                                .ok_or("Invalid legacy provider account")?;
                            validate_provider(provider)?;
                            let id = format!("system:{provider}");
                            if account["id"].as_str() != Some(id.as_str()) {
                                return Err("Invalid legacy provider account identity".into());
                            }
                            retired.insert(id);
                        }
                    }
                    accounts.retain(|account| account["authMethod"] != "system");
                    let defaults = value["defaults"]
                        .as_object_mut()
                        .ok_or("Provider account index has no defaults")?;
                    defaults.retain(|_, id| !id.as_str().is_some_and(|id| retired.contains(id)));
                    value["schemaVersion"] = serde_json::json!(2);
                    migrated = true;
                }
                Some(2) => {}
                _ => return Err("Unsupported provider account index version".into()),
            }
            let document: StoreDocument = serde_json::from_value(value).map_err(|_| {
                "Provider account index is invalid; the original file was preserved"
            })?;
            if document.schema_version != 2 {
                return Err("Unsupported provider account index version".into());
            }
            document.snapshot
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ProviderAccountsSnapshot::default()
        }
        Err(error) => return Err(format!("Cannot read provider account index: {error}")),
    };
    let mut ids = HashSet::new();
    for account in &mut snapshot.accounts {
        validate_identity(account)?;
        if !ids.insert(account.id.clone()) {
            return Err("Duplicate provider account identity".into());
        }
        // Keep the existing snapshot shape for consumers, but retire account-level
        // opt-outs. The provider switch now controls the entire account group.
        account.enabled = true;
        account.auto_switch = true;
    }
    for provider in ["codex-acp", "claude-acp"] {
        if let Some(first) = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_id == provider)
        {
            snapshot
                .defaults
                .entry(provider.into())
                .or_insert_with(|| first.id.clone());
        }
        snapshot
            .automatic_switching
            .entry(provider.into())
            .or_insert(false);
    }
    for (provider, id) in &snapshot.defaults {
        validate_provider(provider)?;
        if !snapshot
            .accounts
            .iter()
            .any(|account| &account.id == id && &account.provider_id == provider)
        {
            return Err("Provider default references an unknown or mismatched account".into());
        }
    }
    if migrated {
        write_store(root, &snapshot)?;
    }
    Ok(snapshot)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Account file has no parent directory")?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| format!("Cannot save provider account: {error}"))
}

fn write_store(root: &Path, snapshot: &ProviderAccountsSnapshot) -> Result<(), String> {
    let dir = store_dir(root)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create provider account store: {error}"))?;
    protect_directory(&dir)?;
    let path = dir.join("index.json");
    distill_root::reject_document_links(root, &path)?;
    let bytes = serde_json::to_vec_pretty(&StoreDocument {
        schema_version: 2,
        snapshot: snapshot.clone(),
    })
    .map_err(|_| "Cannot encode provider account index")?;
    atomic_write(&path, &bytes)
}

pub fn snapshot(app: &AppHandle) -> Result<ProviderAccountsSnapshot, String> {
    let _guard = store_lock()?;
    read_store(&distill_root::app_root(app)?)
}

pub fn account(app: &AppHandle, id: &str) -> Result<ProviderAccount, String> {
    if let Some(identity) = cli_login_account(id) {
        return Ok(identity);
    }
    snapshot(app)?
        .accounts
        .into_iter()
        .find(|account| account.id == id)
        .ok_or_else(|| "Provider account does not exist".into())
}

fn resolve_from(
    snapshot: &ProviderAccountsSnapshot,
    provider_id: &str,
    explicit_id: Option<&str>,
) -> Result<ProviderAccount, String> {
    validate_provider(provider_id)?;
    let id = explicit_id
        .or_else(|| snapshot.defaults.get(provider_id).map(String::as_str))
        .ok_or("Sign in to an account in Settings > AI providers")?;
    let account = snapshot
        .accounts
        .iter()
        .find(|account| account.id == id)
        .ok_or("Provider account does not exist")?;
    if account.provider_id != provider_id {
        return Err("Account belongs to a different provider".into());
    }
    if !account.enabled {
        return Err("Provider account is disabled".into());
    }
    Ok(account.clone())
}

fn cli_login_for(identity: ProviderAccount, provider_id: &str) -> Result<ProviderAccount, String> {
    if identity.provider_id == provider_id {
        Ok(identity)
    } else {
        Err("Account belongs to a different provider".into())
    }
}

pub fn resolve_account(
    app: &AppHandle,
    provider_id: &str,
    explicit_id: Option<&str>,
) -> Result<ProviderAccount, String> {
    if let Some(identity) = explicit_id.and_then(cli_login_account) {
        return cli_login_for(identity, provider_id);
    }
    let account = resolve_from(&snapshot(app)?, provider_id, explicit_id)?;
    if account_change_in_progress(&account.id) {
        return Err("Account authorization is being changed; try again when it completes".into());
    }
    Ok(account)
}

fn prepare_home(root: &Path, account: &ProviderAccount) -> Result<PathBuf, String> {
    let dir = account_dir(root, account)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create provider account directory: {error}"))?;
    protect_directory(&dir)?;
    let home = dir.join("home");
    distill_root::reject_document_links(root, &home)?;
    fs::create_dir_all(&home)
        .map_err(|error| format!("Cannot create isolated CLI home: {error}"))?;
    protect_directory(&home)?;
    if account.provider_id == "codex-acp" {
        // A private file store avoids any machine-wide keychain backend selected
        // by a user's system Codex config. CLI token refresh stays in this home.
        let config = home.join("config.toml");
        distill_root::reject_document_links(root, &config)?;
        distill_root::create_missing_file(&config, "cli_auth_credentials_store = \"file\"\n")?;
    }
    Ok(home)
}

pub fn account_home(app: &AppHandle, account: &ProviderAccount) -> Result<PathBuf, String> {
    validate_identity(account)?;
    let root = distill_root::app_root(app)?;
    let path = account_dir(&root, account)?.join("home");
    distill_root::reject_document_links(&root, &path)?;
    Ok(path)
}

fn secret_path(root: &Path, account: &ProviderAccount) -> Result<PathBuf, String> {
    let path = account_dir(root, account)?.join("api-key.dat");
    distill_root::reject_document_links(root, &path)?;
    Ok(path)
}

fn write_api_key(root: &Path, account: &ProviderAccount, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 16384 || key.contains(['\r', '\n', '\0']) {
        return Err("Enter a non-empty API key without line breaks".into());
    }
    prepare_home(root, account)?;
    let protected = protect_secret(key.as_bytes())?;
    atomic_write(&secret_path(root, account)?, &protected)
}

fn read_api_key(root: &Path, account: &ProviderAccount) -> Result<String, String> {
    let bytes =
        fs::read(secret_path(root, account)?).map_err(|_| "API key is missing or unavailable")?;
    let clear = unprotect_secret(&bytes)?;
    String::from_utf8(clear).map_err(|_| "Stored API key is invalid".into())
}

fn scoped_env_at(
    root: &Path,
    account: &ProviderAccount,
    mut base: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, String> {
    // The CLI keeps this sign-in itself: nothing to install or prepare.
    if is_cli_login_account(&account.provider_id, &account.id) {
        return Ok(base);
    }
    validate_identity(account)?;
    base.retain(|(key, _)| {
        !MANAGED_AUTH_ENV_KEYS
            .iter()
            .any(|removed| env_key::matches(key, removed))
    });
    let home = prepare_home(root, account)?;
    let home_key = if account.provider_id == "codex-acp" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    };
    env_key::upsert_vec(&mut base, home_key, home.to_string_lossy().into_owned());
    if account.auth_method == AuthMethod::ApiKey {
        let key = read_api_key(root, account)?;
        let key_name = if account.provider_id == "codex-acp" {
            "CODEX_API_KEY"
        } else {
            "ANTHROPIC_API_KEY"
        };
        env_key::upsert_vec(&mut base, key_name, key);
        if account.provider_id == "codex-acp" {
            env_key::upsert_vec(
                &mut base,
                "DEFAULT_AUTH_REQUEST",
                "{\"methodId\":\"api-key\"}".into(),
            );
        }
    }
    Ok(base)
}

pub fn scoped_env(
    app: &AppHandle,
    account: &ProviderAccount,
    base: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, String> {
    if account_change_in_progress(&account.id) {
        return Err("Account authorization is being changed; try again when it completes".into());
    }
    scoped_env_at(&distill_root::app_root(app)?, account, base)
}

/// Presence is a local diagnostic, not evidence that the provider accepted a
/// credential. An expired OAuth access token with a refresh token remains usable.
pub fn account_has_credentials(app: &AppHandle, account: &ProviderAccount) -> Result<bool, String> {
    if account.auth_method == AuthMethod::ApiKey {
        let root = distill_root::app_root(app)?;
        if !secret_path(&root, account)?
            .try_exists()
            .map_err(|_| "Cannot inspect account credentials")?
        {
            return Ok(false);
        }
        return read_api_key(&root, account).map(|value| !value.is_empty());
    }
    let home = account_home(app, account)?;
    let file = home.join(if account.provider_id == "codex-acp" {
        "auth.json"
    } else {
        ".credentials.json"
    });
    distill_root::reject_document_links(&distill_root::app_root(app)?, &file)?;
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("Cannot inspect account credentials".into()),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Stored account credentials are invalid")?;
    Ok(match account.provider_id.as_str() {
        "codex-acp" => [
            "/tokens/refresh_token",
            "/tokens/access_token",
            "/OPENAI_API_KEY",
        ]
        .iter()
        .any(|path| {
            value
                .pointer(path)
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty())
        }),
        _ => ["/claudeAiOauth/refreshToken", "/claudeAiOauth/accessToken"]
            .iter()
            .any(|path| {
                value
                    .pointer(path)
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| !value.is_empty())
            }),
    })
}

pub fn clear_api_credentials(app: &AppHandle, account_id: &str) -> Result<(), String> {
    let root = distill_root::app_root(app)?;
    let _guard = store_lock()?;
    let snapshot = read_store(&root)?;
    let account = snapshot
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .ok_or("Provider account does not exist")?;
    clear_api_credentials_at(&root, account)
}

fn clear_api_credentials_at(root: &Path, account: &ProviderAccount) -> Result<(), String> {
    if account.auth_method != AuthMethod::ApiKey {
        return Err("Only API accounts use local key sign-out".into());
    }
    let home = account_dir(root, account)?.join("home");
    let paths = [
        secret_path(root, account)?,
        home.join("auth.json"),
        home.join(".credentials.json"),
    ];
    for path in &paths {
        distill_root::reject_document_links(root, path)?;
    }
    for path in &paths {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot clear this account's saved credentials".into()),
        }
    }
    Ok(())
}

pub fn add_account(
    app: &AppHandle,
    provider_id: String,
    label: String,
    auth_method: AuthMethod,
    api_key: Option<String>,
) -> Result<ProviderAccount, String> {
    let root = distill_root::app_root(app)?;
    let _guard = store_lock()?;
    add_account_at(&root, provider_id, label, auth_method, api_key)
}

fn clean_label(label: String) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 120 || label.chars().any(char::is_control) {
        return Err("Account name must contain between 1 and 120 characters".into());
    }
    Ok(label.into())
}

fn add_account_at(
    root: &Path,
    provider_id: String,
    label: String,
    auth_method: AuthMethod,
    api_key: Option<String>,
) -> Result<ProviderAccount, String> {
    validate_provider(&provider_id)?;
    if auth_method == AuthMethod::OAuth && api_key.is_some() {
        return Err("OAuth accounts do not accept an API key".into());
    }
    let label = clean_label(label)?;
    let mut snapshot = read_store(root)?;
    // Retrying Add after an interrupted browser login must resume the same
    // connection. Keep its stable ID, private home and chat references. The
    // caller probes saved authorization before deciding whether to sign in.
    if auth_method == AuthMethod::OAuth {
        let normalized_label = label.to_lowercase();
        if let Some(existing) = snapshot.accounts.iter().find(|account| {
            account.provider_id == provider_id
                && account.auth_method == AuthMethod::OAuth
                && account.label.trim().to_lowercase() == normalized_label
        }) {
            return Ok(existing.clone());
        }
    }
    let now = now_ms();
    let account = ProviderAccount {
        id: uuid::Uuid::new_v4().to_string(),
        provider_id,
        label,
        auth_method,
        enabled: true,
        auto_switch: true,
        created_at: now,
        updated_at: now,
    };
    if auth_method == AuthMethod::ApiKey {
        write_api_key(
            root,
            &account,
            api_key.as_deref().ok_or("An API key is required")?,
        )?;
    } else {
        prepare_home(root, &account)?;
    }
    snapshot.accounts.push(account.clone());
    snapshot
        .defaults
        .entry(account.provider_id.clone())
        .or_insert_with(|| account.id.clone());
    write_store(root, &snapshot)?;
    Ok(account)
}

pub fn update_account(
    app: &AppHandle,
    account_id: &str,
    label: Option<String>,
    api_key: Option<String>,
) -> Result<ProviderAccount, String> {
    let root = distill_root::app_root(app)?;
    let _guard = store_lock()?;
    let mut snapshot = read_store(&root)?;
    let account = snapshot
        .accounts
        .iter_mut()
        .find(|account| account.id == account_id)
        .ok_or("Provider account does not exist")?;
    if let Some(label) = label {
        account.label = clean_label(label)?;
    }
    if let Some(key) = api_key {
        if account.auth_method != AuthMethod::ApiKey {
            return Err("Only API-key accounts accept a key".into());
        }
        write_api_key(&root, account, &key)?;
    }
    account.updated_at = now_ms();
    let result = account.clone();
    write_store(&root, &snapshot)?;
    Ok(result)
}

pub fn remove_account(
    app: &AppHandle,
    account_id: &str,
) -> Result<ProviderAccountsSnapshot, String> {
    let root = distill_root::app_root(app)?;
    let _guard = store_lock()?;
    remove_account_at(&root, account_id)
}

fn remove_account_at(root: &Path, account_id: &str) -> Result<ProviderAccountsSnapshot, String> {
    let mut snapshot = read_store(root)?;
    let account = snapshot
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .ok_or("Provider account does not exist")?
        .clone();
    snapshot.accounts.retain(|account| account.id != account_id);
    snapshot.defaults.retain(|provider, id| {
        if id == account_id {
            if let Some(next) = snapshot
                .accounts
                .iter()
                .find(|account| &account.provider_id == provider)
            {
                *id = next.id.clone();
            } else {
                return false;
            }
        }
        true
    });
    // Stage credential removal so a failed index save can restore the account.
    // The account mutation guard keeps provider processes out of this transition.
    let home = account_dir(root, &account)?.join("home");
    let paths = [
        secret_path(root, &account)?,
        home.join("auth.json"),
        home.join(".credentials.json"),
    ];
    // Check every path before moving any file.
    for path in &paths {
        distill_root::reject_document_links(root, path)?;
    }
    let mut staged = Vec::new();
    let removal = (|| {
        for path in &paths {
            let backup = path.with_extension(format!("remove-{}", uuid::Uuid::new_v4()));
            match fs::rename(path, &backup) {
                Ok(()) => staged.push((path.clone(), backup)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Cannot remove saved account credentials".into()),
            }
        }
        write_store(root, &snapshot)
    })();
    if let Err(error) = removal {
        let mut restore_failed = false;
        for (path, backup) in staged.iter().rev() {
            restore_failed |= fs::rename(backup, path).is_err();
        }
        return Err(if restore_failed {
            format!("{error}; credential recovery files remain in the private account directory")
        } else {
            error
        });
    }
    for (_, backup) in staged {
        fs::remove_file(backup).map_err(|_| "Account removed, but a credential recovery file could not be deleted from its private directory")?;
    }
    Ok(snapshot)
}

pub fn set_default(
    app: &AppHandle,
    provider_id: &str,
    account_id: &str,
) -> Result<ProviderAccountsSnapshot, String> {
    let root = distill_root::app_root(app)?;
    let _guard = store_lock()?;
    let mut snapshot = read_store(&root)?;
    resolve_from(&snapshot, provider_id, Some(account_id))?;
    snapshot
        .defaults
        .insert(provider_id.into(), account_id.into());
    write_store(&root, &snapshot)?;
    Ok(snapshot)
}

pub fn set_routing(
    app: &AppHandle,
    provider_id: &str,
    automatic_switching: bool,
) -> Result<ProviderAccountsSnapshot, String> {
    validate_provider(provider_id)?;
    let root = distill_root::app_root(app)?;
    let _guard = store_lock()?;
    let mut snapshot = read_store(&root)?;
    snapshot
        .automatic_switching
        .insert(provider_id.into(), automatic_switching);
    write_store(&root, &snapshot)?;
    Ok(snapshot)
}

#[cfg(windows)]
mod windows_security {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct Blob {
        length: u32,
        data: *mut u8,
    }

    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "Advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn SetFileSecurityW(path: *const u16, information: u32, descriptor: *const c_void) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub(super) fn directory(path: &Path) -> Result<(), String> {
        // Protected DACL: owner and SYSTEM only, inherited by CLI credential files.
        let sddl: Vec<u16> = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)\0"
            .encode_utf16()
            .collect();
        let mut descriptor = std::ptr::null_mut();
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err("Cannot build private credential-directory permissions".into());
            }
            let result = SetFileSecurityW(path.as_ptr(), 0x8000_0004, descriptor);
            LocalFree(descriptor);
            if result == 0 {
                return Err("Cannot restrict credential directory to its owner".into());
            }
        }
        Ok(())
    }

    pub(super) fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let input = Blob {
            length: u32::try_from(bytes.len()).map_err(|_| "Credential is too large")?,
            data: bytes.as_ptr() as *mut u8,
        };
        let mut output = Blob {
            length: 0,
            data: std::ptr::null_mut(),
        };
        // CRYPTPROTECT_UI_FORBIDDEN; machine scope deliberately remains off.
        let success = unsafe {
            if encrypt {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    1,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    1,
                    &mut output,
                )
            }
        };
        if success == 0 {
            return Err(
                "Windows could not unlock or protect the saved API key for this user".into(),
            );
        }
        let result =
            unsafe { std::slice::from_raw_parts(output.data, output.length as usize).to_vec() };
        unsafe {
            LocalFree(output.data.cast());
        }
        Ok(result)
    }
}

/// Restricts `path` to its owner (and SYSTEM on Windows), inherited by what
/// is created in it.
pub(crate) fn protect_directory(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_security::directory(path)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot restrict credential directory permissions".into())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        Err("Protected account storage is unavailable on this platform".into())
    }
}

fn protect_secret(bytes: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        windows_security::crypt(bytes, true)
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err("Saved API keys require Windows protected storage".into())
    }
}

fn unprotect_secret(bytes: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        windows_security::crypt(bytes, false)
    }
    #[cfg(not(windows))]
    {
        let _ = bytes;
        Err("Saved API keys require Windows protected storage".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_subscription_add_resumes_the_same_pending_account() {
        for provider in ["codex-acp", "claude-acp"] {
            let root = tempfile::tempdir().unwrap();
            let first = add_account_at(
                root.path(),
                provider.into(),
                "person@example.test".into(),
                AuthMethod::OAuth,
                None,
            )
            .unwrap();
            let index = store_dir(root.path()).unwrap().join("index.json");
            let before = fs::read(&index).unwrap();
            for label in ["person@example.test", "  PERSON@EXAMPLE.TEST  "] {
                let retry = add_account_at(
                    root.path(),
                    provider.into(),
                    label.into(),
                    AuthMethod::OAuth,
                    None,
                )
                .unwrap();
                assert_eq!(retry, first);
                assert_eq!(fs::read(&index).unwrap(), before);
            }
            let snapshot = read_store(root.path()).unwrap();
            assert_eq!(snapshot.accounts, vec![first.clone()]);
            assert_eq!(snapshot.defaults[provider], first.id);
        }
    }

    #[test]
    fn repeated_subscription_add_preserves_saved_credentials_and_history() {
        let root = tempfile::tempdir().unwrap();
        let first = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Personal".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let home = account_dir(root.path(), &first).unwrap().join("home");
        fs::write(home.join("auth.json"), "fixture credentials").unwrap();
        fs::write(home.join("history.jsonl"), "fixture history").unwrap();
        let retry = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Personal".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        assert_eq!(retry, first);
        assert_eq!(
            fs::read_to_string(home.join("auth.json")).unwrap(),
            "fixture credentials"
        );
        assert_eq!(
            fs::read_to_string(home.join("history.jsonl")).unwrap(),
            "fixture history"
        );
    }

    #[test]
    fn subscription_names_are_scoped_to_the_provider() {
        let root = tempfile::tempdir().unwrap();
        let codex = add_account_at(
            root.path(),
            "codex-acp".into(),
            "person@example.test".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let claude = add_account_at(
            root.path(),
            "claude-acp".into(),
            "person@example.test".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let other = add_account_at(
            root.path(),
            "codex-acp".into(),
            "other@example.test".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        assert_ne!(codex.id, claude.id);
        assert_ne!(codex.id, other.id);
        assert_eq!(read_store(root.path()).unwrap().accounts.len(), 3);
    }

    #[test]
    fn absent_index_starts_without_accounts_or_external_credentials() {
        let root = tempfile::tempdir().unwrap();
        let snapshot = read_store(root.path()).unwrap();
        assert!(snapshot.accounts.is_empty());
        assert!(snapshot.defaults.is_empty());
        assert!(resolve_from(&snapshot, "codex-acp", None).is_err());
        assert!(!root.path().join("provider-accounts").exists());
    }

    #[test]
    fn retiring_external_logins_preserves_connected_accounts_and_credentials() {
        let root = tempfile::tempdir().unwrap();
        let saved = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Personal".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let home = account_dir(root.path(), &saved).unwrap().join("home");
        fs::write(home.join("auth.json"), "saved credentials").unwrap();
        fs::write(home.join("history.jsonl"), "saved history").unwrap();
        let path = store_dir(root.path()).unwrap().join("index.json");
        let mut old = serde_json::to_value(StoreDocument {
            schema_version: 1,
            snapshot: read_store(root.path()).unwrap(),
        })
        .unwrap();
        for provider in ["codex-acp", "claude-acp"] {
            let id = format!("system:{provider}");
            old["accounts"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "id": id, "providerId": provider, "label": "External CLI",
                    "authMethod": "system", "enabled": true, "autoSwitch": true,
                    "createdAt": 0, "updatedAt": 0
                }));
            old["defaults"][provider] = serde_json::json!(id);
        }
        old["automaticSwitching"]["codex-acp"] = serde_json::json!(true);
        fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        let loaded = read_store(root.path()).unwrap();
        assert_eq!(loaded.accounts, vec![saved.clone()]);
        assert_eq!(loaded.defaults.len(), 1);
        assert_eq!(loaded.defaults["codex-acp"], saved.id);
        assert!(loaded.automatic_switching["codex-acp"]);
        assert_eq!(
            fs::read_to_string(home.join("auth.json")).unwrap(),
            "saved credentials"
        );
        assert_eq!(
            fs::read_to_string(home.join("history.jsonl")).unwrap(),
            "saved history"
        );
        let migrated = fs::read(&path).unwrap();
        assert_eq!(
            serde_json::from_slice::<StoreDocument>(&migrated)
                .unwrap()
                .schema_version,
            2
        );
        assert_eq!(read_store(root.path()).unwrap().accounts, loaded.accounts);
        assert_eq!(fs::read(path).unwrap(), migrated);
        assert!(serde_json::from_str::<AuthMethod>("\"system\"").is_err());
    }

    #[test]
    fn removing_the_last_account_leaves_no_implicit_login() {
        let root = tempfile::tempdir().unwrap();
        let first = add_account_at(
            root.path(),
            "codex-acp".into(),
            "First".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let second = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Second".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let after = remove_account_at(root.path(), &first.id).unwrap();
        assert_eq!(after.defaults["codex-acp"], second.id);
        let after = remove_account_at(root.path(), &second.id).unwrap();
        assert!(after.defaults.is_empty());
        assert!(after.accounts.is_empty());
        assert!(read_store(root.path()).unwrap().accounts.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn api_sign_out_clears_only_selected_credentials_and_preserves_history() {
        let root = tempfile::tempdir().unwrap();
        let one = add_account_at(
            root.path(),
            "codex-acp".into(),
            "One".into(),
            AuthMethod::ApiKey,
            Some("fixture-one".into()),
        )
        .unwrap();
        let two = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Two".into(),
            AuthMethod::ApiKey,
            Some("fixture-two".into()),
        )
        .unwrap();
        let home = account_dir(root.path(), &one).unwrap().join("home");
        fs::write(home.join("auth.json"), "fixture-cli-key").unwrap();
        fs::write(home.join("history.jsonl"), "saved history").unwrap();
        let before = fs::read(root.path().join("provider-accounts/index.json")).unwrap();
        clear_api_credentials_at(root.path(), &one).unwrap();
        assert!(!secret_path(root.path(), &one).unwrap().exists());
        assert!(!home.join("auth.json").exists());
        assert_eq!(read_api_key(root.path(), &two).unwrap(), "fixture-two");
        assert_eq!(
            fs::read_to_string(home.join("history.jsonl")).unwrap(),
            "saved history"
        );
        assert_eq!(
            fs::read(root.path().join("provider-accounts/index.json")).unwrap(),
            before
        );
        clear_api_credentials_at(root.path(), &one).unwrap();
        let mut subscription = one.clone();
        subscription.auth_method = AuthMethod::OAuth;
        assert!(clear_api_credentials_at(root.path(), &subscription).is_err());
    }

    #[test]
    fn legacy_account_opt_outs_do_not_override_provider_group_routing() {
        let root = tempfile::tempdir().unwrap();
        for provider in ["codex-acp", "claude-acp"] {
            add_account_at(
                root.path(),
                provider.into(),
                "Personal".into(),
                AuthMethod::OAuth,
                None,
            )
            .unwrap();
        }
        let mut snapshot = read_store(root.path()).unwrap();
        snapshot
            .automatic_switching
            .insert("codex-acp".into(), true);
        for account in &mut snapshot.accounts {
            account.enabled = false;
            account.auto_switch = false;
        }
        write_store(root.path(), &snapshot).unwrap();

        let loaded = read_store(root.path()).unwrap();
        assert!(loaded
            .accounts
            .iter()
            .all(|account| account.enabled && account.auto_switch));
        assert_eq!(loaded.defaults, snapshot.defaults);
        assert_eq!(loaded.automatic_switching, snapshot.automatic_switching);
        assert!(resolve_from(&loaded, "codex-acp", None).is_ok());
        assert!(resolve_from(&loaded, "claude-acp", None).is_ok());
    }

    #[test]
    fn account_resolution_rejects_unknown_mismatched_and_disabled_accounts() {
        let root = tempfile::tempdir().unwrap();
        add_account_at(
            root.path(),
            "codex-acp".into(),
            "Personal".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let other = add_account_at(
            root.path(),
            "claude-acp".into(),
            "Personal".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let mut snapshot = read_store(root.path()).unwrap();
        assert!(resolve_from(&snapshot, "codex-acp", Some("missing")).is_err());
        assert!(resolve_from(&snapshot, "codex-acp", Some(&other.id)).is_err());
        snapshot.accounts[0].enabled = false;
        assert!(resolve_from(&snapshot, "codex-acp", None).is_err());
        assert!(resolve_from(&snapshot, "unknown", None).is_err());
    }

    #[test]
    fn oauth_accounts_are_persistent_and_isolated_from_inherited_auth() {
        let root = tempfile::tempdir().unwrap();
        let one = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Personal".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let two = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Work".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let base = vec![
            ("OPENAI_API_KEY".into(), "not-this-account".into()),
            ("CODEX_HOME".into(), "system-home".into()),
            ("PATH".into(), "tools".into()),
        ];
        let first: HashMap<_, _> = scoped_env_at(root.path(), &one, base.clone())
            .unwrap()
            .into_iter()
            .collect();
        let second: HashMap<_, _> = scoped_env_at(root.path(), &two, base.clone())
            .unwrap()
            .into_iter()
            .collect();
        assert_ne!(first["CODEX_HOME"], second["CODEX_HOME"]);
        assert!(!first.contains_key("OPENAI_API_KEY"));
        assert_eq!(first["PATH"], "tools");
        let saved = read_store(root.path()).unwrap();
        assert_eq!(saved.accounts.len(), 2);
        assert_eq!(saved.defaults["codex-acp"], one.id);
    }

    #[test]
    fn invalid_or_newer_index_is_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("provider-accounts");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.json");
        fs::write(&path, "{bad}").unwrap();
        assert!(read_store(root.path()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "{bad}");
    }

    #[cfg(windows)]
    #[test]
    fn failed_account_removal_preserves_credentials_and_roster() {
        let root = tempfile::tempdir().unwrap();
        let account = add_account_at(
            root.path(),
            "codex-acp".into(),
            "Test".into(),
            AuthMethod::OAuth,
            None,
        )
        .unwrap();
        let credentials = account_dir(root.path(), &account)
            .unwrap()
            .join("home/auth.json");
        fs::write(&credentials, "synthetic credentials").unwrap();
        let index = store_dir(root.path()).unwrap().join("index.json");
        let original_permissions = fs::metadata(&index).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&index, permissions.clone()).unwrap();
        let result = remove_account_at(root.path(), &account.id);
        fs::set_permissions(&index, original_permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&credentials).unwrap(),
            "synthetic credentials"
        );
        assert!(read_store(root.path())
            .unwrap()
            .accounts
            .iter()
            .any(|saved| saved.id == account.id));
        remove_account_at(root.path(), &account.id).unwrap();
        assert!(!credentials.exists());
        assert!(!read_store(root.path())
            .unwrap()
            .accounts
            .iter()
            .any(|saved| saved.id == account.id));
    }

    #[cfg(windows)]
    #[test]
    fn api_keys_are_dpapi_protected_and_never_in_account_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let key = "sk-account-isolation-test-secret";
        let account = add_account_at(
            root.path(),
            "claude-acp".into(),
            "API".into(),
            AuthMethod::ApiKey,
            Some(key.into()),
        )
        .unwrap();
        let bytes = fs::read(secret_path(root.path(), &account).unwrap()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(key));
        assert_eq!(read_api_key(root.path(), &account).unwrap(), key);
        let snapshot = read_store(root.path()).unwrap();
        assert!(!serde_json::to_string(&snapshot).unwrap().contains(key));
        assert!(!format!("{snapshot:?}").contains(key));
        let env: HashMap<_, _> = scoped_env_at(root.path(), &account, vec![])
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(env["ANTHROPIC_API_KEY"], key);
    }

    #[test]
    fn cli_login_identity_resolves_without_the_store() {
        // Built without any store, and with Grok's sign-in kind supplied here
        // instead of read from the user's Grok home.
        let grok = cli_login_account_as("cli-login-grok-acp", || AuthMethod::ApiKey).unwrap();
        assert_eq!(grok.provider_id, "grok-acp");
        assert_eq!(grok.label, "Grok CLI sign-in");
        assert_eq!(grok.auth_method, AuthMethod::ApiKey);
        assert!(grok.enabled && !grok.auto_switch);
        let kimi = cli_login_account("cli-login-kimi-acp").unwrap();
        assert_eq!(kimi.provider_id, "kimi-acp");
        assert_eq!(kimi.auth_method, AuthMethod::OAuth);
        assert_eq!(cli_login_for(kimi.clone(), "kimi-acp"), Ok(kimi.clone()));
        assert_eq!(
            cli_login_for(kimi, "grok-acp"),
            Err("Account belongs to a different provider".into())
        );
        // Managed providers have no CLI identity; their ids go to the store.
        for id in [
            "cli-login-codex-acp",
            "cli-login-claude-acp",
            "cli-login-",
            "kimi-acp",
        ] {
            assert!(cli_login_account(id).is_none(), "{id}");
        }
        assert_eq!(
            cli_login_account_id("grok-acp").as_deref(),
            Some("cli-login-grok-acp")
        );
        assert_eq!(cli_login_account_id("claude-acp"), None);
        assert!(is_cli_login_account("kimi-acp", "cli-login-kimi-acp"));
        assert!(!is_cli_login_account("grok-acp", "cli-login-kimi-acp"));
    }

    #[test]
    fn cli_login_identity_resolves_for_grok_only() {
        let grok = cli_login_account_as("cli-login-grok-acp", || AuthMethod::OAuth).unwrap();
        assert_eq!(cli_login_for(grok.clone(), "grok-acp"), Ok(grok.clone()));
        for other in ["kimi-acp", "codex-acp", "claude-acp"] {
            assert_eq!(
                cli_login_for(grok.clone(), other),
                Err("Account belongs to a different provider".into()),
                "{other}"
            );
        }
        // Grok's sign-in kind follows what its CLI would use.
        assert_eq!(
            cli_login_account_as("cli-login-grok-acp", || AuthMethod::ApiKey)
                .unwrap()
                .auth_method,
            AuthMethod::ApiKey
        );
    }

    #[test]
    fn cli_login_identity_resolves_for_kimi() {
        let kimi = cli_login_account("cli-login-kimi-acp").unwrap();
        assert_eq!(kimi.label, "Kimi Code sign-in");
        assert_eq!(kimi.auth_method, AuthMethod::OAuth);
        assert_eq!(cli_login_for(kimi.clone(), "kimi-acp"), Ok(kimi.clone()));
        for other in ["grok-acp", "codex-acp", "claude-acp"] {
            assert_eq!(
                cli_login_for(kimi.clone(), other),
                Err("Account belongs to a different provider".into()),
                "{other}"
            );
        }
        assert_eq!(
            cli_login_account_id("kimi-acp").as_deref(),
            Some("cli-login-kimi-acp")
        );
    }

    #[test]
    fn cli_login_scoped_env_is_the_base_env() {
        let root = tempfile::tempdir().unwrap();
        let identity = cli_login_account("cli-login-kimi-acp").unwrap();
        let base = vec![
            ("PATH".to_string(), r"C:\bin".to_string()),
            ("KIMI_API_KEY".to_string(), "user-key".to_string()),
        ];
        assert_eq!(
            scoped_env_at(root.path(), &identity, base.clone()).unwrap(),
            base
        );
        // Nothing is prepared for it: no account directory, no key file.
        assert!(!root.path().join("provider-accounts").exists());
    }

    #[test]
    fn managed_accounts_unchanged_for_grok_and_kimi() {
        let root = tempfile::tempdir().unwrap();
        for provider in ["grok-acp", "kimi-acp"] {
            assert!(!supports_managed_accounts(provider));
            assert!(uses_cli_login(provider));
            assert!(add_account_at(
                root.path(),
                provider.into(),
                "CLI".into(),
                AuthMethod::OAuth,
                None
            )
            .is_err());
            let snapshot = read_store(root.path()).unwrap();
            assert!(resolve_from(&snapshot, provider, None).is_err());
            // The identity never enters the stored snapshot Settings lists.
            assert!(snapshot.accounts.is_empty());
            assert!(!snapshot.defaults.contains_key(provider));
        }
        for provider in ["codex-acp", "claude-acp"] {
            assert!(supports_managed_accounts(provider));
            assert!(!uses_cli_login(provider));
        }
    }
}
