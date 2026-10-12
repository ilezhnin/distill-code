//! Opt-in concurrent admission; legacy plans keep their serial scheduler.
use super::*;

pub(super) async fn control_children(
    tx: &mut Transaction<'_, Sqlite>,
    campaign_id: &str,
    state: &str,
) -> Result<BTreeSet<String>> {
    let children: BTreeSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT r.id FROM run_plans r JOIN workflow_campaign_cells c ON c.request_key=r.request_key WHERE c.campaign_id=?",
    )
    .bind(campaign_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();
    // State changes never recreate an attempt. A pause stops root admission
    // and drains admitted trajectories, including their dependent steps.
    let (next, eligible) = match state {
        "running" => ("running", "'pausing','paused','needs_attention'"),
        "paused" => ("pausing", "'running'"),
        _ => (
            "cancelling",
            "'running','pausing','paused','needs_attention'",
        ),
    };
    sqlx::query(&format!(
        "UPDATE run_plans SET state=?,revision=revision+1,updated_at=? WHERE request_key IN (SELECT request_key FROM workflow_campaign_cells WHERE campaign_id=?) AND state IN ({eligible})"
    ))
    .bind(next).bind(now()).bind(campaign_id).execute(&mut **tx).await?;
    Ok(children)
}

async fn pause(service: &BenchmarkService, id: &str, reason: &str) -> Result<()> {
    let mut tx = service.store.pool.begin().await?;
    if sqlx::query("UPDATE workflow_campaigns SET state='paused',state_reason=?,revision=revision+1 WHERE id=? AND state='running'")
        .bind(reason).bind(id).execute(&mut *tx).await?.rows_affected() == 1
    {
        control_children(&mut tx, id, "paused").await?;
        event(&mut tx, id, "workflow_campaign_changed").await?;
    }
    tx.commit().await?;
    service.changed().await;
    Ok(())
}

pub(super) async fn tick(service: &BenchmarkService) -> Result<()> {
    // Include paused/cancelled campaigns while their already admitted children
    // drain. Their first observations must survive without an operator resume.
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT p.id FROM workflow_campaigns p WHERE COALESCE(json_extract(p.plan_json,'$.request.parallelism'),1)>1 AND (p.state='running' OR EXISTS(SELECT 1 FROM workflow_campaign_cells c JOIN run_plans r ON r.request_key=c.request_key WHERE c.campaign_id=p.id AND c.result_json IS NULL)) ORDER BY p.created_at,p.id",
    )
    .fetch_all(&service.store.pool).await?;
    for id in ids {
        reconcile(service, &id).await?;
    }
    Ok(())
}

async fn reconcile(service: &BenchmarkService, id: &str) -> Result<()> {
    let saved = service.store.workflow_campaign(id).await?;
    let stored_state = if saved.state == "pausing" {
        "paused"
    } else {
        saved.state.as_str()
    };
    let rows = sqlx::query(
        "SELECT c.cell_index,c.request_key,c.result_json,r.id AS run_id FROM workflow_campaign_cells c JOIN run_plans r ON r.request_key=c.request_key WHERE c.campaign_id=? ORDER BY c.cell_index",
    )
    .bind(id).fetch_all(&service.store.pool).await?;
    let mut recorded = 0;
    let mut results = Vec::new();
    let mut reason = None;
    let mut repair_cancel = false;
    for row in &rows {
        if row.try_get::<Option<String>, _>("result_json")?.is_some() {
            recorded += 1;
            continue;
        }
        let index = row.try_get::<i64, _>("cell_index")? as usize;
        let request = saved.plan.run_request(index)?;
        let run = service.store.run(row.try_get("run_id")?).await?;
        if hash(&run.request)? != hash(&request)? || run.attempts.len() != 1 {
            pause(service, id, "Campaign cell evidence changed").await?;
            return Err(invalid("Campaign cell evidence changed"));
        }
        let root = &run.attempts[0];
        repair_cancel |= saved.state == "cancelled"
            && root.phase != "terminal"
            && !matches!(run.state.as_str(), "cancelled" | "cancelling");
        if root.phase == "terminal" {
            results.push((
                request.request_key,
                service.store.workflow_trace(&root.id).await?,
            ));
            if super::super::analysis::score(root).is_none() && reason.is_none() {
                reason = Some(root.reason.clone().unwrap_or_else(||
                    "First trajectory is unscored; resume preserves it and continues remaining cells".into()));
            }
        } else if matches!(
            run.state.as_str(),
            "paused" | "pausing" | "needs_attention" | "cancelled" | "cancelling"
        ) && reason.is_none()
        {
            reason = Some(format!("Admitted trajectory is {}", run.state));
        }
    }
    recorded += results.len();
    let state = if stored_state != "running" {
        stored_state
    } else if recorded == saved.plan.cells.len() {
        "completed"
    } else if reason.is_some() {
        "paused"
    } else {
        "running"
    };
    if !results.is_empty() || state != stored_state || repair_cancel {
        let mut tx = service.store.pool.begin().await?;
        if sqlx::query("UPDATE workflow_campaigns SET next_cell=?,state=?,state_reason=?,revision=revision+1 WHERE id=? AND revision=?")
            .bind(recorded as i64).bind(state)
            .bind(if saved.state == "running" { reason } else { saved.state_reason.clone() })
            .bind(id).bind(saved.revision).execute(&mut *tx).await?.rows_affected() != 1
        {
            return Ok(()); // Control or another observation won; reread next tick.
        }
        for (key, result) in &results {
            sqlx::query("UPDATE workflow_campaign_cells SET result_json=?,result_hash=? WHERE request_key=? AND result_json IS NULL")
                .bind(serde_json::to_string(result)?).bind(hash(result)?).bind(key)
                .execute(&mut *tx).await?;
        }
        if state == "paused" && saved.state == "running" {
            control_children(&mut tx, id, state).await?;
        } else if repair_cancel {
            // Store recovery parks child runs. A cancelled parent must finish
            // cancelling untouched children rather than leave them resumable.
            control_children(&mut tx, id, "cancelled").await?;
        }
        event(&mut tx, id, "workflow_campaign_changed").await?;
        tx.commit().await?;
        service.changed().await;
    }
    if state != "running" {
        return Ok(());
    }
    let unfinished = rows.len() - recorded;
    let available =
        (saved.plan.request.parallelism.unwrap_or(1) as usize).saturating_sub(unfinished);
    // Registration fixes admission order, not completion order. Only collected
    // first outcomes free slots, so a fast child can refill beside a slow one.
    for index in rows.len()..(rows.len() + available).min(saved.plan.cells.len()) {
        if let Err(error) = service.start_run(saved.plan.run_request(index)?).await {
            pause(service, id, &error.message).await?;
            break;
        }
    }
    Ok(())
}
