//! Purchased provider credits benchmark turns may draw on once their account's
//! plan usage is spent.
//!
//! The owner sets the limit in Settings > Benchmarks (`creditLimit` in the
//! benchmark settings document); without one, a benchmark turn never runs on
//! credits. Spending is measured from the credit balance the provider reports
//! and kept in a ledger beside the benchmark database. Every drop between two
//! samples of an account taken within [`SAME_STRETCH_MS`] of each other
//! counts, and a known turn keeps its start and finish in the same stretch
//! even when it lasts longer. Anything else that used the account meanwhile
//! counts too, and a purchase never offsets what was spent.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::types::{BenchmarkError, Result};

/// The benchmark settings document the renderer writes.
const SETTINGS: &str = "settings.json";
const LEDGER: &str = "credit-spend.json";
/// Samples further apart than this belong to separate stretches of benchmark
/// turns unless a recorded turn spans them: idle losses are not counted.
pub const SAME_STRETCH_MS: i64 = 30 * 60 * 1000;
/// Credit admission accepts a successful balance within the provider status
/// cache's normal five-minute lifetime; old telemetry cannot authorize spend.
const BALANCE_MAX_AGE_MS: i64 = 5 * 60 * 1000;

/// One read-modify-write of the ledger at a time.
static LEDGER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A live turn bridges an otherwise idle-looking gap between balance reads.
/// Keys include the ledger root so isolated runs never share accounting state.
type ActiveSamples = BTreeMap<(std::path::PathBuf, String), BTreeMap<i64, usize>>;
static ACTIVE_SAMPLES: std::sync::Mutex<ActiveSamples> = std::sync::Mutex::new(BTreeMap::new());

pub(super) struct ActiveSample {
    key: (std::path::PathBuf, String),
    observed_at: i64,
}

/// Hold only after the before-sample was saved, and for the lifetime of the
/// candidate turn. Dropping an early refusal or failed turn releases it too.
pub(super) async fn active_sample(
    root: &Path,
    account: &str,
    observed_at: i64,
    started_at: i64,
) -> Result<ActiveSample> {
    let _guard = LEDGER_LOCK.lock().await;
    let mut ledger = read_ledger(root).await?;
    let entry = ledger.accounts.get_mut(account).ok_or_else(|| {
        BenchmarkError::new(
            "storage_unavailable",
            "Credit turn has no saved before-sample",
        )
    })?;
    entry.unsettled_since = Some(
        entry
            .unsettled_since
            .map_or(started_at, |at| at.max(started_at)),
    );
    save_ledger(root, &ledger).await?;
    let key = (root.to_owned(), account.to_owned());
    let mut samples = ACTIVE_SAMPLES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *samples
        .entry(key.clone())
        .or_default()
        .entry(observed_at)
        .or_default() += 1;
    Ok(ActiveSample { key, observed_at })
}

impl Drop for ActiveSample {
    fn drop(&mut self) {
        let mut samples = ACTIVE_SAMPLES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(account) = samples.get_mut(&self.key) {
            if let Some(count) = account.get_mut(&self.observed_at) {
                *count -= 1;
                if *count == 0 {
                    account.remove(&self.observed_at);
                }
            }
            if account.is_empty() {
                samples.remove(&self.key);
            }
        }
    }
}

fn active_since(root: &Path, account: &str) -> Option<i64> {
    ACTIVE_SAMPLES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&(root.to_owned(), account.to_owned()))
        .and_then(|samples| samples.keys().next().copied())
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSpend {
    /// The last balance sample and when the provider reported it.
    pub balance: f64,
    pub observed_at: i64,
    /// Credits counted as spent on this account.
    pub spent: f64,
    /// Latest admitted turn start awaiting a reliable later balance. A crash or
    /// failed final sample keeps continuity until that sample can be saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsettled_since: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    #[serde(default)]
    pub accounts: BTreeMap<String, AccountSpend>,
}

impl Ledger {
    pub fn spent(&self) -> f64 {
        self.accounts.values().map(|account| account.spent).sum()
    }

    /// Records a balance sample of `account` reported at `observed_at`, and
    /// returns the credits it adds to the spending. A sample no newer than the
    /// last one changes nothing.
    #[cfg(test)]
    pub fn observe(&mut self, account: &str, balance: f64, observed_at: i64) -> f64 {
        self.observe_sample(account, balance, observed_at, None)
    }

    /// A turn's before-sample must already be in the ledger. Later overlapping
    /// samples charge only the drop from the newest recorded balance.
    fn observe_sample(
        &mut self,
        account: &str,
        balance: f64,
        observed_at: i64,
        turn_started_at: Option<i64>,
    ) -> f64 {
        if !balance.is_finite() {
            return 0.0;
        }
        let entry = self.accounts.entry(account.to_owned()).or_default();
        if observed_at <= entry.observed_at {
            return 0.0;
        }
        let ongoing = entry.unsettled_since.is_some()
            || turn_started_at.is_some_and(|start| {
                start > 0 && start <= entry.observed_at && start < observed_at
            });
        let spent = if ongoing || observed_at.saturating_sub(entry.observed_at) <= SAME_STRETCH_MS {
            (entry.balance - balance).max(0.0)
        } else {
            0.0
        };
        entry.spent += spent;
        entry.balance = balance;
        entry.observed_at = observed_at;
        spent
    }
}

/// The owner's limit and what benchmark turns spent against it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditSpend {
    /// The most credits benchmark turns may spend; none while credits are off.
    pub limit: Option<f64>,
    pub spent: f64,
}

impl CreditSpend {
    pub fn allows(&self) -> bool {
        self.limit.is_some_and(|limit| self.spent < limit)
    }

    /// Why a turn whose plan usage is spent may not run on credits.
    pub fn refusal(&self) -> String {
        match self.limit {
            Some(limit) => format!(
                "Plan usage is spent, and benchmark credits reached their limit: {} of {} spent",
                amount(self.spent),
                amount(limit)
            ),
            None => "Plan usage is spent, and benchmark credits are off: set a credit limit in Settings > Benchmarks".into(),
        }
    }
}

/// Why a turn whose plan usage is spent may not run on credits the account
/// reports no balance for.
pub const UNMEASURED: &str =
    "Plan usage is spent, and benchmark credits cannot be measured: the account reports no current credit balance";

fn amount(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded}")
    }
}

/// A balance recent enough to authorize another benchmark turn on credits.
pub(super) fn current_balance(
    status: &crate::services::provider_account_status::ProviderAccountStatus,
    at: i64,
) -> Option<f64> {
    use crate::services::provider_account_status::AccountState;
    if status.stale
        || status.error.is_some()
        || !matches!(
            status.state,
            AccountState::Ready | AccountState::Limited | AccountState::Unknown
        )
        || status.last_updated_at <= 0
        || !(0..BALANCE_MAX_AGE_MS).contains(&at.saturating_sub(status.last_updated_at))
    {
        return None;
    }
    crate::services::provider_account_status::plan_credit_balance(status)
}

/// Observe the balance used by admission before reading the remaining limit.
pub(super) async fn observe_and_spend(
    root: &Path,
    account: &str,
    balance: f64,
    observed_at: i64,
) -> Result<CreditSpend> {
    observe(root, account, balance, observed_at).await?;
    if active_since(root, account).is_none()
        && read_ledger(root)
            .await?
            .accounts
            .get(account)
            .is_some_and(|entry| entry.unsettled_since.is_some())
    {
        return Err(BenchmarkError::new(
            "credit_accounting_pending",
            "A previous benchmark turn still needs a fresh credit balance before more credits may be used",
        ));
    }
    spend(root).await
}

/// The limit in a benchmark settings document; a missing, negative or
/// non-numeric value means credits are off.
pub fn limit(settings: &serde_json::Value) -> Option<f64> {
    settings["creditLimit"]
        .as_f64()
        .filter(|limit| limit.is_finite() && *limit >= 0.0)
}

/// The limit set for benchmarks under `root` and what they spent so far. An
/// unreadable ledger is an error: spending that cannot be read is not zero.
pub async fn spend(root: &Path) -> Result<CreditSpend> {
    let settings = tokio::fs::read_to_string(root.join(SETTINGS))
        .await
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_default();
    Ok(CreditSpend {
        limit: limit(&settings),
        spent: read_ledger(root).await?.spent(),
    })
}

/// Adds a balance sample of `account` to the ledger under `root`.
pub async fn observe(root: &Path, account: &str, balance: f64, observed_at: i64) -> Result<()> {
    observe_sample(
        root,
        account,
        balance,
        observed_at,
        active_since(root, account),
    )
    .await
}

/// Settles a turn against its recorded before-sample, even beyond the idle
/// stretch timeout. The ordinary ledger timestamp still prevents double counts.
pub(super) async fn observe_after_turn(
    root: &Path,
    account: &str,
    balance: f64,
    observed_at: i64,
    turn_started_at: i64,
) -> Result<()> {
    observe_sample(root, account, balance, observed_at, Some(turn_started_at)).await
}

async fn observe_sample(
    root: &Path,
    account: &str,
    balance: f64,
    observed_at: i64,
    turn_started_at: Option<i64>,
) -> Result<()> {
    let _guard = LEDGER_LOCK.lock().await;
    let mut ledger = read_ledger(root).await?;
    let before = ledger.clone();
    ledger.observe_sample(account, balance, observed_at, turn_started_at);
    // With no live turns, this new sample also settles a previous failed final
    // read or a restart. A cached before-sample cannot discharge that debt.
    if balance.is_finite() && active_since(root, account).is_none() {
        if let Some(entry) = ledger.accounts.get_mut(account).filter(|entry| {
            observed_at >= entry.observed_at
                && entry.unsettled_since.is_some_and(|at| observed_at > at)
        }) {
            entry.unsettled_since = None;
        }
    }
    if ledger == before {
        return Ok(());
    }
    save_ledger(root, &ledger).await
}

/// Called after a successful final observation and after releasing this turn's
/// guard. A concurrent or later turn retains the durable obligation.
pub(super) async fn clear_settled(root: &Path, account: &str, observed_at: i64) -> Result<()> {
    let _guard = LEDGER_LOCK.lock().await;
    if active_since(root, account).is_some() {
        return Ok(());
    }
    let mut ledger = read_ledger(root).await?;
    let Some(entry) = ledger
        .accounts
        .get_mut(account)
        .filter(|entry| entry.unsettled_since.is_some_and(|at| observed_at > at))
    else {
        return Ok(());
    };
    entry.unsettled_since = None;
    save_ledger(root, &ledger).await
}

async fn save_ledger(root: &Path, ledger: &Ledger) -> Result<()> {
    let contents = serde_json::to_string_pretty(ledger)?;
    let target = root.join(LEDGER);
    tokio::task::spawn_blocking(move || {
        let temporary = target.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
        crate::commands::flock_store::write_file_synced(&temporary, contents.as_bytes())
            .and_then(|()| std::fs::rename(&temporary, &target))
            .inspect_err(|_| {
                let _ = std::fs::remove_file(&temporary);
            })
    })
    .await
    .map_err(|error| BenchmarkError::new("storage_unavailable", error.to_string()))?
    .map_err(|error| {
        BenchmarkError::new(
            "storage_unavailable",
            format!("Cannot save benchmark credit spending: {error}"),
        )
    })
}

async fn read_ledger(root: &Path) -> Result<Ledger> {
    match tokio::fs::read_to_string(root.join(LEDGER)).await {
        Ok(text) => serde_json::from_str(&text).map_err(|error| {
            BenchmarkError::new(
                "storage_unavailable",
                format!("Cannot read benchmark credit spending: {error}"),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
        Err(error) => Err(BenchmarkError::new(
            "storage_unavailable",
            format!("Cannot read benchmark credit spending: {error}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;

    #[test]
    fn drops_within_a_stretch_count_once_and_purchases_never_offset_them() {
        let mut ledger = Ledger::default();
        assert_eq!(ledger.observe("a", 1000.0, 10 * MINUTE), 0.0);
        // Two turns at once: each sample counts only what changed since the last.
        assert_eq!(ledger.observe("a", 990.0, 11 * MINUTE), 10.0);
        assert_eq!(ledger.observe("a", 970.0, 12 * MINUTE), 20.0);
        // A sample older than the last one (a cached status) is ignored.
        assert_eq!(ledger.observe("a", 995.0, 11 * MINUTE + 1), 0.0);
        // A purchase raises the balance without refunding anything.
        assert_eq!(ledger.observe("a", 5970.0, 13 * MINUTE), 0.0);
        assert_eq!(ledger.observe("a", 5960.0, 14 * MINUTE), 10.0);
        assert_eq!(ledger.spent(), 40.0);
    }

    #[test]
    fn a_new_stretch_starts_from_its_own_balance() {
        let mut ledger = Ledger::default();
        ledger.observe("a", 1000.0, MINUTE);
        // A day of other use between benchmark stretches is not counted.
        assert_eq!(ledger.observe("a", 600.0, MINUTE + 24 * 60 * MINUTE), 0.0);
        assert_eq!(
            ledger.observe("a", 590.0, 2 * MINUTE + 24 * 60 * MINUTE),
            10.0
        );
        ledger.observe("b", 50.0, MINUTE);
        ledger.observe("b", 45.0, 2 * MINUTE);
        assert_eq!(ledger.spent(), 15.0);
        assert_eq!(
            ledger.observe("a", f64::NAN, 3 * MINUTE + 24 * 60 * MINUTE),
            0.0
        );
    }

    #[test]
    fn a_long_running_turn_keeps_its_spend_in_the_same_stretch() {
        let mut ledger = Ledger::default();
        ledger.observe("a", 1000.0, MINUTE);
        assert_eq!(
            ledger.observe_sample("a", 600.0, 41 * MINUTE, Some(MINUTE)),
            400.0
        );
        assert_eq!(ledger.spent(), 400.0);
    }

    #[test]
    fn long_parallel_turns_charge_each_drop_once_and_do_not_bridge_idle_gaps() {
        let mut ledger = Ledger::default();
        ledger.observe("a", 1000.0, MINUTE);
        assert_eq!(
            ledger.observe_sample("a", 700.0, 61 * MINUTE, Some(MINUTE)),
            300.0
        );
        assert_eq!(
            ledger.observe_sample("a", 650.0, 62 * MINUTE, Some(MINUTE)),
            50.0
        );
        assert_eq!(
            ledger.observe_sample("a", 720.0, 60 * MINUTE, Some(MINUTE)),
            0.0
        );
        assert_eq!(
            ledger.observe_sample("a", 650.0, 62 * MINUTE, Some(MINUTE)),
            0.0
        );
        // Purchases do not refund the earlier drops.
        assert_eq!(
            ledger.observe_sample("a", 1650.0, 100 * MINUTE, Some(MINUTE)),
            0.0
        );
        assert_eq!(
            ledger.observe_sample("a", 1600.0, 140 * MINUTE, Some(MINUTE)),
            50.0
        );
        assert_eq!(ledger.spent(), 400.0);
        // A later admission after an idle day retains the old stretch rule.
        assert_eq!(ledger.observe("a", 900.0, 24 * 60 * MINUTE), 0.0);
        assert_eq!(ledger.spent(), 400.0);
        // A start sample absent from the ledger cannot invent a continuous turn.
        assert_eq!(
            ledger.observe_sample("b", 100.0, 90 * MINUTE, Some(MINUTE)),
            0.0
        );
    }

    #[tokio::test]
    async fn a_long_turn_settlement_is_durable_and_stops_new_credit_admission() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(SETTINGS), r#"{"creditLimit":100}"#).unwrap();
        assert!(observe_and_spend(root.path(), "a", 1000.0, MINUTE)
            .await
            .unwrap()
            .allows());
        observe_after_turn(root.path(), "a", 850.0, 41 * MINUTE, MINUTE)
            .await
            .unwrap();
        let spent = spend(root.path()).await.unwrap();
        assert_eq!(spent.spent, 150.0);
        assert!(!spent.allows());
        observe_after_turn(root.path(), "a", 850.0, 41 * MINUTE, MINUTE)
            .await
            .unwrap();
        assert_eq!(spend(root.path()).await.unwrap().spent, 150.0);
    }

    #[tokio::test]
    async fn admission_during_overlapping_long_turns_keeps_the_original_spend() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(SETTINGS), r#"{"creditLimit":1000}"#).unwrap();
        observe_and_spend(root.path(), "a", 1000.0, MINUTE)
            .await
            .unwrap();
        let first = active_sample(root.path(), "a", MINUTE, MINUTE)
            .await
            .unwrap();
        let same_sample = active_sample(root.path(), "a", MINUTE, MINUTE)
            .await
            .unwrap();
        // A new admission must not reset the baseline while the first turn runs.
        assert_eq!(
            observe_and_spend(root.path(), "a", 900.0, 41 * MINUTE)
                .await
                .unwrap()
                .spent,
            100.0
        );
        let second = active_sample(root.path(), "a", 41 * MINUTE, 41 * MINUTE)
            .await
            .unwrap();
        drop(first);
        assert_eq!(active_since(root.path(), "a"), Some(MINUTE));
        drop(same_sample);
        assert_eq!(active_since(root.path(), "a"), Some(41 * MINUTE));
        observe_after_turn(root.path(), "a", 850.0, 61 * MINUTE, MINUTE)
            .await
            .unwrap();
        // An out-of-order completion cannot restore the higher balance.
        observe_after_turn(root.path(), "a", 880.0, 51 * MINUTE, MINUTE)
            .await
            .unwrap();
        assert_eq!(
            observe_and_spend(root.path(), "a", 800.0, 101 * MINUTE)
                .await
                .unwrap()
                .spent,
            200.0
        );
        // Guards are account- and root-specific.
        assert_eq!(active_since(root.path(), "other"), None);
        let isolated = tempfile::tempdir().unwrap();
        assert_eq!(active_since(isolated.path(), "a"), None);
        drop(second);
        assert_eq!(active_since(root.path(), "a"), None);
        clear_settled(root.path(), "a", 101 * MINUTE).await.unwrap();
        observe(root.path(), "a", 600.0, 24 * 60 * MINUTE)
            .await
            .unwrap();
        assert_eq!(spend(root.path()).await.unwrap().spent, 200.0);
    }

    #[tokio::test]
    async fn a_failed_final_sample_survives_drop_and_restart_without_holding_capacity() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(SETTINGS), r#"{"creditLimit":100}"#).unwrap();
        observe_and_spend(root.path(), "a", 1000.0, MINUTE)
            .await
            .unwrap();
        let turn = active_sample(root.path(), "a", MINUTE, 2 * MINUTE)
            .await
            .unwrap();
        // The final telemetry failed; dropping the turn releases all live state,
        // while the serialized ledger retains the accounting obligation.
        drop(turn);
        assert_eq!(active_since(root.path(), "a"), None);
        assert_eq!(
            read_ledger(root.path()).await.unwrap().accounts["a"].unsettled_since,
            Some(2 * MINUTE)
        );
        assert!(observe_and_spend(root.path(), "a", 1000.0, MINUTE)
            .await
            .is_err());
        // A freshly reconstructed ledger after restart charges the entire gap.
        let spent = observe_and_spend(root.path(), "a", 850.0, 61 * MINUTE)
            .await
            .unwrap();
        assert_eq!(spent.spent, 150.0);
        assert!(!spent.allows());
        assert_eq!(
            read_ledger(root.path()).await.unwrap().accounts["a"].unsettled_since,
            None
        );
        observe(root.path(), "a", 700.0, 24 * 60 * MINUTE)
            .await
            .unwrap();
        assert_eq!(spend(root.path()).await.unwrap().spent, 150.0);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_failed_final_ledger_write_is_retried_without_forgiving_the_spend() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(SETTINGS), r#"{"creditLimit":100}"#).unwrap();
        observe_and_spend(root.path(), "a", 1000.0, MINUTE)
            .await
            .unwrap();
        let turn = active_sample(root.path(), "a", MINUTE, MINUTE)
            .await
            .unwrap();
        let target = root.path().join(LEDGER);
        let original = std::fs::metadata(&target).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&target, readonly).unwrap();
        let failed = observe_after_turn(root.path(), "a", 850.0, 61 * MINUTE, MINUTE).await;
        std::fs::set_permissions(&target, original).unwrap();
        assert!(failed.is_err());
        drop(turn);
        let spent = observe_and_spend(root.path(), "a", 850.0, 61 * MINUTE)
            .await
            .unwrap();
        assert_eq!(spent.spent, 150.0);
        assert!(!spent.allows());
    }

    #[tokio::test]
    async fn an_older_final_sample_cannot_clear_a_later_turns_obligation() {
        let root = tempfile::tempdir().unwrap();
        observe(root.path(), "a", 1000.0, MINUTE).await.unwrap();
        let first = active_sample(root.path(), "a", MINUTE, MINUTE)
            .await
            .unwrap();
        observe_after_turn(root.path(), "a", 900.0, 2 * MINUTE, MINUTE)
            .await
            .unwrap();
        drop(first);
        // Another turn can start from the same cached sample, then fail before
        // the first turn clears its final accounting marker.
        let second = active_sample(root.path(), "a", 2 * MINUTE, 3 * MINUTE)
            .await
            .unwrap();
        drop(second);
        clear_settled(root.path(), "a", 2 * MINUTE).await.unwrap();
        assert_eq!(
            read_ledger(root.path()).await.unwrap().accounts["a"].unsettled_since,
            Some(3 * MINUTE)
        );
        observe(root.path(), "a", 800.0, 60 * MINUTE).await.unwrap();
        assert_eq!(spend(root.path()).await.unwrap().spent, 200.0);
    }

    #[test]
    fn stale_or_failed_balance_samples_cannot_authorize_credit_spending() {
        use crate::services::provider_account_status::{
            AccountState, CreditBalance, ProviderAccountStatus,
        };
        let mut status = ProviderAccountStatus::empty("invented-account", "codex-acp", MINUTE);
        status.state = AccountState::Ready;
        status.credits = Some(vec![CreditBalance {
            id: "credits".into(),
            label: "Credits".into(),
            balance: Some("1000".into()),
            total: None,
            currency: None,
            expires_at: None,
            unlimited: false,
        }]);
        assert_eq!(current_balance(&status, MINUTE), Some(1000.0));
        status.stale = true;
        assert_eq!(current_balance(&status, MINUTE), None);
        status.stale = false;
        status.state = AccountState::Error;
        assert_eq!(current_balance(&status, MINUTE), None);
        status.state = AccountState::Ready;
        status.error = Some("Telemetry unavailable".into());
        assert_eq!(current_balance(&status, MINUTE), None);
        status.error = None;
        assert_eq!(current_balance(&status, 7 * MINUTE), None);
        assert_eq!(current_balance(&status, MINUTE - 1), None);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_readable_but_unwritable_ledger_cannot_admit_more_credits() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(SETTINGS), r#"{"creditLimit":100}"#).unwrap();
        observe(root.path(), "a", 1000.0, MINUTE).await.unwrap();
        let target = root.path().join(LEDGER);
        let original = std::fs::metadata(&target).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&target, readonly).unwrap();
        let result = observe_and_spend(root.path(), "a", 850.0, 2 * MINUTE).await;
        // Restore before assertions so a failing regression can clean its fixture.
        std::fs::set_permissions(&target, original).unwrap();
        assert!(
            result.is_err(),
            "An unsaved 150-credit drop must not admit against the old zero spend"
        );
        assert_eq!(spend(root.path()).await.unwrap().spent, 0.0);
    }

    #[test]
    fn credits_are_off_until_a_limit_is_set_and_stop_at_it() {
        assert_eq!(limit(&serde_json::json!({"timeLimitMinutes": 240})), None);
        assert_eq!(limit(&serde_json::json!({"creditLimit": null})), None);
        assert_eq!(limit(&serde_json::json!({"creditLimit": -5})), None);
        assert_eq!(limit(&serde_json::json!({"creditLimit": "500"})), None);
        assert_eq!(limit(&serde_json::json!({"creditLimit": 500})), Some(500.0));
        let off = CreditSpend {
            limit: None,
            spent: 0.0,
        };
        assert!(!off.allows());
        assert!(off.refusal().contains("benchmark credits are off"));
        let open = CreditSpend {
            limit: Some(500.0),
            spent: 499.5,
        };
        assert!(open.allows());
        let reached = CreditSpend {
            limit: Some(500.0),
            spent: 500.0,
        };
        assert!(!reached.allows());
        assert_eq!(
            reached.refusal(),
            "Plan usage is spent, and benchmark credits reached their limit: 500 of 500 spent"
        );
        assert!(!CreditSpend {
            limit: Some(0.0),
            spent: 0.0
        }
        .allows());
    }

    #[tokio::test]
    async fn the_ledger_survives_a_restart_and_a_broken_one_refuses() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            spend(root.path()).await.unwrap(),
            CreditSpend {
                limit: None,
                spent: 0.0
            }
        );
        std::fs::write(root.path().join(SETTINGS), r#"{"creditLimit":100}"#).unwrap();
        observe(root.path(), "a", 80.0, MINUTE).await.unwrap();
        observe(root.path(), "a", 65.5, 2 * MINUTE).await.unwrap();
        assert_eq!(
            spend(root.path()).await.unwrap(),
            CreditSpend {
                limit: Some(100.0),
                spent: 14.5
            }
        );
        std::fs::write(root.path().join(LEDGER), "{not json").unwrap();
        assert!(spend(root.path()).await.is_err());
        assert!(observe(root.path(), "a", 60.0, 3 * MINUTE).await.is_err());
        // A refused write leaves the broken ledger for the owner to inspect.
        assert_eq!(
            std::fs::read_to_string(root.path().join(LEDGER)).unwrap(),
            "{not json"
        );
    }
}
