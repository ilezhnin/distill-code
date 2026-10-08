//! Preregistered empirical screening. Passing is not qualification or approval.
use super::*;
use crate::services::benchmarks::learned::report::ReportCase;

const RECIPE: &str = "independent-group-sign-holm-v1";

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
}
impl Rule {
    pub(in crate::services::benchmarks) fn validate(&self) -> Result<()> {
        if self.recipe != RECIPE
            || !self.alpha.is_finite()
            || !(0.0..=0.05).contains(&self.alpha)
            || self.alpha == 0.0
            || !self.minimum_group_utility_gain.is_finite()
            || !(0.0..1.0).contains(&self.minimum_group_utility_gain)
            || !self.minimum_observed_quality.is_finite()
            || !(0.0..=1.0).contains(&self.minimum_observed_quality)
        {
            return Err(invalid("Acceptance requires independent-group-sign-holm-v1, alpha in (0,.05], gain in [0,1), and observed quality in [0,1]"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub baseline: String,
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
        let wins = gains
            .iter()
            .filter(|gain| **gain > rule.minimum_group_utility_gain + 1e-12)
            .count();
        comparisons.push(Comparison {
            baseline,
            winning_groups: wins,
            mean_utility_gain: gains.iter().sum::<f64>() / groups as f64,
            p_value: sign_tail(wins, groups),
            adjusted_p_value: 1.0,
            passed: false,
        });
    }
    holm(&mut comparisons);
    for comparison in &mut comparisons {
        comparison.passed = comparison.adjusted_p_value <= rule.alpha
            && comparison.mean_utility_gain > rule.minimum_group_utility_gain + 1e-12;
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
    Ok(Assessment { rule:rule.clone(),groups,observed_quality,comparisons,passed:reasons.is_empty(),reasons,
        limitations:vec!["Sign tests concern the probability of beating each baseline by the declared margin across independent representative groups, not a confidence bound for the mean gain".into(),
            "Ties count as non-wins; repeated runs and related cases never increase the independent sample count".into(),
            "Holm adjustment covers the registered fixed workers, aggregate and persona together; best-fixed and oracle remain hindsight summaries".into(),
            "Passing this empirical screen does not establish semantic independence, verifier validity, deployment equivalence or permission to dispatch".into()] })
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
}
