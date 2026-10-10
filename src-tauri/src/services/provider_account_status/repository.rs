//! Account telemetry stays in the same WSL distribution as repository execution.
//! Only native account-control requests run here; no prompt or reset is sent.
use super::{claude, codex, now_ms, AccountState, ProviderAccountStatus};
use crate::services::{benchmark_sandbox as sandbox, provider_accounts::ProviderAccount};

struct Probe {
    id: String,
    stopped: bool,
}

impl Probe {
    fn new() -> Self {
        Self {
            id: format!("status-{}", uuid::Uuid::new_v4()),
            stopped: false,
        }
    }

    fn command(&self, account: &ProviderAccount) -> Result<tokio::process::Command, String> {
        sandbox::valid_id(&account.id).map_err(|_| "Invalid sandbox account id")?;
        let (directory, variable, binary) = match account.provider_id.as_str() {
            "claude-acp" => (
                "claude",
                "CLAUDE_CONFIG_DIR",
                "/opt/distill-tools/bin/claude",
            ),
            "codex-acp" => ("codex", "CODEX_HOME", "/opt/distill-tools/bin/codex"),
            _ => return Err("This provider has no sandbox quota service".into()),
        };
        let home = format!(
            "{variable}=/home/candidate/accounts/{}/{directory}",
            account.id
        );
        Ok(sandbox::command(
            "/usr/local/sbin/bench-run",
            &[
                "login",
                &self.id,
                &home,
                "DISABLE_AUTOUPDATER=1",
                "--",
                binary,
            ],
        ))
    }

    async fn stop(&mut self) -> Result<(), String> {
        sandbox::kill("login", &self.id)
            .await
            .map_err(|_| "Could not stop the sandbox account service")?;
        self.stopped = true;
        Ok(())
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        if !self.stopped {
            // Dropping a cancelled Windows request must also end its Linux children.
            sandbox::kill_mode_detached("login", &self.id);
        }
    }
}

async fn read(account: &ProviderAccount) -> Result<ProviderAccountStatus, String> {
    let status = sandbox::ready()
        .await
        .map_err(|_| "The benchmark sandbox is unavailable or out of date")?;
    if status
        .require_account(
            account
                .provider_id
                .strip_suffix("-acp")
                .unwrap_or(&account.provider_id),
            &account.id,
        )
        .is_err()
    {
        let mut missing = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
        missing.state = AccountState::NeedsAuth;
        return Ok(missing);
    }
    if !matches!(account.provider_id.as_str(), "claude-acp" | "codex-acp") {
        // These bridges authenticate inside WSL but do not expose quota telemetry.
        return Ok(ProviderAccountStatus::empty(
            &account.id,
            &account.provider_id,
            now_ms(),
        ));
    }
    let mut probe = Probe::new();
    let command = probe.command(account)?;
    let result = if account.provider_id == "claude-acp" {
        claude::read_usage_command(command, true)
            .await
            .map(|(identity, usage, _)| claude::repository_status(account, &identity, &usage))
    } else {
        codex::read_usage_command(command, None)
            .await
            .map(|(identity, usage)| codex::map_usage(&account.id, &identity, &usage, now_ms()))
    };
    probe.stop().await?;
    result
}

pub(super) async fn fetch(account: &ProviderAccount) -> ProviderAccountStatus {
    let mut empty = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
    if !account.enabled {
        empty.state = AccountState::Disabled;
        return empty;
    }
    let started = empty.last_attempt_at;
    let mut status = read(account).await.unwrap_or_else(|error| {
        empty.state = AccountState::Error;
        empty.stale = true;
        empty.error = Some(error);
        empty
    });
    status.last_attempt_at = started;
    status
}
