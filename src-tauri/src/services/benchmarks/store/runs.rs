//! Run plans: their state, their summaries for the app, and what a restart recovers.
use super::*;

/// A terminal repetition awaiting a panel is settled only once that entire
/// panel scores. Its first valid vote is not a completed measurement. The
/// listing projects evaluations only for these repetitions, never outputs.
pub(super) fn settled_cells(raw: &str) -> Result<u64> {
    type Cell = (
        String,
        String,
        String,
        Option<String>,
        Option<Vec<Evaluation>>,
    );
    let rows: Vec<Cell> = serde_json::from_str(raw)?;
    let mut cells = HashMap::new();
    for (configuration, version, phase, outcome, evaluations) in rows {
        let settled = phase == "terminal"
            && (outcome.as_deref() != Some("pending_review")
                || crate::services::benchmarks::analysis::score_of(
                    outcome.as_deref(),
                    None,
                    evaluations.as_deref().unwrap_or_default(),
                    None,
                )
                .is_some());
        *cells.entry((configuration, version)).or_insert(true) &= settled;
    }
    Ok(cells.values().filter(|settled| **settled).count() as u64)
}

impl Store {
    pub async fn run(&self, id: &str) -> Result<BenchmarkRun> {
        let r = sqlx::query(
            "SELECT state,revision,created_at,updated_at,request_json,baked_at,paused_ms,paused_since FROM run_plans WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| BenchmarkError::new("validation", "Run not found"))?;
        // Detailed output is loaded only through the evidence endpoint. Every
        // attempt is loaded: a full suite at three repetitions is over a
        // thousand, and a run missing some would plan, resume and bake wrong.
        let rows=sqlx::query_scalar::<_,String>("SELECT json_set(data_json,'$.output',NULL) FROM attempts WHERE run_id=? ORDER BY rowid").bind(id).fetch_all(&self.pool).await?;
        Ok(BenchmarkRun {
            id: id.into(),
            state: r.get(0),
            revision: r.get(1),
            created_at: r.get(2),
            updated_at: r.get(3),
            baked_at: r.get(5),
            paused_ms: r.get(6),
            paused_since: r.get(7),
            request: serde_json::from_str(r.get(4))?,
            attempts: rows
                .into_iter()
                .map(|v| {
                    serde_json::from_str(&v)
                        .map(crate::services::benchmarks::analysis::normalize_outcome)
                })
                .collect::<std::result::Result<_, _>>()?,
        })
    }

    pub async fn run_state(&self, id: &str) -> Result<String> {
        sqlx::query_scalar::<_, String>("SELECT state FROM run_plans WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| BenchmarkError::new("validation", "Run not found"))
    }

    /// The outcome as recorded, before any evidence is read into it.
    pub async fn stored_outcome(&self, id: &str) -> Result<Option<String>> {
        Ok(sqlx::query_scalar::<_, Option<String>>(
            "SELECT json_extract(data_json,'$.outcome') FROM attempts WHERE id=?
             UNION ALL SELECT json_extract(data_json,'$.outcome') FROM workflow_steps WHERE attempt_id=? LIMIT 1",
        )
        .bind(id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .flatten())
    }

    /// Recent history needs plans and counts, never serialized attempt evidence.
    pub async fn runs(&self) -> Result<Vec<RunSummary>> {
        // The count and live-child projections share one read snapshot. A step
        // completing between them must not make an older root look active.
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(
            "WITH recent_runs AS MATERIALIZED (
                SELECT * FROM run_plans ORDER BY created_at DESC,id LIMIT 100
             ), recent_attempts AS MATERIALIZED (
                SELECT a.id,a.run_id,a.configuration_id,a.version_id,a.phase,a.rowid,
                    json_extract(a.data_json,'$.outcome') AS outcome,
                    json_extract(a.data_json,'$.reason') AS reason,
                    json_extract(a.data_json,'$.observed.effort') AS observed_effort,
                    json_extract(a.data_json,'$.observed.fastMode') AS observed_fast,
                    json_extract(a.data_json,'$.observed.modelId') AS observed_model,
                    json_extract(a.data_json,'$.configuration.modelId') AS configured_model,
                    json_extract(a.data_json,'$.finishedAt') AS finished_at,
                    EXISTS(SELECT 1 FROM json_each(a.data_json,'$.evaluations') e
                        WHERE e.type='object' AND json_extract(e.value,'$.provenance')='human'
                            AND json_extract(e.value,'$.score') IS NOT NULL) AS has_human_score,
                    CASE WHEN a.phase='terminal' AND json_extract(a.data_json,'$.outcome')='pending_review'
                        THEN json_extract(a.data_json,'$.evaluations') END AS pending_evaluations
                FROM attempts a JOIN recent_runs r ON r.id=a.run_id
             ) SELECT r.id,r.state,r.revision,r.created_at,r.updated_at,r.request_json,
                (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id
                    AND COALESCE(a.outcome,'')<>'superseded'),
                (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id AND a.phase='terminal'
                    AND COALESCE(a.outcome,'')<>'superseded'),
                CASE WHEN r.state NOT IN ('completed','cancelled','cancelling') THEN
                (SELECT json_group_array(json_array(o.configuration_id,
                        o.observed_effort,o.observed_fast))
                    FROM (SELECT a.configuration_id,a.observed_effort,a.observed_fast
                        FROM recent_attempts a WHERE a.run_id=r.id AND a.phase<>'pending'
                            AND a.observed_model=a.configured_model
                            AND COALESCE(a.outcome,'')<>'selection_changed'
                        ORDER BY a.phase,a.rowid) o)
                END,
                CASE WHEN r.state NOT IN ('completed','cancelled','cancelling') THEN
                (SELECT json_group_array(json_array(o.configuration_id,o.version_id,o.running))
                    FROM (SELECT a.configuration_id,a.version_id,MAX(a.phase<>'pending') AS running FROM recent_attempts a
                        WHERE a.run_id=r.id AND a.phase<>'terminal'
                        GROUP BY a.configuration_id,a.version_id ORDER BY MIN(a.rowid)) o)
                END,
                CASE WHEN r.state IN ('running','pausing','paused','needs_attention','completed') THEN
                (SELECT json_group_array(json_array(issue.outcome,issue.reason,issue.id,issue.finished_at))
                 FROM (SELECT a.outcome,a.reason,a.id,a.finished_at
                    FROM recent_attempts a WHERE a.run_id=r.id
                        AND COALESCE(a.reason,'')<>''
                        AND ((a.phase='terminal' AND a.outcome='pending_review'
                            AND a.has_human_score=0)
                        OR (a.phase='pending' AND CASE WHEN json_valid(a.reason)
                            THEN json_extract(a.reason,'$.data.kind')='account_quota_wait'
                                OR json_extract(a.reason,'$.data.type')='account_quota_wait'
                            ELSE 0 END)
                        OR ((r.state='needs_attention' OR (a.phase='terminal' AND a.outcome IS NOT NULL)) AND COALESCE(a.outcome,'') NOT IN
                            ('pass','fail','judged','pending_review','completed','budget_reached','budget_timeout',
                             'excluded','selection_changed','unsupported','cancelled','superseded')))
                    ORDER BY (a.reason LIKE 'Waiting for local resources%') ASC,
                        (a.phase='pending') DESC,
                        (a.reason LIKE 'No judge panel:%') DESC,
                        COALESCE(a.finished_at,0) DESC, a.rowid DESC
                    ) issue)
                END,
                r.baked_at,
                CASE WHEN json_extract(r.request_json,'$.workflowPolicy') IS NOT NULL
                    AND (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id
                        AND COALESCE(a.outcome,'')<>'superseded')=1
                THEN (SELECT json_object('outcome',a.outcome,
                        'reason',a.reason)
                    FROM recent_attempts a WHERE a.run_id=r.id AND a.phase='terminal'
                        AND a.outcome IS NOT NULL
                        AND a.outcome<>'superseded')
                END,
                r.paused_ms,r.paused_since,
                (SELECT COUNT(*) FROM (SELECT 1 FROM recent_attempts a WHERE a.run_id=r.id
                    AND COALESCE(a.outcome,'')<>'superseded'
                    GROUP BY a.configuration_id,a.version_id)),
                (SELECT json_group_array(json_array(a.configuration_id,a.version_id,a.phase,a.outcome,
                    json(a.pending_evaluations))) FROM recent_attempts a WHERE a.run_id=r.id
                    AND COALESCE(a.outcome,'')<>'superseded'
                )
             FROM recent_runs r ORDER BY r.created_at DESC,r.id LIMIT 100",
        )
        .fetch_all(&mut *tx)
        .await?;
        let run_ids: Vec<String> = rows.iter().map(|row| row.get(0)).collect();
        let mut workflow_activity = workflow_activity(&mut tx, &run_ids).await?;
        tx.commit().await?;
        rows.into_iter()
            .map(|r| {
                let (attention, warning) = run_issues(r.get(10));
                Ok(RunSummary {
                    id: r.get(0),
                    state: r.get(1),
                    revision: r.get(2),
                    created_at: r.get(3),
                    updated_at: r.get(4),
                    baked_at: r.get(11),
                    paused_ms: r.get(13),
                    paused_since: r.get(14),
                    request: serde_json::from_str(r.get(5))?,
                    attempt_count: r.get::<i64, _>(6) as u64,
                    settled_count: r.get::<i64, _>(7) as u64,
                    cell_count: r.get::<i64, _>(15) as u64,
                    settled_cell_count: settled_cells(r.get(16))?,
                    observed_selections: observed_selections(r.get(8)),
                    open_cells: open_cells(r.get(9)),
                    attention,
                    warning,
                    workflow_result: r
                        .get::<Option<String>, _>(12)
                        .and_then(|raw| serde_json::from_str(&raw).ok()),
                    workflow_activity: workflow_activity
                        .remove(r.get::<&str, _>(0))
                        .unwrap_or_default(),
                })
            })
            .collect()
    }

    /// Runs the dispatcher acts on: running, pausing or cancelling, oldest
    /// first. Paused runs and runs that need attention wait for the operator
    /// and are not loaded.
    pub async fn active_runs(&self) -> Result<Vec<BenchmarkRun>> {
        let ids=sqlx::query_scalar::<_,String>("SELECT id FROM run_plans WHERE state IN ('running','pausing','cancelling') ORDER BY created_at,rowid").fetch_all(&self.pool).await?;
        let mut out = Vec::new();
        for id in ids {
            out.push(self.run(&id).await?);
        }
        Ok(out)
    }

    pub async fn all_runs(&self) -> Result<Vec<BenchmarkRun>> {
        let mut out = Vec::new();
        let mut offset = 0;
        loop {
            let ids = sqlx::query_scalar::<_, String>(
                "SELECT id FROM run_plans ORDER BY created_at,id LIMIT 100 OFFSET ?",
            )
            .bind(offset)
            .fetch_all(&self.pool)
            .await?;
            let count = ids.len();
            for id in ids {
                out.push(self.run(&id).await?);
            }
            if count < 100 {
                break;
            }
            offset += 100;
        }
        Ok(out)
    }

    /// The ids of runs whose window, time spent paused left out, closed at
    /// or before `cutoff` (a paused run's window waits) and whose
    /// cells are not final yet, oldest first, leaving out the runs a workflow
    /// campaign owns. Only ids: the caller loads a run once it may bake it.
    pub async fn unbaked_run_ids(&self, cutoff: i64) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar::<_, String>(
            "SELECT id FROM run_plans p WHERE baked_at IS NULL AND paused_since IS NULL AND created_at+paused_ms<=? AND NOT EXISTS(SELECT 1 FROM workflow_campaign_cells c WHERE c.request_key=p.request_key) ORDER BY created_at,id",
        )
        .bind(cutoff)
        .fetch_all(&self.pool)
        .await?)
    }

    /// Replaces a run's request: how a run inside its window grows by the
    /// cases added to it.
    pub async fn set_run_request(&self, id: &str, request: &RunRequest) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE run_plans SET request_json=?,revision=revision+1 WHERE id=?")
            .bind(serde_json::to_string(request)?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }

    /// Rebind only unstarted work on explicit resume. Sealed answers, prior
    /// attempts and their observed runtime remain immutable evidence.
    pub async fn refresh_pending_runtime(&self, id: &str, request: &RunRequest) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for configuration in &request.configurations {
            sqlx::query("UPDATE attempts SET data_json=json_set(data_json,'$.configuration',json(?)) WHERE run_id=? AND configuration_id=? AND phase='pending' AND json_extract(data_json,'$.evidenceHash') IS NULL AND json_extract(data_json,'$.output') IS NULL")
                .bind(serde_json::to_string(configuration)?)
                .bind(id)
                .bind(&configuration.id)
                .execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE run_plans SET request_json=?,revision=revision+1 WHERE id=?")
            .bind(serde_json::to_string(request)?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn set_run_state(&self, id: &str, state: &str) -> Result<()> {
        self.set_run_state_at(id, state, now()).await
    }

    /// Moves a run to `state` as of `at`: how a run baked after its window
    /// closed is completed at the time its last cell settled.
    pub async fn set_run_state_at(&self, id: &str, state: &str, at: i64) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        // A turn that fails while the owner stops the run never takes the
        // stop back: needs_attention leaves a cancelling or cancelled run be.
        // Nor does a tick that read the run before the stop and then found
        // nothing of it flying: completed leaves it be, and the stop ends it.
        // A pause's time is kept apart, so the run's window leaves it out.
        sqlx::query("UPDATE run_plans SET state=?1,revision=revision+1,updated_at=?2,paused_ms=paused_ms+CASE WHEN paused_since IS NOT NULL AND ?1<>'paused' THEN MAX(0,?2-paused_since) ELSE 0 END,paused_since=CASE WHEN ?1='paused' THEN COALESCE(paused_since,?2) ELSE NULL END WHERE id=?3 AND NOT (?1 IN ('needs_attention','completed') AND state IN ('cancelling','cancelled'))")
            .bind(state)
            .bind(at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let effective: String = sqlx::query_scalar("SELECT state FROM run_plans WHERE id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let rows = sqlx::query("SELECT id,phase,json_extract(data_json,'$.activity') FROM attempts WHERE run_id=? AND phase<>'terminal'")
            .bind(id).fetch_all(&mut *tx).await?;
        for row in rows {
            let mut activity: Option<AttemptActivity> = row
                .get::<Option<String>, _>(2)
                .map(|value| serde_json::from_str(&value))
                .transpose()?;
            if effective == "running"
                && activity.as_ref().is_some_and(|history| {
                    history
                        .spans
                        .last()
                        .is_some_and(|span| span.finished_at.is_none())
                })
            {
                continue;
            }
            let kind = match effective.as_str() {
                "needs_attention"
                    if activity
                        .as_ref()
                        .and_then(|history| history.spans.last())
                        .is_some_and(|span| {
                            span.kind == ActivityKind::Execution && span.finished_at.is_none()
                        }) =>
                {
                    continue
                }
                "running" if matches!(row.get::<&str, _>(1), "pending" | "awaiting_judges") => {
                    Some(ActivityKind::Waiting)
                }
                "running" | "pausing" | "cancelling" => continue,
                _ => None,
            };
            crate::services::benchmarks::activity::record(&mut activity, kind, at);
            sqlx::query(
                "UPDATE attempts SET data_json=json_set(data_json,'$.activity',json(?)) WHERE id=?",
            )
            .bind(serde_json::to_string(&activity)?)
            .bind(row.get::<&str, _>(0))
            .execute(&mut *tx)
            .await?;
        }
        event(&mut tx, id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn recover(&self) -> Result<()> {
        // Do not turn application downtime into work or queue time.
        let last_beat = self.last_beat().await?;
        let rows = sqlx::query("SELECT id,json_extract(data_json,'$.activity') FROM attempts WHERE phase<>'terminal' AND json_type(data_json,'$.activity')='object'")
            .fetch_all(&self.pool).await?;
        for row in rows {
            let mut activity: Option<AttemptActivity> =
                serde_json::from_str(row.get::<&str, _>(1))?;
            let stopped_at = last_beat.unwrap_or_else(|| {
                if let Some(history) = &mut activity {
                    history.complete = false;
                    history
                        .spans
                        .last()
                        .map_or(history.recorded_from, |span| span.started_at)
                } else {
                    now()
                }
            });
            crate::services::benchmarks::activity::record(&mut activity, None, stopped_at);
            sqlx::query(
                "UPDATE attempts SET data_json=json_set(data_json,'$.activity',json(?)) WHERE id=?",
            )
            .bind(serde_json::to_string(&activity)?)
            .bind(row.get::<&str, _>(0))
            .execute(&self.pool)
            .await?;
        }
        self.park_workflow_campaigns().await?;
        self.recover_qualifications().await?;
        // Never retry an attempt that may have crossed the host acceptance boundary.
        // A rendering awaiting its panel has a sealed generation; its run asks the
        // panel after resume, and reconciliation settles any judge turn cut off.
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM attempts WHERE phase NOT IN ('pending','terminal','awaiting_judges')",
        )
        .fetch_all(&self.pool)
        .await?;
        // A workflow root the stop cut off mid-trajectory gets the downtime
        // back from when the service was last alive.
        let alive = self.last_beat().await?;
        for data in rows {
            let mut a: Attempt = serde_json::from_str(&data)?;
            if let Some(from) = alive {
                if a.configuration.execution_profile != "workflow_policy" {
                    self.open_root_credit(&a.id, &a.run_id, from, "stranded")
                        .await?;
                }
            }
            a.phase = "interrupted".into();
            if a.evidence_hash.is_none()
                || a.outcome.is_none()
                || a.outcome.as_deref() == Some("interrupted")
            {
                a.outcome = Some("interrupted".into());
            }
            a.reason=Some("Application restarted; reconcile committed host evidence before any further dispatch.".into());
            self.save_attempt(&a).await?;
        }
        // A stop the restart cut short stays a stop: the runner closes it
        // once nothing of the run flies, as it would have before.
        sqlx::query("UPDATE run_plans SET state='needs_attention',revision=revision+1 WHERE state IN ('running','pausing')").execute(&self.pool).await?;
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM schedules WHERE enabled=1 AND next_due_at<?",
        )
        .bind(now())
        .fetch_all(&self.pool)
        .await?;
        for data in rows {
            let mut s: Schedule = serde_json::from_str(&data)?;
            s.missed = true;
            s.enabled = false;
            self.save_schedule(&s).await?;
        }
        Ok(())
    }
}

/// The distinct selections a run's acknowledged attempts ran with, from rows
/// of `[configuration id, effort, fast mode as 0 or 1]`.
pub(super) fn observed_selections(rows: Option<&str>) -> Vec<ObservedRunSelection> {
    let rows: Vec<(String, Option<String>, Option<i64>)> = rows
        .and_then(|rows| serde_json::from_str(rows).ok())
        .unwrap_or_default();
    let mut selections: Vec<ObservedRunSelection> = Vec::new();
    for (configuration_id, effort, fast_mode) in rows {
        let selection = ObservedRunSelection {
            configuration_id,
            effort,
            fast_mode: fast_mode.map(|fast| fast != 0),
        };
        if !selections.contains(&selection) {
            selections.push(selection);
        }
    }
    selections
}

/// Keep the first actionable cause in query priority order and the newest
/// transient failure or current quota wait separately. Neither hides an older blocker.
pub(super) fn run_issues(raw: Option<String>) -> (Option<RunAttention>, Option<RunWarning>) {
    type Issue = (Option<String>, String, String, Option<i64>);
    let issues: Vec<Issue> = raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let mut attention = None;
    let mut warning: Option<RunWarning> = None;
    for (outcome, reason, attempt_id, finished_at) in issues {
        if let Some(kind) = temporary_provider_issue(outcome.as_deref(), &reason) {
            let occurred_at = finished_at.unwrap_or_default();
            if warning.as_ref().is_none_or(|before| {
                before.kind != "quota_wait"
                    && (kind == "quota_wait" || occurred_at > before.occurred_at)
            }) {
                warning = Some(RunWarning {
                    attempt_id,
                    occurred_at,
                    kind: kind.into(),
                });
            }
        } else if attention.is_none() {
            attention = Some(RunAttention { outcome, reason });
        }
    }
    (attention, warning)
}

pub(super) fn temporary_provider_issue(
    outcome: Option<&str>,
    reason: &str,
) -> Option<&'static str> {
    if !matches!(outcome, None | Some("infrastructure_failure")) {
        return None;
    }
    // Inspect only the error message, never identifiers or quoted payload data.
    let parsed: serde_json::Value;
    let message = if reason.trim_start().starts_with('{') {
        parsed = serde_json::from_str(reason).ok()?;
        if outcome.is_none()
            && ["kind", "type"]
                .iter()
                .any(|key| parsed["data"][key] == "account_quota_wait")
        {
            return Some("quota_wait");
        }
        parsed.get("message")?.as_str()?
    } else {
        reason
    }
    .to_ascii_lowercase();
    outcome?;
    if [
        "rate limit",
        "rate_limit",
        "ratelimit",
        "rate-limit",
        "too many requests",
    ]
    .iter()
    .any(|signal| message.contains(signal))
    {
        Some("rate_limited")
    } else if [
        "overloaded_error",
        "model is overloaded",
        "server is overloaded",
        "service may be temporarily overloaded",
        "currently overloaded",
    ]
    .iter()
    .any(|signal| message.contains(signal))
    {
        Some("provider_overloaded")
    } else {
        // HTTP 429 alone can also mean exhausted quota or insufficient funds.
        None
    }
}
