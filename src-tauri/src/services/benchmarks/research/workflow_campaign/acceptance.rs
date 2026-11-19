//! Preregistered empirical screening. Passing is not qualification or approval.
use super::*;
use crate::services::benchmarks::learned::report::ReportCase;

const RECIPE: &str = "independent-group-sign-holm-v1";
/// For a selector that runs one of the fixed workers per task. It ties the
/// worker it picks wherever it picks it, so beating every worker is not the
/// question. It must beat the declared order and the training aggregate (a
/// classical sign test: tied groups carry no sign) and be no worse than every
/// fixed worker by more than the registered margin.
pub(in crate::services::benchmarks) const SELECTION_RECIPE: &str =
    "superiority-noninferiority-sign-holm-v1";
const MAX_NON_INFERIORITY_MARGIN: f64 = 0.2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub recipe: String,
    /// Family-wise error budget across every fixed worker, aggregate and persona.
    pub alpha: f64,
    /// A tie at this margin counts as a non-win; repetitions are not samples.
    pub minimum_group_utility_gain: f64,
    /// An observed equal-group quality floor, not a population confidence bound.
    pub minimum_observed_quality: f64,
    /// The utility a fixed worker may lead by in a group without a loss;
    /// only the selection recipe takes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub non_inferiority_margin: Option<f64>,
}
impl Rule {
    pub(in crate::services::benchmarks) fn validate(&self) -> Result<()> {
        let margin = match (self.recipe.as_str(), self.non_inferiority_margin) {
            (RECIPE, None) => true,
            (SELECTION_RECIPE, Some(margin)) => {
                margin.is_finite() && margin > 0.0 && margin <= MAX_NON_INFERIORITY_MARGIN
            }
            _ => false,
        };
        if !margin
            || !self.alpha.is_finite()
            || !(0.0..=0.05).contains(&self.alpha)
            || self.alpha == 0.0
            || !self.minimum_group_utility_gain.is_finite()
            || !(0.0..1.0).contains(&self.minimum_group_utility_gain)
            || !self.minimum_observed_quality.is_finite()
            || !(0.0..=1.0).contains(&self.minimum_observed_quality)
        {
            return Err(invalid("Acceptance requires independent-group-sign-holm-v1, or superiority-noninferiority-sign-holm-v1 with a margin in (0,0.2], alpha in (0,.05], gain in [0,1), and observed quality in [0,1]"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub baseline: String,
    /// `superiority` or `non_inferiority`; absent under the original recipe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test: Option<String>,
    /// Groups without a sign in a superiority test; absent when ties count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tied_groups: Option<usize>,
    pub winning_groups: usize,
    pub mean_utility_gain: f64,
    pub p_value: f64,
    pub adjusted_p_value: f64,
    pub passed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub rule: Rule,
    pub groups: usize,
    pub observed_quality: f64,
    pub comparisons: Vec<Comparison>,
    pub passed: bool,
    pub reasons: Vec<String>,
    pub limitations: Vec<String>,
}

/// P[Binomial(n,.5) >= wins]. Retaining ties as non-wins is conservative.
/// Independent, representative group-level Bernoulli trials are required.
fn sign_tail(wins: usize, groups: usize) -> f64 {
    let mut mass = 2.0_f64.powi(-(groups as i32));
    let mut tail = 0.0;
    for k in 0..=groups {
        if k >= wins {
            tail += mass;
        }
        mass *= (groups - k) as f64 / (k + 1) as f64;
    }
    tail.clamp(0.0, 1.0)
}
fn holm(comparisons: &mut [Comparison]) {
    let mut order: Vec<_> = (0..comparisons.len()).collect();
    order.sort_by(|a, b| {
        comparisons[*a]
            .p_value
            .total_cmp(&comparisons[*b].p_value)
            .then(a.cmp(b))
    });
    let mut bound: f64 = 0.0;
    for (rank, index) in order.into_iter().enumerate() {
        bound = bound
            .max(comparisons[index].p_value * (comparisons.len() - rank) as f64)
            .min(1.0);
        comparisons[index].adjusted_p_value = bound;
    }
}

pub(in crate::services::benchmarks) fn assess(
    rule: &Rule,
    cases: &[ReportCase],
    fixed_ids: &[String],
) -> Result<Assessment> {
    rule.validate()?;
    let baselines: Vec<String> = ["aggregate".into(), "persona".into()]
        .into_iter()
        .chain(fixed_ids.iter().map(|id| format!("worker:{id}")))
        .collect();
    let expected: BTreeSet<_> = baselines
        .iter()
        .cloned()
        .chain(["learned".into()])
        .collect();
    if !(8..=256).contains(&cases.len())
        || fixed_ids.len() < 2
        || fixed_ids.len() > 32
        || expected.len() != baselines.len() + 1
        || cases
            .iter()
            .map(|c| &c.version_id)
            .collect::<BTreeSet<_>>()
            .len()
            != cases.len()
    {
        return Err(invalid(
            "Acceptance needs distinct cases and the complete preregistered candidate pool",
        ));
    }
    let mut grouped: BTreeMap<&str, Vec<&ReportCase>> = BTreeMap::new();
    for case in cases {
        if case.group.trim().is_empty()
            || case.cells.len() != expected.len()
            || case
                .cells
                .iter()
                .map(|c| c.candidate_key.clone())
                .collect::<BTreeSet<_>>()
                != expected
            || case.cells.iter().any(|c| {
                !c.quality.is_finite()
                    || !(0.0..=1.0).contains(&c.quality)
                    || !c.utility.is_finite()
                    || !(0.0..=1.0).contains(&c.utility)
            })
        {
            return Err(invalid(
                "Acceptance refuses missing, duplicate or invalid policy results",
            ));
        }
        grouped.entry(&case.group).or_default().push(case);
    }
    let groups = grouped.len();
    let value = |case: &ReportCase, key: &str, quality: bool| {
        let cell = case
            .cells
            .iter()
            .find(|c| c.candidate_key == key)
            .expect("validated arms");
        if quality {
            cell.quality
        } else {
            cell.utility
        }
    };
    let observed_quality = grouped
        .values()
        .map(|group| {
            group
                .iter()
                .map(|case| value(case, "learned", true))
                .sum::<f64>()
                / group.len() as f64
        })
        .sum::<f64>()
        / groups as f64;
    let selection = rule.recipe == SELECTION_RECIPE;
    let margin = rule.non_inferiority_margin.unwrap_or(0.0);
    let mut comparisons = Vec::new();
    for baseline in baselines {
        let gains: Vec<_> = grouped
            .values()
            .map(|group| {
                group
                    .iter()
                    .map(|case| value(case, "learned", false) - value(case, &baseline, false))
                    .sum::<f64>()
                    / group.len() as f64
            })
            .collect();
        let mean_utility_gain = gains.iter().sum::<f64>() / groups as f64;
        let comparison = if selection && baseline.starts_with("worker:") {
            let wins = gains.iter().filter(|gain| **gain > -margin + 1e-12).count();
            Comparison {
                baseline,
                test: Some("non_inferiority".into()),
                tied_groups: None,
                winning_groups: wins,
                mean_utility_gain,
                p_value: sign_tail(wins, groups),
                adjusted_p_value: 1.0,
                passed: false,
            }
        } else {
            let wins = gains
                .iter()
                .filter(|gain| **gain > rule.minimum_group_utility_gain + 1e-12)
                .count();
            // The original recipe keeps ties as non-wins. The selection recipe
            // drops groups of equal utility, as a classical sign test does.
            let tied = if selection {
                gains.iter().filter(|gain| gain.abs() <= 1e-12).count()
            } else {
                0
            };
            Comparison {
                baseline,
                test: selection.then(|| "superiority".into()),
                tied_groups: selection.then_some(tied),
                winning_groups: wins,
                mean_utility_gain,
                p_value: sign_tail(wins, groups - tied),
                adjusted_p_value: 1.0,
                passed: false,
            }
        };
        comparisons.push(comparison);
    }
    holm(&mut comparisons);
    for comparison in &mut comparisons {
        let required = if comparison.test.as_deref() == Some("non_inferiority") {
            -margin
        } else {
            rule.minimum_group_utility_gain
        };
        comparison.passed = comparison.adjusted_p_value <= rule.alpha
            && comparison.mean_utility_gain > required + 1e-12;
    }
    let mut reasons = Vec::new();
    if groups < 8 {
        reasons.push("fewer_than_eight_independent_groups".into());
    }
    if observed_quality < rule.minimum_observed_quality {
        reasons.push("observed_quality_below_floor".into());
    }
    if comparisons.iter().any(|c| !c.passed) {
        reasons.push("not_superior_to_every_registered_baseline".into());
    }
    if selection {
        return Ok(Assessment { rule:rule.clone(),groups,observed_quality,comparisons,passed:reasons.is_empty(),reasons,
            limitations:vec!["Superiority sign tests concern the groups where the learned choice and the baseline differ in utility; tied groups carry no sign, so few differing groups cannot pass".into(),
                "Non-inferiority counts a group as a loss when a fixed worker leads by at least the registered margin; it is not a confidence bound for the mean difference".into(),
                "The persona is one of the fixed workers, so its superiority test also covers non-inferiority to that worker; Holm counts both".into(),
                "Holm adjustment covers the aggregate, persona and every fixed worker together; best-fixed and oracle remain hindsight summaries".into(),
                "Passing this empirical screen does not establish semantic independence, verifier validity, deployment equivalence or permission to dispatch".into()] });
    }
    Ok(Assessment { rule:rule.clone(),groups,observed_quality,comparisons,passed:reasons.is_empty(),reasons,
        limitations:vec!["Sign tests concern the probability of beating each baseline by the declared margin across independent representative groups, not a confidence bound for the mean gain".into(),
            "Ties count as non-wins; repeated runs and related cases never increase the independent sample count".into(),
            "Holm adjustment covers the registered fixed workers, aggregate and persona together; best-fixed and oracle remain hindsight summaries".into(),
            "Passing this empirical screen does not establish semantic independence, verifier validity, deployment equivalence or permission to dispatch".into()] })
}

/// The selection recipe on cases where a candidate may be absent: the
/// learned and aggregate arms are always present (each chose among the
/// candidates the case measured); the persona arm and a fixed worker are
/// compared only on the groups where they are present. Each comparison counts its own groups and
/// needs at least eight; Holm covers all of them together.
pub(in crate::services::benchmarks) fn assess_available(
    rule: &Rule,
    cases: &[ReportCase],
    fixed_ids: &[String],
) -> Result<Assessment> {
    rule.validate()?;
    if rule.recipe != SELECTION_RECIPE
        || fixed_ids.len() < 2
        || fixed_ids.len() > 32
        || cases.len() > 4096
        || cases
            .iter()
            .map(|c| &c.version_id)
            .collect::<BTreeSet<_>>()
            .len()
            != cases.len()
    {
        return Err(invalid(
            "Assessment on available arms needs the selection recipe, distinct cases and a pool of 2 to 32",
        ));
    }
    let arms = |case: &ReportCase, key: &str| {
        case.cells
            .iter()
            .find(|c| c.candidate_key == key)
            .map(|c| (c.quality, c.utility))
    };
    let mut grouped: BTreeMap<&str, Vec<&ReportCase>> = BTreeMap::new();
    for case in cases {
        // The persona arm is absent where none of the manual order's
        // models measured the case; it is compared where it is present.
        let policy = ["learned", "aggregate"]
            .iter()
            .all(|key| arms(case, key).is_some());
        if case.group.trim().is_empty()
            || !policy
            || case.cells.iter().any(|c| {
                !c.quality.is_finite()
                    || !(0.0..=1.0).contains(&c.quality)
                    || !c.utility.is_finite()
                    || !(0.0..=1.0).contains(&c.utility)
            })
        {
            return Err(invalid(
                "Assessment refuses a case without its policy arms or with invalid results",
            ));
        }
        grouped.entry(&case.group).or_default().push(case);
    }
    let groups = grouped.len();
    let observed_quality = if groups == 0 {
        0.0
    } else {
        grouped
            .values()
            .map(|g| g.iter().map(|c| arms(c, "learned").unwrap().0).sum::<f64>() / g.len() as f64)
            .sum::<f64>()
            / groups as f64
    };
    let margin = rule.non_inferiority_margin.unwrap_or(0.0);
    let baselines: Vec<String> = ["aggregate".into(), "persona".into()]
        .into_iter()
        .chain(fixed_ids.iter().map(|id| format!("worker:{id}")))
        .collect();
    let mut comparisons = Vec::new();
    let mut thin = false;
    for baseline in baselines {
        // Per group: the mean gain over the cases that measured the baseline.
        let gains: Vec<f64> = grouped
            .values()
            .filter_map(|group| {
                let pairs: Vec<f64> = group
                    .iter()
                    .filter_map(|case| Some(arms(case, "learned")?.1 - arms(case, &baseline)?.1))
                    .collect();
                (!pairs.is_empty()).then(|| pairs.iter().sum::<f64>() / pairs.len() as f64)
            })
            .collect();
        let n = gains.len();
        thin |= n < 8;
        let mean_utility_gain = if n == 0 {
            0.0
        } else {
            gains.iter().sum::<f64>() / n as f64
        };
        let comparison = if baseline.starts_with("worker:") {
            let wins = gains.iter().filter(|gain| **gain > -margin + 1e-12).count();
            Comparison {
                baseline,
                test: Some("non_inferiority".into()),
                tied_groups: None,
                winning_groups: wins,
                mean_utility_gain,
                p_value: sign_tail(wins, n),
                adjusted_p_value: 1.0,
                passed: false,
            }
        } else {
            let tied = gains.iter().filter(|gain| gain.abs() <= 1e-12).count();
            let wins = gains
                .iter()
                .filter(|gain| **gain > rule.minimum_group_utility_gain + 1e-12)
                .count();
            Comparison {
                baseline,
                test: Some("superiority".into()),
                tied_groups: Some(tied),
                winning_groups: wins,
                mean_utility_gain,
                p_value: sign_tail(wins, n - tied),
                adjusted_p_value: 1.0,
                passed: false,
            }
        };
        comparisons.push(comparison);
    }
    holm(&mut comparisons);
    for comparison in &mut comparisons {
        let required = if comparison.test.as_deref() == Some("non_inferiority") {
            -margin
        } else {
            rule.minimum_group_utility_gain
        };
        comparison.passed = comparison.adjusted_p_value <= rule.alpha
            && comparison.mean_utility_gain > required + 1e-12;
    }
    let mut reasons = Vec::new();
    if thin {
        reasons.push("fewer_than_eight_independent_groups".into());
    }
    if observed_quality < rule.minimum_observed_quality {
        reasons.push("observed_quality_below_floor".into());
    }
    if comparisons.iter().any(|c| !c.passed) {
        reasons.push("not_superior_to_every_registered_baseline".into());
    }
    Ok(Assessment {
        rule: rule.clone(),
        groups,
        observed_quality,
        comparisons,
        passed: reasons.is_empty(),
        reasons,
        limitations: vec![
            "Each comparison counts only the groups that measured its baseline; a candidate absent from a case is never scored as zero".into(),
            "Superiority sign tests drop tied groups; non-inferiority counts a group as a loss when a fixed worker leads by at least the margin".into(),
            "Holm adjustment covers the aggregate, persona and every fixed worker together within one evaluation, not across repeated evaluations".into(),
            "Held-out cases are a permanent evaluation set every model has seen, not unseen families".into(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::learned::report::ReportCell;

    fn rule() -> Rule {
        Rule {
            recipe: RECIPE.into(),
            alpha: 0.05,
            minimum_group_utility_gain: 0.0,
            minimum_observed_quality: 0.8,
            non_inferiority_margin: None,
        }
    }
    fn cases() -> Vec<ReportCase> {
        (0..8)
            .map(|i| ReportCase {
                version_id: format!("case-{i}"),
                group: format!("group-{i}"),
                learned_key: "learned".into(),
                aggregate_key: "aggregate".into(),
                used_fallback: false,
                cells: ["learned", "aggregate", "persona", "worker:a", "worker:b"]
                    .into_iter()
                    .map(|key| ReportCell {
                        candidate_key: key.into(),
                        run_id: "fixture".into(),
                        quality: if key == "learned" { 1.0 } else { 0.0 },
                        utility: if key == "learned" { 1.0 } else { 0.0 },
                        mean_duration_ms: Some(1.0),
                        mean_cost: Some(1.0),
                        repeats: vec![],
                    })
                    .collect(),
            })
            .collect()
    }
    #[test]
    fn exact_sign_probabilities_and_holm_adjustment_match_enumerated_outcomes() {
        for n in 1..=12 {
            for wins in 0..=n {
                let tail = (0..1u32 << n)
                    .filter(|bits| bits.count_ones() as usize >= wins)
                    .count() as f64
                    / (1u32 << n) as f64;
                assert!((sign_tail(wins, n) - tail).abs() < 1e-12);
            }
        }
        assert!(sign_tail(256, 256).is_finite());
        assert!(sign_tail(256, 256) > 0.0);
        let mut comparisons: Vec<_> = [0.01, 0.04, 0.03, 0.002]
            .into_iter()
            .map(|p| Comparison {
                baseline: String::new(),
                test: None,
                tied_groups: None,
                winning_groups: 0,
                mean_utility_gain: 0.0,
                p_value: p,
                adjusted_p_value: 0.0,
                passed: false,
            })
            .collect();
        holm(&mut comparisons);
        assert_eq!(
            comparisons
                .iter()
                .map(|c| c.adjusted_p_value)
                .collect::<Vec<_>>(),
            vec![0.03, 0.06, 0.06, 0.008]
        );
    }
    #[test]
    fn every_comparator_and_independent_group_matters() {
        let base = cases();
        let ids = ["a".into(), "b".into()];
        let result = assess(&rule(), &base, &ids).unwrap();
        assert!(result.passed);
        assert_eq!(result.comparisons[0].adjusted_p_value, 4.0 / 256.0);
        let mut tied = base.clone();
        for case in &mut tied {
            case.cells[4].utility = 1.0;
        }
        assert!(!assess(&rule(), &tied, &ids).unwrap().passed);
        let mut related = base.clone();
        for (i, case) in related.iter_mut().enumerate() {
            case.group = format!("group-{}", i / 2);
        }
        let result = assess(&rule(), &related, &ids).unwrap();
        assert!(!result.passed);
        assert_eq!(result.groups, 4);
        let mut low = base.clone();
        for case in &mut low {
            case.cells[0].quality = 0.7;
        }
        assert!(assess(&rule(), &low, &ids)
            .unwrap()
            .reasons
            .contains(&"observed_quality_below_floor".into()));
        let mut missing = base.clone();
        missing[0].cells.pop();
        assert!(assess(&rule(), &missing, &ids).is_err());
        let mut duplicate = base.clone();
        duplicate[0].cells[4].candidate_key = "worker:a".into();
        assert!(assess(&rule(), &duplicate, &ids).is_err());
        let mut invalid = rule();
        invalid.alpha = 0.5;
        assert!(assess(&invalid, &base, &ids).is_err());
        let mut conservative = rule();
        conservative.minimum_group_utility_gain = 0.99;
        assert!(assess(&conservative, &base, &ids).unwrap().passed);
        conservative.minimum_group_utility_gain = 1.0;
        assert!(conservative.validate().is_err());
    }

    /// The policy cells of a per-task selector: it picks worker `a` on the
    /// even cases and `b` on the odd ones, and each worker solves only its own.
    fn selection_cases(count: usize, persona: &str) -> Vec<ReportCase> {
        (0..count)
            .map(|i| {
                let pick = if i % 2 == 0 { "worker:a" } else { "worker:b" };
                let utility = |key: &str| {
                    let solved = match key {
                        "learned" => pick,
                        "aggregate" | "persona" => persona,
                        other => other,
                    };
                    if solved == pick {
                        0.9
                    } else {
                        0.0
                    }
                };
                ReportCase {
                    version_id: format!("case-{i}"),
                    group: format!("group-{i}"),
                    learned_key: pick.into(),
                    aggregate_key: persona.into(),
                    used_fallback: false,
                    cells: ["learned", "aggregate", "persona", "worker:a", "worker:b"]
                        .into_iter()
                        .map(|key| ReportCell {
                            candidate_key: key.into(),
                            run_id: "fixture".into(),
                            quality: utility(key),
                            utility: utility(key),
                            mean_duration_ms: Some(1.0),
                            mean_cost: Some(1.0),
                            repeats: vec![],
                        })
                        .collect(),
                }
            })
            .collect()
    }
    fn selection_rule() -> Rule {
        Rule {
            recipe: SELECTION_RECIPE.into(),
            alpha: 0.05,
            minimum_group_utility_gain: 0.0,
            minimum_observed_quality: 0.8,
            non_inferiority_margin: Some(0.05),
        }
    }
    #[test]
    fn a_per_task_selector_is_tested_for_superiority_over_orders_and_non_inferiority_to_workers() {
        let ids = ["a".into(), "b".into()];
        // The original recipe cannot pass: the selector ties each worker on
        // the cases where it picks that worker.
        let sixteen = selection_cases(16, "worker:a");
        assert!(!assess(&rule(), &sixteen, &ids).unwrap().passed);
        let result = assess(&selection_rule(), &sixteen, &ids).unwrap();
        assert!(result.passed, "{:?}", result.comparisons);
        let persona = result
            .comparisons
            .iter()
            .find(|c| c.baseline == "persona")
            .unwrap();
        assert_eq!(persona.test.as_deref(), Some("superiority"));
        assert_eq!(persona.tied_groups, Some(8));
        assert_eq!(persona.winning_groups, 8);
        assert!((persona.p_value - 1.0 / 256.0).abs() < 1e-15);
        let worker = result
            .comparisons
            .iter()
            .find(|c| c.baseline == "worker:a")
            .unwrap();
        assert_eq!(worker.test.as_deref(), Some("non_inferiority"));
        assert_eq!(worker.winning_groups, 16);
        assert_eq!(worker.tied_groups, None);
        // Eight groups leave only four with a sign against the order: too few.
        let eight = assess(&selection_rule(), &selection_cases(8, "worker:a"), &ids).unwrap();
        assert!(!eight.passed);
        assert!(eight
            .reasons
            .contains(&"not_superior_to_every_registered_baseline".into()));
        // A worker that leads by more than the margin in a group is a loss.
        let mut worse = sixteen.clone();
        for case in worse.iter_mut().take(4) {
            let learned = case
                .cells
                .iter()
                .position(|c| c.candidate_key == "learned")
                .unwrap();
            case.cells[learned].utility -= 0.06;
        }
        let result = assess(&selection_rule(), &worse, &ids).unwrap();
        let worker = result
            .comparisons
            .iter()
            .find(|c| c.baseline == "worker:a")
            .unwrap();
        assert_eq!(worker.winning_groups, 14);
        // Margins are part of the rule and only of the selection recipe.
        let mut missing = selection_rule();
        missing.non_inferiority_margin = None;
        assert!(missing.validate().is_err());
        let mut wide = selection_rule();
        wide.non_inferiority_margin = Some(0.25);
        assert!(wide.validate().is_err());
        let mut original = rule();
        original.non_inferiority_margin = Some(0.05);
        assert!(original.validate().is_err());
        // Original rules keep their serialized form and hashes.
        assert!(serde_json::to_value(rule())
            .unwrap()
            .get("nonInferiorityMargin")
            .is_none());
        let saved = assess(&rule(), &cases(), &ids).unwrap();
        assert!(serde_json::to_value(&saved.comparisons[0])
            .unwrap()
            .get("test")
            .is_none());
    }
}
