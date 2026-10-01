//! Quota belongs to a whole controlled batch. Tokens never allocate shared quota.
use super::{store::now, types::*};
use crate::services::provider_account_status::benchmark_sampling::AccountMeasurement;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterEvidence {
    pub before: Option<f64>,
    pub after: Option<f64>,
    pub precision: Option<f64>,
    pub before_reset: Option<i64>,
    pub after_reset: Option<i64>,
    pub started_at: i64,
    pub finished_at: i64,
    pub settled: bool,
    pub fresh: bool,
    pub scope_known: bool,
    pub isolated_declared: bool,
    pub activity_changed: bool,
    pub composition_matched: bool,
    pub source_unchanged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub state: String,
    pub reason: String,
    pub delta: Option<f64>,
    pub low: Option<f64>,
    pub high: Option<f64>,
    pub confirmed_eligible: bool,
}

pub fn attribute(e: &MeterEvidence) -> Attribution {
    let mut a = Attribution {
        state: "unknown".into(),
        reason: "Missing or stale quota telemetry".into(),
        delta: None,
        low: None,
        high: None,
        confirmed_eligible: false,
    };
    if e.activity_changed {
        a.state = "mixed".into();
        a.reason =
            "Other work overlapped the quota scope; no per-task charge can be attributed".into();
    }
    let Some((before, after)) = e.before.zip(e.after).filter(|(b, a)| {
        b.is_finite() && a.is_finite() && (0.0..=100.0).contains(b) && (0.0..=100.0).contains(a)
    }) else {
        return a;
    };
    a.delta = Some(after - before);
    if e.activity_changed {
        return a;
    }
    if e.before_reset != e.after_reset
        || e.before_reset
            .is_some_and(|r| r > e.started_at && r <= e.finished_at)
        || after < before
    {
        a.reason = "Reset or replenishment crossed the measured interval".into();
        return a;
    }
    if !e.fresh || !e.settled {
        a.reason = "Provider accounting has not been demonstrated fresh and settled".into();
        return a;
    }
    if !e.source_unchanged || !e.composition_matched {
        a.reason = "Telemetry semantics or output/cache composition changed".into();
        return a;
    }
    if !e.scope_known || !e.isolated_declared {
        a.state = "mixed".into();
        a.reason = "Shared subscription identity or external isolation is unverified".into();
        return a;
    }
    let Some(precision) = e.precision.filter(|p| p.is_finite() && *p >= 0.0) else {
        a.reason = "Meter precision is unknown".into();
        return a;
    };
    // Conservatively allow one full resolution step of error at each endpoint.
    let low = after - before - 2.0 * precision;
    let high = after - before + 2.0 * precision;
    a.low = Some(low);
    a.high = Some(high);
    if low <= 0.0 {
        a.reason = "Rounded readings cannot resolve a positive quota charge".into();
        return a;
    }
    a.state = "controlled_batch".into();
    a.reason = "Quota measured for all attempts in this batch".into();
    a.confirmed_eligible = true;
    a
}

pub fn sample(
    run_id: &str,
    attempts: &[Attempt],
    before: &AccountMeasurement,
    after: &AccountMeasurement,
    activity_changed: bool,
    isolation_declared: bool,
) -> Vec<UsageSample> {
    before.windows.iter().map(|window|{
        let end=after.windows.iter().find(|w|w.id==window.id&&w.model_id==window.model_id);
        let evidence=MeterEvidence{before:window.used_percent,after:end.and_then(|w|w.used_percent),precision:before.precision_percent,
            before_reset:window.resets_at,after_reset:end.and_then(|w|w.resets_at),started_at:before.fetch_finished_at,finished_at:after.fetch_finished_at,
            // Existing adapters expose fetch freshness, not accounting settlement. A pilot must calibrate it.
            settled:false,fresh:!before.stale&&!after.stale&&before.error.is_none()&&after.error.is_none(),
            scope_known:before.scope_confidence=="verified"&&before.scope_key==after.scope_key,
            isolated_declared:isolation_declared,activity_changed,composition_matched:true,
            source_unchanged:before.source==after.source&&before.subscription==after.subscription};
        let attribution=attribute(&evidence);
        UsageSample{id:uuid::Uuid::new_v4().to_string(),run_id:run_id.into(),account_scope:before.scope_key.clone(),window_id:window.id.clone(),captured_at:now(),
            before_used_percent:evidence.before,after_used_percent:evidence.after,resolution_percent:evidence.precision,reset_at:evidence.after_reset,
            attribution:attribution.state,status:if attribution.confirmed_eligible{"preliminary"}else{"cannot_attribute"}.into(),
            completed_tasks:attempts.iter().filter(|a|a.outcome.as_deref()==Some("pass")).count() as u32,
            used_percentage_points:attribution.delta,reason:attribution.reason,attempt_ids:attempts.iter().map(|a|a.id.clone()).collect(),
            evidence:json!({"meter":evidence,"before":before,"after":after,"deltaLow":attribution.low,"deltaHigh":attribution.high,"semantics":"whole_batch","externalActivityObservable":false})}
    }).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EfficiencyPeriod {
    pub period: String,
    pub work: f64,
    pub delta: f64,
    pub low: f64,
    pub high: f64,
    pub eligible: bool,
    pub workload: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceComparison {
    pub retained_percent: Option<f64>,
    pub low: Option<f64>,
    pub high: Option<f64>,
    pub status: String,
    pub reason: String,
}

fn separation_probability(before: usize, after: usize) -> f64 {
    // Under the exchangeable-period null, complete directional separation has
    // probability 1 / choose(n + m, n). Repeated runs in one period are not units.
    let k = before.min(after);
    (1..=k).fold(1.0, |probability, i| {
        probability * i as f64 / (before + after - k + i) as f64
    })
}

pub fn compare_efficiency(
    baseline: &[EfficiencyPeriod],
    current: &[EfficiencyPeriod],
    threshold: f64,
) -> AllowanceComparison {
    let mut result = AllowanceComparison {
        retained_percent: None,
        low: None,
        high: None,
        status: "insufficient_evidence".into(),
        reason: "Repeated independent matched-work periods are required".into(),
    };
    let Some(workload) = baseline.first().map(|s| &s.workload) else {
        return result;
    };
    if workload.is_empty()
        || workload == "unknown"
        || baseline.is_empty()
        || current.is_empty()
        || baseline.iter().chain(current).any(|p| {
            !p.eligible
                || &p.workload != workload
                || [p.low, p.high, p.work, p.delta]
                    .iter()
                    .any(|v| !v.is_finite())
                || p.low <= 0.0
                || p.work <= 0.0
                || p.delta <= 0.0
                || p.high < p.low
        })
    {
        return result;
    }
    let mean = |xs: &[EfficiencyPeriod]| {
        xs.iter().map(|x| x.work / x.delta).sum::<f64>() / xs.len() as f64
    };
    let initial = mean(baseline);
    let latest = mean(current);
    let low = current
        .iter()
        .map(|x| x.work / x.high)
        .fold(f64::INFINITY, f64::min)
        / baseline.iter().map(|x| x.work / x.low).fold(0.0, f64::max)
        * 100.0;
    let high = current.iter().map(|x| x.work / x.low).fold(0.0, f64::max)
        / baseline
            .iter()
            .map(|x| x.work / x.high)
            .fold(f64::INFINITY, f64::min)
        * 100.0;
    result.retained_percent = Some(100.0 * latest / initial);
    result.low = Some(low);
    result.high = Some(high);
    result.status = "preliminary".into();
    let unique = |xs: &[EfficiencyPeriod]| {
        xs.iter()
            .map(|x| &x.period)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == xs.len()
    };
    let disjoint = baseline
        .iter()
        .all(|a| current.iter().all(|b| a.period != b.period));
    // A conservative pilot rule, reported as a bounded measurement rather than a universal test.
    if baseline.len() >= 3
        && current.len() >= 3
        && unique(baseline)
        && unique(current)
        && disjoint
        && high < 100.0 * (1.0 - threshold)
        && separation_probability(baseline.len(), current.len()) <= 0.05 + f64::EPSILON
    {
        result.status = "confirmed_change".into();
    }
    result.reason="efficiency-envelope-v2: successful work per percentage point; endpoint precision and empirical range (not a confidence interval); complete-separation permutation test over independent exchangeable periods; workload-specific".into();
    result
}

pub fn capacity_result(
    completed: u32,
    full_start: bool,
    quota_exhausted: bool,
    unrelated_window_blocked: bool,
) -> (String, String) {
    if unrelated_window_blocked {
        return (
            "unknown".into(),
            "Another quota window stopped the experiment".into(),
        );
    }
    if quota_exhausted && full_start {
        return (
            "measured".into(),
            format!("Observed {completed} completed tasks from a verified full allowance"),
        );
    }
    if quota_exhausted {
        return (
            "remaining_capacity".into(),
            format!("Observed {completed} tasks from an unknown starting balance"),
        );
    }
    (
        "lower_bound".into(),
        format!("At least {completed} tasks; limit not reached"),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageComparison {
    pub account_scope: String,
    pub window_id: String,
    pub retained_percent: Option<f64>,
    pub interval_low: Option<f64>,
    pub interval_high: Option<f64>,
    pub status: String,
    pub reason: String,
    pub sample_ids: Vec<String>,
}

pub fn compare_samples(samples: &[UsageSample], baseline: &Baseline) -> Vec<UsageComparison> {
    let keys: std::collections::BTreeSet<_> = samples
        .iter()
        .map(|s| (&s.account_scope, &s.window_id))
        .collect();
    let mut results = keys
        .into_iter()
        .map(|(scope, window)| {
            let matching: Vec<_> = samples
                .iter()
                .filter(|s| &s.account_scope == scope && &s.window_id == window)
                .collect();
            let period = |s: &&UsageSample| EfficiencyPeriod {
                period: s.evidence["measurementPeriod"]
                    .as_str()
                    .unwrap_or(&s.run_id)
                    .into(),
                work: f64::from(s.completed_tasks),
                delta: s.used_percentage_points.unwrap_or(0.0),
                low: s.evidence["deltaLow"].as_f64().unwrap_or(0.0),
                high: s.evidence["deltaHigh"].as_f64().unwrap_or(0.0),
                eligible: s.attribution == "controlled_batch"
                    && s.evidence["measurementPeriod"].as_str().is_some(),
                workload: s.evidence["workloadHash"]
                    .as_str()
                    .unwrap_or("unknown")
                    .into(),
            };
            let before = matching
                .iter()
                .copied()
                .filter(|s| baseline.run_ids.contains(&s.run_id))
                .map(|s| period(&s))
                .collect::<Vec<_>>();
            let after = matching
                .iter()
                .copied()
                .filter(|s| {
                    !baseline.run_ids.contains(&s.run_id) && s.captured_at > baseline.created_at
                })
                .map(|s| period(&s))
                .collect::<Vec<_>>();
            let result = compare_efficiency(&before, &after, baseline.threshold);
            let probability = if result.status == "confirmed_change" {
                separation_probability(before.len(), after.len())
            } else {
                1.0
            };
            (
                probability,
                UsageComparison {
                    account_scope: scope.clone(),
                    window_id: window.clone(),
                    retained_percent: result.retained_percent,
                    interval_low: result.low,
                    interval_high: result.high,
                    status: result.status,
                    reason: result.reason,
                    sample_ids: matching.iter().map(|s| s.id.clone()).collect(),
                },
            )
        })
        .collect::<Vec<_>>();
    results.sort_by(|a, b| a.0.total_cmp(&b.0));
    let count = results.len();
    let mut rejected = false;
    for (index, (probability, result)) in results.iter_mut().enumerate() {
        if rejected || *probability > 0.05 / (count - index) as f64 + f64::EPSILON {
            rejected = true;
            if result.status == "confirmed_change" {
                result.status = "preliminary".into();
            }
        }
        result
            .reason
            .push_str("; Holm correction across displayed scopes/windows");
    }
    results.into_iter().map(|(_, result)| result).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn meter() -> MeterEvidence {
        MeterEvidence {
            before: Some(20.0),
            after: Some(25.0),
            precision: Some(0.1),
            before_reset: Some(10000),
            after_reset: Some(10000),
            started_at: 1,
            finished_at: 100,
            settled: true,
            fresh: true,
            scope_known: true,
            isolated_declared: true,
            activity_changed: false,
            composition_matched: true,
            source_unchanged: true,
        }
    }
    #[test]
    fn mixed_keeps_account_delta_but_never_task_charge() {
        let mut m = meter();
        m.activity_changed = true;
        let a = attribute(&m);
        assert_eq!(a.state, "mixed");
        assert_eq!(a.delta, Some(5.0));
        assert!(!a.confirmed_eligible);
    }
    #[test]
    fn reset_rounding_delay_and_unknown_are_excluded() {
        for i in 0..5 {
            let mut m = meter();
            match i {
                0 => m.after_reset = Some(20000),
                1 => m.precision = Some(3.0),
                2 => m.settled = false,
                3 => m.scope_known = false,
                _ => m.before = None,
            };
            assert!(!attribute(&m).confirmed_eligible);
        }
    }
    #[test]
    fn quota_doubling_needs_independent_repeats() {
        let periods = |prefix: &str, delta| {
            (0..3)
                .map(|i| EfficiencyPeriod {
                    period: format!("{prefix}{i}"),
                    work: 10.0,
                    delta,
                    low: delta - 0.1,
                    high: delta + 0.1,
                    eligible: true,
                    workload: "frozen".into(),
                })
                .collect::<Vec<_>>()
        };
        let b = periods("b", 5.0);
        let c = periods("c", 10.0);
        let comparison = compare_efficiency(&b, &c, 0.1);
        assert_eq!(comparison.status, "confirmed_change");
        assert_eq!(comparison.retained_percent, Some(50.0));
        assert_eq!(
            compare_efficiency(&b[..1], &c[..1], 0.1).status,
            "preliminary"
        );
        let mut mixed = c;
        mixed[0].eligible = false;
        assert_eq!(compare_efficiency(&b, &mixed, 0.1).retained_percent, None);
    }
    #[test]
    fn capacity_budget_is_a_lower_bound() {
        assert_eq!(capacity_result(9, true, false, false).0, "lower_bound");
        assert_eq!(
            capacity_result(9, false, true, false).0,
            "remaining_capacity"
        );
        assert_eq!(capacity_result(9, true, true, true).0, "unknown");
    }
}
