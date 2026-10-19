//! Public, immutable repository progression shared by collection and deployment.
//! The source snapshot and sealed host records remain the authority for inputs.
use super::{fixtures, repository, types::*};
use serde::{Deserialize, Serialize};

pub const INPUT_KEY: &str = "repositoryArtifactInput";
pub const CLOCK_RECIPE: &str = "native-root-wall-budget-v1";
pub const CLOCK_KEY: &str = "nativeRootBudget";
/// What a closed budget credit row's `credit_json` names.
pub const CREDIT_RECIPE: &str = "native-root-idle-credit-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetLease {
    pub recipe: String,
    pub root_id: String,
    pub root_started_at_ms: i64,
    pub root_cap_seconds: u32,
    pub step_key: String,
    pub step_started_at_ms: i64,
    pub step_cap_seconds: u32,
    /// The root's closed idle and stranded intervals, credited back to its
    /// wall budget: the time it sat in the queue with a paid prefix (a quota
    /// or account wait) or with the app closed. Loaded from their hash-bound
    /// rows (`Store::credit`), never serialized and no part of the lease's
    /// identity, so a frozen lease row and its hash never change.
    #[serde(skip)]
    pub credits: Vec<(i64, i64)>,
}
impl PartialEq for BudgetLease {
    fn eq(&self, other: &Self) -> bool {
        self.recipe == other.recipe
            && self.root_id == other.root_id
            && self.root_started_at_ms == other.root_started_at_ms
            && self.root_cap_seconds == other.root_cap_seconds
            && self.step_key == other.step_key
            && self.step_started_at_ms == other.step_started_at_ms
            && self.step_cap_seconds == other.step_cap_seconds
    }
}
impl Eq for BudgetLease {}
impl BudgetLease {
    /// How much of `from..to` the credits cover.
    fn credited(&self, from: i64, to: i64) -> i64 {
        self.credits
            .iter()
            .map(|&(start, end)| (end.min(to) - start.max(from)).max(0))
            .sum()
    }
    pub fn remaining_ms(&self, at: i64) -> Result<u64> {
        if self.recipe != CLOCK_RECIPE
            || self.root_id.is_empty()
            || self.step_key.is_empty()
            || self.root_cap_seconds == 0
            || self.step_cap_seconds == 0
            || self.step_cap_seconds > self.root_cap_seconds
            || self.step_started_at_ms < self.root_started_at_ms
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root budget authority is malformed",
            ));
        }
        let root = allowance_ms(
            self.root_started_at_ms,
            at,
            self.root_cap_seconds,
            self.credited(self.root_started_at_ms, at),
        )?;
        let step = allowance_ms(
            self.step_started_at_ms,
            at,
            self.step_cap_seconds,
            self.credited(self.step_started_at_ms, at),
        )?;
        Ok(root.min(step))
    }
    pub fn remaining_seconds(&self, at: i64) -> Result<u32> {
        Ok(self.remaining_ms(at)?.div_ceil(1000) as u32)
    }
    pub fn deadline_at_ms(&self) -> Result<i64> {
        self.remaining_ms(self.step_started_at_ms)?;
        // Credits lie in the past, so a flight's deadline is fixed when it
        // starts.
        let root = self
            .root_started_at_ms
            .checked_add(i64::from(self.root_cap_seconds) * 1000)
            .and_then(|end| end.checked_add(self.credited(self.root_started_at_ms, i64::MAX)));
        let step = self
            .step_started_at_ms
            .checked_add(i64::from(self.step_cap_seconds) * 1000)
            .and_then(|end| end.checked_add(self.credited(self.step_started_at_ms, i64::MAX)));
        match (root, step) {
            (Some(root), Some(step)) => Ok(root.min(step)),
            _ => Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root deadline overflow",
            )),
        }
    }
}

impl super::store::Store {
    pub(super) async fn native_budget(&self, key: &str) -> Result<Option<BudgetLease>> {
        use sqlx::Row;
        let row = sqlx::query(
            "SELECT budget_json,budget_hash,root_id FROM task_budget_bindings WHERE request_key=?",
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let body: String = row.try_get("budget_json")?;
        let lease: BudgetLease = serde_json::from_str(&body)?;
        if row.try_get::<String, _>("budget_hash")? != fixtures::hash(body.as_bytes())
            || row.try_get::<String, _>("root_id")? != lease.root_id
            || lease.step_key != key
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native budget accounting integrity changed",
            ));
        }
        let mut lease = lease;
        self.credit(&mut lease).await?;
        Ok(Some(lease))
    }
    /// The closed idle and stranded intervals credited to `root_id`'s wall
    /// budget, oldest first, each checked against its hash.
    pub(super) async fn root_credits(&self, root_id: &str) -> Result<Vec<(i64, i64)>> {
        use sqlx::Row;
        let rows = sqlx::query(
            "SELECT from_ms,to_ms,kind,credit_json,credit_hash FROM budget_credits WHERE root_id=? AND to_ms IS NOT NULL ORDER BY from_ms",
        )
        .bind(root_id)
        .fetch_all(&self.pool)
        .await?;
        let mut credits: Vec<(i64, i64)> = Vec::new();
        for row in rows {
            let from: i64 = row.try_get("from_ms")?;
            let to: i64 = row.try_get("to_ms")?;
            let kind: String = row.try_get("kind")?;
            let body: Option<String> = row.try_get("credit_json")?;
            let hash: Option<String> = row.try_get("credit_hash")?;
            let expected = credit_json(root_id, from, to, &kind);
            if body.as_deref() != Some(expected.as_str())
                || hash.as_deref() != Some(fixtures::hash(expected.as_bytes()).as_str())
                || to <= from
                || credits.last().is_some_and(|&(_, end)| from < end)
            {
                return Err(BenchmarkError::new(
                    "budget_clock_conflict",
                    "Native root budget credit integrity changed",
                ));
            }
            credits.push((from, to));
        }
        Ok(credits)
    }
    /// Loads the closed credits of `lease`'s root into it.
    pub(super) async fn credit(&self, lease: &mut BudgetLease) -> Result<()> {
        lease.credits = self.root_credits(&lease.root_id).await?;
        Ok(())
    }
    /// The milliseconds credited back to `root_id`'s wall budget.
    pub(super) async fn root_credit_ms(&self, root_id: &str) -> Result<i64> {
        Ok(self
            .root_credits(root_id)
            .await?
            .iter()
            .map(|&(from, to)| to - from)
            .sum())
    }
    /// Opens an `idle` or `stranded` credit for root `root_id` of `run_id`
    /// from `from_ms`: the root leaves flight with a paid prefix (a quota or
    /// account wait) or the app stopped while it flew. Nothing for a root
    /// without a native root clock, or with a credit open already, which
    /// stays open through the downtime.
    pub(super) async fn open_root_credit(
        &self,
        root_id: &str,
        run_id: &str,
        from_ms: i64,
        kind: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO budget_credits(root_id,from_ms,to_ms,kind,run_id,credit_json,credit_hash) SELECT ?,?,NULL,?,?,NULL,NULL WHERE EXISTS (SELECT 1 FROM task_budget_bindings WHERE request_key=? AND root_id=?) AND NOT EXISTS (SELECT 1 FROM budget_credits WHERE root_id=? AND to_ms IS NULL)",
        )
        .bind(root_id)
        .bind(from_ms)
        .bind(kind)
        .bind(run_id)
        .bind(format!("workflow-root:{root_id}"))
        .bind(root_id)
        .bind(root_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
    /// Closes root `root_id`'s open credit at `to_ms`, as its next flight
    /// starts. A credit that would cover time the root flew is dropped
    /// instead, never granted: one that starts before the root's clock or an
    /// earlier credit's end, or after which a saved step started (and, for an
    /// idle credit, finished).
    pub(super) async fn close_root_credit(&self, root_id: &str, to_ms: i64) -> Result<()> {
        use sqlx::Row;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(open) = sqlx::query(
            "SELECT from_ms,kind FROM budget_credits WHERE root_id=? AND to_ms IS NULL",
        )
        .bind(root_id)
        .fetch_optional(&mut *tx)
        .await?
        else {
            return Ok(());
        };
        let from: i64 = open.try_get("from_ms")?;
        let kind: String = open.try_get("kind")?;
        let lease: Option<String> = sqlx::query_scalar(
            "SELECT budget_json FROM task_budget_bindings WHERE request_key=? AND root_id=?",
        )
        .bind(format!("workflow-root:{root_id}"))
        .bind(root_id)
        .fetch_optional(&mut *tx)
        .await?;
        let origin = match lease {
            Some(body) => Some(serde_json::from_str::<BudgetLease>(&body)?.root_started_at_ms),
            None => None,
        };
        let previous_end: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(to_ms) FROM budget_credits WHERE root_id=? AND to_ms IS NOT NULL",
        )
        .bind(root_id)
        .fetch_one(&mut *tx)
        .await?;
        let steps: Vec<String> =
            sqlx::query_scalar("SELECT data_json FROM workflow_steps WHERE root_attempt_id=?")
                .bind(root_id)
                .fetch_all(&mut *tx)
                .await?;
        let mut idle = true;
        for step in &steps {
            let step: Attempt = serde_json::from_str(step)?;
            idle &= step.started_at.is_none_or(|at| at <= from)
                && (kind == "stranded" || step.finished_at.is_none_or(|at| at <= from));
        }
        if to_ms > from
            && origin.is_some_and(|origin| from >= origin)
            && previous_end.is_none_or(|end| from >= end)
            && idle
        {
            let body = credit_json(root_id, from, to_ms, &kind);
            sqlx::query("UPDATE budget_credits SET to_ms=?,credit_json=?,credit_hash=? WHERE root_id=? AND to_ms IS NULL")
                .bind(to_ms)
                .bind(&body)
                .bind(fixtures::hash(body.as_bytes()))
                .bind(root_id)
                .execute(&mut *tx)
                .await?;
        } else {
            log::warn!(
                "[benchmarks] budget credit of root {root_id} from {from} dropped: it would cover time the root flew"
            );
            sqlx::query("DELETE FROM budget_credits WHERE root_id=? AND to_ms IS NULL")
                .bind(root_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    /// Records that the benchmark service was alive at `at`, so the time a
    /// root sat stranded by an app that stopped can be credited back.
    pub(super) async fn beat(&self, at: i64) -> Result<()> {
        sqlx::query("INSERT INTO benchmark_heartbeat(id,at_ms) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at_ms=excluded.at_ms")
            .bind(at)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
    /// When the service was last known alive: its heartbeat, or else the
    /// newest event it recorded.
    pub(super) async fn last_beat(&self) -> Result<Option<i64>> {
        let beat: Option<i64> =
            sqlx::query_scalar("SELECT at_ms FROM benchmark_heartbeat WHERE id=1")
                .fetch_optional(&self.pool)
                .await?;
        if beat.is_some() {
            return Ok(beat);
        }
        Ok(
            sqlx::query_scalar("SELECT MAX(created_at) FROM benchmark_events")
                .fetch_one(&self.pool)
                .await?,
        )
    }
    /// An immutable accounting row only: no second queue or dispatch journal.
    /// Same-key recovery cannot reset the root or per-step wall allowance.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn reserve_task_budget(
        &self,
        key: &str,
        input_hash: &str,
        consent_hash: &str,
        root: Option<&BudgetLease>,
        root_cap: u32,
        step_cap: u32,
        root_id: &str,
    ) -> Result<BudgetLease> {
        use sqlx::Row;
        let at = super::store::now();
        let mut lease = BudgetLease {
            recipe: CLOCK_RECIPE.into(),
            root_id: root.map_or_else(|| root_id.to_owned(), |root| root.root_id.clone()),
            root_started_at_ms: root.map_or(at, |root| root.root_started_at_ms),
            root_cap_seconds: root_cap,
            step_key: key.into(),
            step_started_at_ms: at,
            step_cap_seconds: step_cap,
            credits: Vec::new(),
        };
        self.credit(&mut lease).await?;
        lease.remaining_ms(at)?;
        if root.is_some_and(|root| root.root_cap_seconds != root_cap || root.recipe != CLOCK_RECIPE)
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "A descendant cannot reopen its root budget",
            ));
        }
        let body = serde_json::to_string(&lease)?;
        sqlx::query("INSERT INTO task_budget_bindings(request_key,input_hash,consent_hash,root_id,observed_at_ms,budget_json,budget_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING")
            .bind(key).bind(input_hash).bind(consent_hash).bind(&lease.root_id).bind(at).bind(&body).bind(fixtures::hash(body.as_bytes())).execute(&self.pool).await?;
        let row = sqlx::query("SELECT input_hash,consent_hash,budget_json,budget_hash FROM task_budget_bindings WHERE request_key=?")
            .bind(key).fetch_one(&self.pool).await?;
        let saved_body: String = row.try_get("budget_json")?;
        let mut saved: BudgetLease = serde_json::from_str(&saved_body)?;
        if row.try_get::<String, _>("input_hash")? != input_hash
            || row.try_get::<String, _>("consent_hash")? != consent_hash
            || row.try_get::<String, _>("budget_hash")? != fixtures::hash(saved_body.as_bytes())
            || saved.root_id != lease.root_id
            || saved.root_started_at_ms != lease.root_started_at_ms && root.is_some()
            || saved.root_cap_seconds != root_cap
            || saved.step_cap_seconds != step_cap
            || saved.step_key != key
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Frozen native budget belongs to a different request or root",
            ));
        }
        saved.credits = lease.credits.clone();
        saved.remaining_ms(at)?;
        self.verify_task_budget(&saved, input_hash, consent_hash)
            .await?;
        Ok(saved)
    }
    pub(super) async fn verify_task_budget(
        &self,
        lease: &BudgetLease,
        input_hash: &str,
        consent_hash: &str,
    ) -> Result<()> {
        self.verify_task_budget_clock(lease, input_hash, consent_hash, None)
            .await
    }
    async fn verify_task_budget_clock(
        &self,
        lease: &BudgetLease,
        input_hash: &str,
        consent_hash: &str,
        clock: Option<i64>,
    ) -> Result<()> {
        use sqlx::Row;
        let mut credited = lease.clone();
        self.credit(&mut credited).await?;
        let lease = &credited;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let at = clock.unwrap_or_else(super::store::now);
        let row=sqlx::query("SELECT input_hash,consent_hash,root_id,budget_json,budget_hash FROM task_budget_bindings WHERE request_key=?")
            .bind(&lease.step_key).fetch_optional(&mut *tx).await?
            .ok_or_else(||BenchmarkError::new("budget_clock_conflict","Native root accounting record is absent"))?;
        let body: String = row.try_get("budget_json")?;
        let saved: BudgetLease = serde_json::from_str(&body)?;
        if row.try_get::<String, _>("input_hash")? != input_hash
            || row.try_get::<String, _>("consent_hash")? != consent_hash
            || row.try_get::<String, _>("budget_hash")? != fixtures::hash(body.as_bytes())
            || &saved != lease
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root accounting record differs from bound authority",
            ));
        }
        if row.try_get::<String, _>("root_id")? != lease.root_id {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native accounting root identity changed",
            ));
        }
        let high_water: i64 = sqlx::query_scalar(
            "SELECT MAX(observed_at_ms) FROM task_budget_bindings WHERE root_id=?",
        )
        .bind(&lease.root_id)
        .fetch_one(&mut *tx)
        .await?;
        if at < high_water {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root wall clock decreased after a committed observation",
            ));
        }
        lease.remaining_ms(at)?;
        sqlx::query("UPDATE task_budget_bindings SET observed_at_ms=? WHERE root_id=?")
            .bind(at)
            .bind(&lease.root_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub before: repository::Artifact,
    pub lineage: Vec<repository::Artifact>,
    pub access_all: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicResult {
    pub schema_version: u32,
    pub recipe: String,
    pub report: String,
    pub artifact: repository::Artifact,
}

impl PublicResult {
    pub fn validate(&self, max_bytes: usize) -> Result<()> {
        if self.schema_version != 2
            || self.recipe != repository::ARTIFACT_RECIPE
            || self.artifact.recipe != self.recipe
            || self.report.len() > 128 * 1024
            || self.artifact.patch.len() > max_bytes
            || fixtures::hash(self.artifact.patch.as_bytes()) != self.artifact.patch_hash
            || [
                &self.artifact.root_tree,
                &self.artifact.before_tree,
                &self.artifact.after_tree,
            ]
            .iter()
            .any(|value| ![40, 64].contains(&value.len()) || !hex_digest(value))
            || self.artifact.before_tree.len() != self.artifact.root_tree.len()
            || self.artifact.after_tree.len() != self.artifact.root_tree.len()
            || self.artifact.archive_hash.len() != 64
            || !hex_digest(&self.artifact.archive_hash)
        {
            return Err(BenchmarkError::new(
                "evidence_mismatch",
                "Sealed repository public result is malformed or exceeds its bounds",
            ));
        }
        Ok(())
    }
    pub fn encode(&self, max_bytes: usize) -> Result<String> {
        self.validate(max_bytes)?;
        Ok(serde_json::to_string(self)?)
    }
}
fn hex_digest(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Legacy strings are unchanged. A declared schema-2 result is never treated
/// as legacy after a parse/integrity failure.
pub fn decode(raw: &str, max_bytes: usize) -> Result<Option<PublicResult>> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Ok(None);
    };
    if value.get("schemaVersion") != Some(&serde_json::json!(2)) || value.get("recipe").is_none() {
        return Ok(None);
    }
    let result: PublicResult = serde_json::from_value(value)?;
    result.validate(max_bytes)?;
    Ok(Some(result))
}

pub fn input(draft: &BenchmarkDraft) -> Result<Option<Input>> {
    draft
        .environment
        .get(INPUT_KEY)
        .map(|value| serde_json::from_value(value.clone()).map_err(Into::into))
        .transpose()
}

/// Integer seconds are an upper bound for one native turn; the root wall
/// deadline is checked before actual provider handoff. Durable native records
/// separately enforce their root's persisted high-water clock on recovery.
pub fn remaining_seconds(started_at_ms: i64, current_at_ms: i64, cap_seconds: u32) -> Result<u32> {
    Ok(allowance_ms(started_at_ms, current_at_ms, cap_seconds, 0)?.div_ceil(1000) as u32)
}
/// The allowance left at `current_at_ms` of a clock started at
/// `started_at_ms`, with `credited_ms` of that time credited back.
fn allowance_ms(
    started_at_ms: i64,
    current_at_ms: i64,
    cap_seconds: u32,
    credited_ms: i64,
) -> Result<u64> {
    let elapsed = current_at_ms
        .checked_sub(started_at_ms)
        .filter(|elapsed| *elapsed >= 0)
        .ok_or_else(|| {
            BenchmarkError::new("budget_clock_conflict", "Native root clock moved backwards")
        })?
        .saturating_sub(credited_ms.max(0))
        .max(0) as u64;
    let remaining = u64::from(cap_seconds)
        .checked_mul(1000)
        .unwrap()
        .saturating_sub(elapsed);
    if remaining == 0 {
        return Err(BenchmarkError::new(
            "budget_timeout",
            "Native root wall budget is exhausted",
        ));
    }
    Ok(remaining)
}

/// The body a closed credit row is bound by.
fn credit_json(root_id: &str, from: i64, to: i64, kind: &str) -> String {
    serde_json::json!({"recipe": CREDIT_RECIPE, "rootId": root_id, "fromMs": from, "toMs": to, "kind": kind})
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lease(root_start: i64, step_start: i64, credits: Vec<(i64, i64)>) -> BudgetLease {
        BudgetLease {
            recipe: CLOCK_RECIPE.into(),
            root_id: "invented-root".into(),
            root_started_at_ms: root_start,
            root_cap_seconds: 10,
            step_key: "workflow:invented-root:1".into(),
            step_started_at_ms: step_start,
            step_cap_seconds: 10,
            credits,
        }
    }
    #[test]
    fn credited_idle_time_comes_back_to_the_root_and_its_step() {
        // Root started at 0 with 10 s; it sat idle from 4 s to 24 s.
        let credited = lease(0, 0, vec![(4_000, 24_000)]);
        assert_eq!(credited.remaining_ms(25_000).unwrap(), 5_000);
        assert_eq!(credited.deadline_at_ms().unwrap(), 30_000);
        // A step that starts after the idle time is timed from its start;
        // its root keeps the credit.
        let step = lease(0, 26_000, vec![(4_000, 24_000)]);
        assert_eq!(step.remaining_ms(27_000).unwrap(), 3_000);
        assert_eq!(step.deadline_at_ms().unwrap(), 30_000);
        // Without the credit the same root ran out long ago.
        assert_eq!(
            lease(0, 0, vec![]).remaining_ms(25_000).unwrap_err().code,
            "budget_timeout"
        );
        // A credit cannot revive a clock that ran out before it started.
        let late = lease(0, 0, vec![(12_000, 40_000)]);
        assert_eq!(
            late.remaining_ms(41_000).unwrap_err().code,
            "budget_timeout"
        );
        // Credits are no part of the lease's identity and never serialized.
        assert_eq!(credited, lease(0, 0, vec![]));
        let body = serde_json::to_value(&credited).unwrap();
        assert!(body.get("credits").is_none());
        let parsed: BudgetLease = serde_json::from_value(body).unwrap();
        assert!(parsed.credits.is_empty());
    }
    #[tokio::test]
    async fn an_idle_credit_closes_once_bound_by_its_hash_and_never_covers_flight() {
        let directory = crate::test_support::TempRoot::new();
        let store = super::super::store::Store::open(directory.path())
            .await
            .unwrap();
        directory.register(&store.pool);
        let root = "invented-root";
        // No native root clock yet: nothing opens.
        store
            .open_root_credit(
                root,
                "invented-run",
                super::super::store::now() - 5_000,
                "idle",
            )
            .await
            .unwrap();
        let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM budget_credits")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(open, 0);
        let origin = super::super::store::now() - 6_000;
        let root_lease = BudgetLease {
            recipe: CLOCK_RECIPE.into(),
            root_id: root.into(),
            root_started_at_ms: origin,
            root_cap_seconds: 10,
            step_key: format!("workflow-root:{root}"),
            step_started_at_ms: origin,
            step_cap_seconds: 10,
            credits: Vec::new(),
        };
        let key = format!("workflow-root:{root}");
        store
            .reserve_task_budget(&key, "input", "consent", Some(&root_lease), 10, 10, root)
            .await
            .unwrap();
        // Idle from 5 s after the origin; a second open keeps the first.
        let from = origin + 5_000;
        store
            .open_root_credit(root, "invented-run", from, "idle")
            .await
            .unwrap();
        store
            .open_root_credit(root, "invented-run", from + 100, "idle")
            .await
            .unwrap();
        // An open credit grants nothing yet: the clock is nearly spent.
        assert!(store.root_credits(root).await.unwrap().is_empty());
        let to = from + 20_000;
        store.close_root_credit(root, to).await.unwrap();
        assert_eq!(store.root_credits(root).await.unwrap(), [(from, to)]);
        assert_eq!(store.root_credit_ms(root).await.unwrap(), 20_000);
        let read = store.native_budget(&key).await.unwrap().unwrap();
        assert_eq!(read.credits, [(from, to)]);
        assert_eq!(read.deadline_at_ms().unwrap(), origin + 30_000);
        // Closing again changes nothing.
        store.close_root_credit(root, to + 5_000).await.unwrap();
        assert_eq!(store.root_credits(root).await.unwrap(), [(from, to)]);
        // A changed row is a conflict, never a credit.
        sqlx::query("UPDATE budget_credits SET to_ms=to_ms+1000 WHERE root_id=?")
            .bind(root)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(
            store.root_credits(root).await.unwrap_err().code,
            "budget_clock_conflict"
        );
        sqlx::query("UPDATE budget_credits SET to_ms=to_ms-1000 WHERE root_id=?")
            .bind(root)
            .execute(&store.pool)
            .await
            .unwrap();
        // A credit that would cover granted time again is dropped, never
        // granted.
        store
            .open_root_credit(root, "invented-run", to - 1_000, "idle")
            .await
            .unwrap();
        store.close_root_credit(root, to + 9_000).await.unwrap();
        assert_eq!(store.root_credits(root).await.unwrap(), [(from, to)]);
        let open: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM budget_credits WHERE to_ms IS NULL")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(open, 0);
        // The heartbeat stranded time starts from.
        store.beat(1_000).await.unwrap();
        store.beat(2_000).await.unwrap();
        assert_eq!(store.last_beat().await.unwrap(), Some(2_000));
        directory.close().await;
    }
    #[test]
    fn common_root_clock_counts_preparation_and_refuses_exhaustion_or_rollback() {
        assert_eq!(remaining_seconds(10_000, 13_251, 10).unwrap(), 7);
        assert_eq!(remaining_seconds(10_000, 19_999, 10).unwrap(), 1);
        assert_eq!(
            remaining_seconds(10_000, 20_000, 10).unwrap_err().code,
            "budget_timeout"
        );
        assert_eq!(
            remaining_seconds(10_000, 9_999, 10).unwrap_err().code,
            "budget_clock_conflict"
        );
    }
    #[test]
    fn legacy_output_stays_legacy_and_declared_corrupt_artifact_does_not() {
        assert!(decode("Legacy report", 4096).unwrap().is_none());
        assert!(decode(
            r#"{"schemaVersion":2,"recipe":"repository-cumulative-v1","report":"ok"}"#,
            4096
        )
        .is_err());
    }
    #[tokio::test]
    async fn root_high_water_survives_reopen_and_refuses_backward_recovery() {
        let directory = crate::test_support::TempRoot::new();
        let store = super::super::store::Store::open(directory.path())
            .await
            .unwrap();
        directory.register(&store.pool);
        let lease = store
            .reserve_task_budget(
                "invented-root-key",
                "invented-input",
                "invented-consent",
                None,
                10,
                10,
                "invented-root",
            )
            .await
            .unwrap();
        let later = lease.root_started_at_ms + 5_000;
        store
            .verify_task_budget_clock(&lease, "invented-input", "invented-consent", Some(later))
            .await
            .unwrap();
        store.pool.close().await;
        let reopened = super::super::store::Store::open(directory.path())
            .await
            .unwrap();
        directory.register(&reopened.pool);
        let error = reopened
            .verify_task_budget_clock(
                &lease,
                "invented-input",
                "invented-consent",
                Some(later - 1_000),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "budget_clock_conflict");
        reopened
            .verify_task_budget_clock(
                &lease,
                "invented-input",
                "invented-consent",
                Some(later + 1),
            )
            .await
            .unwrap();
        directory.close().await;
    }
}
