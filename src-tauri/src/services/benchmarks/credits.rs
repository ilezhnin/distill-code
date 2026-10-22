//! Purchased provider credits benchmark turns may draw on once their account's
//! plan usage is spent.
//!
//! The owner sets the limit in Settings > Benchmarks (`creditLimit` in the
//! benchmark settings document); without one, a benchmark turn never runs on
//! credits. Spending is measured from the credit balance the provider reports
//! and kept in a ledger beside the benchmark database. Every drop between two
//! samples of an account taken within [`SAME_STRETCH_MS`] of each other
//! counts, so anything else that used the account's credits meanwhile counts
//! too, and a purchase never offsets what was spent.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::types::{BenchmarkError, Result};

/// The benchmark settings document the renderer writes.
const SETTINGS: &str = "settings.json";
const LEDGER: &str = "credit-spend.json";
/// Samples further apart than this belong to separate stretches of benchmark
/// turns: what the balance lost between them is not counted.
pub const SAME_STRETCH_MS: i64 = 30 * 60 * 1000;

/// One read-modify-write of the ledger at a time.
static LEDGER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSpend {
    /// The last balance sample and when the provider reported it.
    pub balance: f64,
    pub observed_at: i64,
    /// Credits counted as spent on this account.
    pub spent: f64,
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
    pub fn observe(&mut self, account: &str, balance: f64, observed_at: i64) -> f64 {
        if !balance.is_finite() {
            return 0.0;
        }
        let entry = self.accounts.entry(account.to_owned()).or_default();
        if observed_at <= entry.observed_at {
            return 0.0;
        }
        let spent = if observed_at - entry.observed_at <= SAME_STRETCH_MS {
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
    "Plan usage is spent, and benchmark credits cannot be measured: the account reports no credit balance";

fn amount(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded}")
    }
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
    let _guard = LEDGER_LOCK.lock().await;
    let mut ledger = read_ledger(root).await?;
    let before = ledger.clone();
    ledger.observe(account, balance, observed_at);
    if ledger == before {
        return Ok(());
    }
    let contents = serde_json::to_string_pretty(&ledger)?;
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
