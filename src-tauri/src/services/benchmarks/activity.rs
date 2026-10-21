//! Durable clocks, independent of model speed and of the run drawer's lifetime.
use super::types::{ActivityKind, ActivitySpan, Attempt, AttemptActivity};

pub(super) fn kind(attempt: &Attempt, state: &str) -> Option<ActivityKind> {
    if !matches!(state, "running" | "pausing" | "cancelling")
        || matches!(attempt.phase.as_str(), "terminal" | "interrupted")
    {
        return None;
    }
    if attempt.phase == "pending"
        || attempt
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("Waiting for local resources"))
    {
        return Some(ActivityKind::Waiting);
    }
    let judging = attempt.phase_times.as_ref().is_some_and(|times| {
        times
            .get("judgeStarted")
            .is_some_and(|start| times.get("judgeFinished").is_none_or(|end| start > end))
    });
    if attempt.phase == "awaiting_judges" && !judging {
        return Some(ActivityKind::Waiting);
    }
    Some(ActivityKind::Execution)
}

pub(super) fn record(activity: &mut Option<AttemptActivity>, kind: Option<ActivityKind>, at: i64) {
    let history = activity.get_or_insert_with(|| AttemptActivity {
        recorded_from: at,
        complete: false,
        spans: Vec::new(),
    });
    if let Some(last) = history.spans.last_mut() {
        if last.finished_at.is_none() {
            if Some(last.kind) == kind {
                return;
            }
            last.finished_at = Some(at.max(last.started_at));
        }
    }
    if let Some(kind) = kind {
        let at = history
            .spans
            .last()
            .and_then(|span| span.finished_at)
            .unwrap_or(at)
            .max(at);
        history.spans.push(ActivitySpan {
            kind,
            started_at: at,
            finished_at: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_retries_do_not_reset_waits_and_pauses_count_nowhere() {
        let mut activity = None;
        record(&mut activity, Some(ActivityKind::Waiting), 1000);
        record(&mut activity, Some(ActivityKind::Waiting), 121_000);
        record(&mut activity, Some(ActivityKind::Execution), 181_000);
        record(&mut activity, Some(ActivityKind::Waiting), 211_000);
        record(&mut activity, None, 271_000); // Pause.
        record(&mut activity, Some(ActivityKind::Waiting), 991_000);
        record(&mut activity, Some(ActivityKind::Execution), 1_021_000);
        record(&mut activity, None, 1_041_000);
        let spans = activity.unwrap().spans;
        let duration = |kind| {
            spans
                .iter()
                .filter(|span| span.kind == kind)
                .map(|span| span.finished_at.unwrap() - span.started_at)
                .sum::<i64>()
        };
        assert_eq!(duration(ActivityKind::Execution), 50_000);
        assert_eq!(duration(ActivityKind::Waiting), 270_000);
        assert_eq!(spans.len(), 5);
    }
}
