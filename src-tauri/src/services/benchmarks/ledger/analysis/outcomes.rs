//! What an attempt's record says happened: its outcome as of a date, its score, its panel.
use super::*;

pub(in crate::services::benchmarks) fn score(attempt: &Attempt) -> Option<f64> {
    score_as_of(attempt, None)
}

/// How long a run stays open after it started, time it spent paused left
/// out: the window in which its unfinished cases may still be measured.
/// Once it closes the run is baked, complete cells kept and the rest
/// dropped, and nothing changes it after.
pub const RUN_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// When a run's window closes as of `at`: a paused run's window waits for it.
pub fn window_closes_at(run: &BenchmarkRun, at: i64) -> i64 {
    let resting = run
        .paused_since
        .map_or(0, |since| at.saturating_sub(since).max(0));
    run.created_at + RUN_WINDOW_MS + run.paused_ms + resting
}

/// When a run's window closes, as of now.
pub fn window_closes(run: &BenchmarkRun) -> i64 {
    window_closes_at(run, crate::services::benchmarks::now())
}

/// The outcome of an attempt that no longer counts: a repetition of a case
/// measured again, or one its run's closing window left
/// short. The attempt keeps its evidence and spend; no cell holds it.
pub const SUPERSEDED: &str = "superseded";

pub fn is_superseded(attempt: &Attempt) -> bool {
    attempt.outcome.as_deref() == Some(SUPERSEDED)
}

/// Whether an attempt holds a measurement: a settled generation with a
/// quality outcome, scored or still before its reviewers.
pub(in crate::services::benchmarks) fn is_measured(attempt: &Attempt) -> bool {
    attempt.phase == "terminal" && has_quality_outcome(attempt.outcome.as_deref())
}

/// A run's cells by case and configuration, superseded repetitions left
/// out: what finishing and baking a run decide on.
pub(in crate::services::benchmarks) fn run_cells(
    run: &BenchmarkRun,
) -> BTreeMap<(String, String), Vec<Attempt>> {
    let mut cells: BTreeMap<(String, String), Vec<Attempt>> = BTreeMap::new();
    for attempt in run.attempts.iter().filter(|a| !is_superseded(a)) {
        cells
            .entry((attempt.version_id.clone(), attempt.configuration.id.clone()))
            .or_default()
            .push(attempt.clone());
    }
    cells
}

pub(super) fn valid_score(score: &f64) -> bool {
    score.is_finite() && (0.0..=1.0).contains(score)
}

/// The judge panel's state over a list of evaluations in recorded order.
pub(super) enum Panel {
    /// No render marker: the attempt was never sent to a panel.
    Absent,
    /// Markers exist, but no batch reached its panel size.
    Pending,
    /// The newest batch that reached its panel size: the index of its render
    /// marker and its valid votes.
    Settled { marker: usize, votes: Vec<f64> },
}

/// A batch runs from its render marker to the next one. The newest batch
/// whose valid votes reached its `expectedJudges` scores the attempt, so an
/// unfinished re-evaluation never hides a settled panel.
pub(super) fn judge_panel(evaluations: &[&Evaluation]) -> Panel {
    let markers: Vec<usize> = evaluations
        .iter()
        .enumerate()
        .filter(|(_, e)| e.provenance == "render")
        .map(|(index, _)| index)
        .collect();
    if markers.is_empty() {
        return Panel::Absent;
    }
    for position in (0..markers.len()).rev() {
        let start = markers[position];
        let end = markers
            .get(position + 1)
            .copied()
            .unwrap_or(evaluations.len());
        let expected = evaluations[start]
            .details
            .as_ref()
            .and_then(|d| d["expectedJudges"].as_u64())
            .unwrap_or(1) as usize;
        let critical = evaluations[start].details.as_ref().is_some_and(|details| {
            details
                .pointer("/protocol/criticalCheckPolicy")
                .and_then(serde_json::Value::as_str)
                == Some(crate::services::benchmarks::judge_checks::POLICY)
        });
        let mut critical_failed = false;
        let bound;
        let answers = if evaluations[start].details.as_ref().is_some_and(|details| {
            details
                .pointer("/protocol/panelRecipe")
                .and_then(serde_json::Value::as_str)
                == Some(crate::services::benchmarks::judge_panel::RECIPE)
        }) {
            let Some(answers) = crate::services::benchmarks::judge_panel::bound_evaluations(
                evaluations[start],
                &evaluations[start + 1..end],
            ) else {
                continue;
            };
            bound = answers;
            bound.as_slice()
        } else {
            &evaluations[start..end]
        };
        let scored: Vec<(&Evaluation, f64)> = answers
            .iter()
            .filter(|e| e.provenance == "judge")
            .filter_map(|e| {
                let score = e.score.filter(valid_score)?;
                if critical {
                    let details = e.details.as_ref()?;
                    if details["criticalCheckPolicy"]
                        != crate::services::benchmarks::judge_checks::POLICY
                    {
                        return None;
                    }
                    match details["criticalCheckStatus"].as_str()? {
                        "fail" => critical_failed = true,
                        "pass" => {}
                        _ => return None,
                    }
                }
                Some((*e, score))
            })
            .collect();
        if scored.len() >= expected {
            // A panel that asked each seat several times counts each seat once,
            // as the median of its samples.
            let samples = evaluations[start]
                .details
                .as_ref()
                .and_then(|details| details.pointer("/protocol/samplesPerJudge"))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(1);
            let mut votes: Vec<f64> = if samples > 1 {
                let mut seats: BTreeMap<String, Vec<f64>> = BTreeMap::new();
                for (evaluation, score) in &scored {
                    let seat = serde_json::to_string(&evaluation.judge).unwrap_or_default();
                    seats.entry(seat).or_default().push(*score);
                }
                // Every seat with all its samples, or the batch has not settled.
                if seats.len() as u64 * samples != expected as u64
                    || seats.values().any(|seat| seat.len() as u64 != samples)
                {
                    continue;
                }
                seats.into_values().filter_map(median).collect()
            } else {
                scored.iter().map(|(_, score)| *score).collect()
            };
            if critical_failed {
                votes.fill(0.0);
            }
            return Panel::Settled {
                marker: start,
                votes,
            };
        }
    }
    Panel::Pending
}

/// Read legacy records through their latest evidence without rewriting the archive.
pub(in crate::services::benchmarks) fn evaluation_outcome(
    evaluations: &[Evaluation],
) -> Option<&str> {
    if let Some(human) = evaluations.iter().rev().find(|e| e.provenance == "human") {
        return Some(&human.verdict);
    }
    match judge_panel(&evaluations.iter().collect::<Vec<_>>()) {
        Panel::Settled { .. } => return Some("judged"),
        Panel::Pending => return Some("pending_review"),
        Panel::Absent => {}
    }
    evaluations
        .iter()
        .rev()
        .find(|e| !matches!(e.provenance.as_str(), "human_visual" | "judge_failure"))
        .map(|e| e.verdict.as_str())
}

pub(in crate::services::benchmarks) fn normalize_outcome(mut attempt: Attempt) -> Attempt {
    attempt.outcome = effective_outcome(attempt.outcome.as_deref(), &attempt.evaluations);
    // Kimi turns recorded before the runner knew them: read, never rewritten.
    if matches!(attempt.outcome.as_deref(), Some("fail" | "no_answer"))
        && kimi_never_answered(&attempt.configuration.provider_id, &attempt.usage)
        && !attempt.evaluations.iter().any(|e| e.provenance == "human")
    {
        attempt.outcome = Some("infrastructure_failure".into());
        attempt.reason = Some(KIMI_UNANSWERED.into());
    }
    attempt
}

/// Why a Kimi turn with no answer is not the model's: Kimi Code ends a turn
/// whose model request failed (a rate limit, an overload, a refused request
/// or option) with a plain `end_turn` and keeps the error to itself, so the
/// host sees an empty turn. 10-24: 23 kimi-for-coding-highspeed turns ended
/// so within two seconds and were scored as the model's failures.
pub(in crate::services::benchmarks) const KIMI_UNANSWERED: &str = "Kimi Code ended the turn without completing a model request and reported no error; nothing was answered";

/// Whether a Kimi turn completed no model request: Flock's Kimi adapter
/// gives every turn the engine's usage, and the engine counts every request
/// that completed, so a turn without counters asked nothing that answered.
/// Of every Kimi turn on record at 11-16, each one without counters had no
/// answer and ran under five seconds, and every answer had counters.
pub(in crate::services::benchmarks) fn kimi_never_answered(
    provider_id: &str,
    usage: &TokenUsage,
) -> bool {
    provider_id == "kimi-acp"
        && usage.input.is_none()
        && usage.output.is_none()
        && usage.cache_read.is_none()
        && usage.cache_write.is_none()
}

/// The outcome shown for an attempt as it stood at `as_of`: none before it
/// finished, else the newest evidence recorded by then. Today's stored outcome
/// never stands in for a verdict that was recorded later.
pub(in crate::services::benchmarks) fn outcome_as_of(
    outcome: Option<&str>,
    finished_at: Option<i64>,
    evaluations: &[Evaluation],
    as_of: Option<i64>,
) -> Option<String> {
    let Some(at) = as_of else {
        return effective_outcome(outcome, evaluations);
    };
    if finished_at.is_none_or(|end| end > at) {
        return None;
    }
    let known: Vec<Evaluation> = evaluations
        .iter()
        .filter(|e| e.created_at <= at)
        .cloned()
        .collect();
    if has_quality_outcome(outcome)
        && !is_budget_failure(outcome)
        && known.iter().all(|e| e.provenance == "human_visual")
        && evaluations.iter().any(|e| e.provenance != "human_visual")
    {
        return Some("pending_review".into());
    }
    effective_outcome(outcome, &known)
}

pub(in crate::services::benchmarks) fn effective_outcome(
    outcome: Option<&str>,
    evaluations: &[Evaluation],
) -> Option<String> {
    if has_quality_outcome(outcome) && !is_budget_failure(outcome) {
        evaluation_outcome(evaluations)
            .or(outcome)
            .map(str::to_owned)
    } else {
        outcome.map(str::to_owned)
    }
}

/// An answer past the published artifact cap, or a turn the run's time limit
/// stopped, is a task failure, not an infrastructure exclusion: the candidate
/// chose that behavior, and a limit of hours is a safety stop that only a hung
/// turn reaches. Both score a fixed 0 that no later evaluation of the partial
/// output can change.
pub(super) fn is_budget_failure(outcome: Option<&str>) -> bool {
    matches!(outcome, Some("budget_reached" | "budget_timeout"))
}

pub(super) fn has_quality_outcome(outcome: Option<&str>) -> bool {
    matches!(
        outcome,
        Some(
            "pass"
                | "fail"
                // A repository turn that left the snapshot unchanged: the
                // candidate's result, scored 0, kept apart for diagnosis.
                | "no_answer"
                | "judged"
                | "pending_review"
                | "completed"
                | "budget_reached"
                | "budget_timeout"
        )
    )
}

pub(in crate::services::benchmarks) fn score_as_of(
    attempt: &Attempt,
    as_of: Option<i64>,
) -> Option<f64> {
    score_of(
        attempt.outcome.as_deref(),
        attempt.finished_at,
        &attempt.evaluations,
        as_of,
    )
}

/// [`score_as_of`] from the parts of an attempt it reads, for a listing that
/// holds no full attempt.
pub(in crate::services::benchmarks) fn score_of(
    outcome: Option<&str>,
    finished_at: Option<i64>,
    recorded: &[Evaluation],
    as_of: Option<i64>,
) -> Option<f64> {
    if !has_quality_outcome(outcome) {
        return None;
    }
    if as_of.is_some_and(|at| finished_at.is_none_or(|finished| finished > at)) {
        return None;
    }
    if is_budget_failure(outcome) {
        return Some(0.0);
    }
    let evaluations: Vec<_> = recorded
        .iter()
        .filter(|e| as_of.is_none_or(|at| e.created_at <= at))
        .collect();
    if let Some(review) = evaluations.iter().rev().find(|e| e.provenance == "human") {
        return review.score.filter(valid_score);
    }
    match judge_panel(&evaluations) {
        Panel::Settled { votes, .. } => return median(votes),
        Panel::Pending => return None,
        Panel::Absent => {}
    }
    // Legacy judge votes recorded without a render marker.
    let judged: Vec<_> = evaluations
        .iter()
        .filter(|e| e.provenance == "judge")
        .filter_map(|e| e.score)
        .filter(valid_score)
        .collect();
    if !judged.is_empty() {
        return median(judged);
    }
    if let Some(evaluation) = evaluations
        .iter()
        .rev()
        .find(|e| e.provenance != "human_visual" && e.provenance != "judge_failure")
    {
        return evaluation.score.filter(valid_score);
    }
    // Evaluated attempts get their score only from evidence available at the
    // cutoff. Today's mutable outcome cannot fill an earlier missing verdict.
    if recorded.iter().any(|e| e.provenance != "human_visual") {
        return None;
    }
    match outcome? {
        "pass" => Some(1.0),
        "fail" => Some(0.0),
        _ => None,
    }
}
