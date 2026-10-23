//! Bound preparation and stalled judge queues without discarding paid evidence.
use super::*;
use std::future::Future;

pub(super) const PREPARATION_LIMIT: Duration = Duration::from_secs(5 * 60);
const CHECK_EVERY: Duration = Duration::from_secs(5);
const QUEUE_LIMIT_MS: i64 = 10 * 60 * 1000;
const QUEUE_SINCE: &str = "judgeQueueSince";
const PREPARATION_TIMEOUT: &str = "judge_preparation_timeout";

#[derive(Default, PartialEq, Eq)]
struct Progress {
    completed: Vec<(String, i64)>,
    in_flight: bool,
}

impl Progress {
    fn read(attempt: &Attempt) -> Self {
        let mut progress = Self::default();
        for evaluation in &attempt.evaluations {
            let Some(details) = evaluation.details.as_ref() else {
                continue;
            };
            if evaluation.judge.is_none() || details["sessionId"].as_str().is_none() {
                continue;
            }
            if details["inFlight"].as_bool() == Some(true) {
                progress.in_flight = true;
            } else if details["usageComplete"].as_bool() == Some(true)
                && details["dispatched"].as_bool() != Some(false)
                && details["requestKey"].as_str().is_some()
                && details["durationMs"].as_u64().is_some()
            {
                progress
                    .completed
                    .push((evaluation.id.clone(), evaluation.created_at));
            }
        }
        progress
    }
}

/// A paid placeholder is durable before dispatch. Never drop its owner merely
/// because setup took too long: the turn has its own deadline and reconciliation.
async fn bounded<T, E, U>(
    execution: E,
    limit: Duration,
    every: Duration,
    mut read: impl FnMut() -> U,
) -> Result<T>
where
    E: Future<Output = Result<T>>,
    U: Future<Output = Result<Progress>>,
{
    let mut previous = read().await?;
    let mut advanced = tokio::time::Instant::now();
    let mut execution = Box::pin(execution);
    loop {
        tokio::select! {
            biased;
            result = &mut execution => return result,
            _ = tokio::time::sleep(every.min(limit)) => {
                // A failed read cannot prove that nothing was dispatched.
                let Ok(progress) = read().await else { continue };
                if progress.completed != previous.completed {
                    advanced = tokio::time::Instant::now();
                }
                if !progress.in_flight && advanced.elapsed() >= limit {
                    return Err(BenchmarkError::new(
                        PREPARATION_TIMEOUT,
                        "Judge preparation made no progress for 5 min; saved answers and votes are preserved",
                    ));
                }
                previous = progress;
            }
        }
    }
}

pub(super) async fn prepare<T>(
    store: &Store,
    id: &str,
    execution: impl Future<Output = Result<T>>,
) -> Result<T> {
    let result = bounded(execution, PREPARATION_LIMIT, CHECK_EVERY, || async {
        store
            .attempt(id)
            .await
            .map(|attempt| Progress::read(&attempt))
    })
    .await;
    if result
        .as_ref()
        .is_err_and(|error| error.code == PREPARATION_TIMEOUT)
    {
        admission_window::finished(&store.root.display().to_string(), &format!("judge:{id}"));
    }
    result
}

/// The deadline also covers a blocked dispatch/status/event RPC. Checking the
/// clock only between those awaits cannot bound a judge's execution.
pub(super) async fn until<T>(
    deadline: tokio::time::Instant,
    call: impl Future<Output = std::result::Result<T, String>>,
) -> std::result::Result<T, String> {
    tokio::time::timeout_at(deadline, call)
        .await
        .map_err(|_| "Judge exceeded its 10 min execution budget".to_string())?
}

fn last_progress(run: &BenchmarkRun) -> Option<i64> {
    run.attempts
        .iter()
        .flat_map(|attempt| Progress::read(attempt).completed)
        .map(|(_, at)| at)
        .max()
}

/// Contiguous active spans may cross preparation retries, but never a pause.
fn active_since(attempt: &Attempt) -> Option<i64> {
    let spans = &attempt.activity.as_ref()?.spans;
    let last = spans.last().filter(|span| span.finished_at.is_none())?;
    let mut since = last.started_at;
    for span in spans.iter().rev().skip(1) {
        if span.finished_at != Some(since) {
            break;
        }
        since = span.started_at;
    }
    Some(since)
}

fn queue_since(attempt: &Attempt, progress: Option<i64>, at: i64) -> Option<i64> {
    if attempt.phase != AWAITING_JUDGES
        || judge_quota_waiting(attempt)
        || super::super::analysis::score(attempt).is_some()
    {
        return None;
    }
    let saved = attempt
        .phase_times
        .as_ref()
        .and_then(|times| times.get(QUEUE_SINCE));
    Some(
        saved
            .copied()
            .unwrap_or(at)
            .max(active_since(attempt).unwrap_or(i64::MIN))
            .max(progress.unwrap_or(i64::MIN))
            .min(at),
    )
}

/// A long backlog is healthy while judges finish calls. Ten minutes with no
/// such progress requests a normal pause, preserving all pending work and paid
/// evidence. Other runs continue; the operator can resume this exact run.
pub(super) async fn check_queue(
    service: &BenchmarkService,
    run: &BenchmarkRun,
    at: i64,
) -> Result<bool> {
    if run.state != "running" {
        return Ok(false);
    }
    let progress = last_progress(run);
    let active = run
        .attempts
        .iter()
        .any(|attempt| Progress::read(attempt).in_flight);
    for original in run.attempts.iter().filter(|a| a.phase == AWAITING_JUDGES) {
        let since = queue_since(original, progress, at);
        let previous = original
            .phase_times
            .as_ref()
            .and_then(|times| times.get(QUEUE_SINCE))
            .copied();
        // Completed receipts and pause spans already persist the newer clock.
        // Do not rewrite every queued answer whenever one judge finishes.
        if since.is_some() == previous.is_some()
            && since.is_none_or(|since| active || at.saturating_sub(since) < QUEUE_LIMIT_MS)
        {
            continue;
        }
        // The panel owns its evidence while it prepares or asks a judge.
        let lock = super::super::evaluation_lock(&original.id);
        let Ok(_guard) = lock.try_lock() else {
            continue;
        };
        let mut attempt = service.store.attempt(&original.id).await?;
        let since = queue_since(&attempt, progress, at);
        let previous = attempt
            .phase_times
            .as_ref()
            .and_then(|times| times.get(QUEUE_SINCE))
            .copied();
        if let Some(since) =
            since.filter(|since| !active && at.saturating_sub(*since) >= QUEUE_LIMIT_MS)
        {
            // A different panel may have completed since fill read the run.
            let current = service.store.run(&run.id).await?;
            if current.state != "running"
                || last_progress(&current).is_some_and(|last| last > since)
                || current.attempts.iter().any(|a| Progress::read(a).in_flight)
            {
                continue;
            }
            // Pause through the existing control boundary, never rewrite a
            // saved answer's phase or fabricate completion to clear the queue.
            let campaign: Option<String> = sqlx::query_scalar(
                "SELECT campaign_id FROM workflow_campaign_cells WHERE request_key=?",
            )
            .bind(&run.request.request_key)
            .fetch_optional(&service.store.pool)
            .await?;
            if let Some(campaign) = campaign {
                service
                    .control_workflow_campaign(&campaign, "pause")
                    .await?;
            } else {
                service.control(&run.id, "pause").await?;
            }
            let wait = attempt.reason.as_deref().unwrap_or("no judge was admitted");
            attempt.reason = Some(format!(
                "{JUDGE_DISCOVERY_WAIT}: run paused after 10 min without a completed judge call ({wait}). Saved answers and votes are preserved; resolve this wait, then resume."
            ));
            mark_phase(&mut attempt, "judgeQueueStalled");
            service.store.save_attempt(&attempt).await?;
            service.changed().await;
            return Ok(true);
        } else if since.is_some() == previous.is_some() {
            continue;
        }
        let times = attempt.phase_times.get_or_insert_with(Default::default);
        match since {
            Some(since) if attempt.phase == AWAITING_JUDGES => {
                times.insert(QUEUE_SINCE.into(), since);
            }
            _ => {
                times.remove(QUEUE_SINCE);
            }
        }
        service.store.save_attempt(&attempt).await?;
    }
    Ok(false)
}

#[cfg(test)]
#[path = "judge_watchdog_tests.rs"]
mod tests;
