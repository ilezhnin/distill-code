//! Stage 4 of the staged plan: choosing a configuration for a class of work
//! from the measured evidence, and the held-out harness that decides whether
//! that choice may be trusted over the personas' fixed lists.
//!
//! A selection reads the routing evidence of the class (train cases by
//! default, never held-out ones), compares the candidates on the cases they
//! all measured, and weighs reliability, speed and cost as the role asks.
//! Short of the coverage threshold it takes the persona's prior instead, and
//! says so. The harness replays the selector on every held-out case of a
//! class against each single configuration, the best of them, the per-case
//! oracle and the persona; the selector gain is the selector's mean reward
//! over the best fixed configuration's. Until it is above zero the selector
//! is not the deciding factor anywhere.

use super::{
    analysis,
    routing::{self, candidate_key},
    store::{now, Store},
    types::*,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Cases every compared candidate must have measured in a class before its
/// evidence decides; short of it the persona's prior does.
pub const COVERAGE_THRESHOLD: u32 = 8;
/// How long evidence stays current for a selection.
const MAX_EVIDENCE_AGE_MS: u64 = 365 * 24 * 3600 * 1000;
/// The role context every pool case is written in.
const CLEAN_CONTEXT: &str = "clean-v1";

/// What a role weighs, as the class boards do by default: reliability first,
/// then speed, then cost.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleWeights {
    pub quality: f64,
    pub speed: f64,
    pub cost: f64,
}

impl Default for RoleWeights {
    fn default() -> Self {
        Self {
            quality: 0.8,
            speed: 0.15,
            cost: 0.05,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionQuery {
    pub work_class_id: String,
    #[serde(default)]
    pub facets: TaskFacets,
    /// The configurations the caller can run now.
    pub candidates: Vec<RoutingCandidate>,
    #[serde(default)]
    pub weights: Option<RoleWeights>,
    /// The persona's ranking, best first: the choice while evidence is short.
    #[serde(default)]
    pub prior: Vec<Configuration>,
    #[serde(default)]
    pub min_cases: Option<u32>,
    #[serde(default)]
    pub cutoff_at: Option<i64>,
    /// Evidence splits; train alone by default, and never held-out.
    #[serde(default)]
    pub permitted_splits: Option<Vec<String>>,
}

/// One candidate's standing in a selection, on the shared cases.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateStanding {
    pub candidate_key: String,
    pub configuration: Configuration,
    pub status: String,
    pub reason: String,
    /// Mean case reward: 1 for a case passed every repetition, a judged
    /// case its mean.
    pub quality: Option<f64>,
    pub speed_share: Option<f64>,
    pub cost_share: Option<f64>,
    pub score: Option<f64>,
}

/// A selection and why: its decision snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub id: String,
    pub created_at: i64,
    pub work_class_id: String,
    pub facets: TaskFacets,
    pub chosen: Option<Configuration>,
    pub chosen_key: Option<String>,
    /// `evidence`, `prior`, or `none` when neither names an available candidate.
    pub source: String,
    pub reason: String,
    pub shared_cases: u32,
    pub min_cases: u32,
    pub weights: RoleWeights,
    pub standings: Vec<CandidateStanding>,
}

/// A case's reward from its scored repetitions, as the boards count it: 1
/// only when every objective repetition passed, a judged case its mean.
fn case_reward(scores: &[f64]) -> f64 {
    if scores.iter().all(|s| *s == 0.0 || *s == 1.0) {
        f64::from(u8::from(scores.iter().all(|s| *s == 1.0)))
    } else {
        scores.iter().sum::<f64>() / scores.len() as f64
    }
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    Some(values[values.len() / 2])
}

/// A candidate's measurement of one case: its reward, median duration and
/// mean cost (unknown when a repetition's is).
struct CaseMeasure {
    reward: f64,
    duration: Option<f64>,
    cost: Option<f64>,
}

fn measures(
    data: &QueryData,
    attempt_ids: &[String],
    cutoff: i64,
) -> BTreeMap<String, CaseMeasure> {
    let by_id: BTreeMap<&str, &Attempt> =
        data.attempts.iter().map(|a| (a.id.as_str(), a)).collect();
    let mut cases: BTreeMap<String, Vec<&Attempt>> = BTreeMap::new();
    for id in attempt_ids {
        if let Some(attempt) = by_id.get(id.as_str()) {
            cases
                .entry(attempt.version_id.clone())
                .or_default()
                .push(attempt);
        }
    }
    cases
        .into_iter()
        .filter_map(|(version, list)| {
            let scores: Vec<f64> = list
                .iter()
                .filter_map(|a| analysis::score_as_of(a, Some(cutoff)))
                .collect();
            if scores.is_empty() {
                return None;
            }
            let costs: Option<Vec<f64>> = list.iter().map(|a| a.usage.cost).collect();
            Some((
                version,
                CaseMeasure {
                    reward: case_reward(&scores),
                    duration: median(
                        list.iter()
                            .filter_map(|a| a.duration_ms.map(|d| d as f64))
                            .collect(),
                    ),
                    cost: costs.map(|c| c.iter().sum::<f64>() / c.len() as f64),
                },
            ))
        })
        .collect()
}

/// The best on record over `own`, 0 to 1, for a solved case only.
fn share(record: Option<f64>, own: Option<f64>) -> Option<f64> {
    match (record, own) {
        (Some(record), Some(own)) if own > 0.0 => Some((record / own).min(1.0)),
        (Some(_), Some(_)) => Some(1.0),
        _ => None,
    }
}

pub fn select(data: &QueryData, query: &SelectionQuery) -> Result<Selection> {
    let splits = query
        .permitted_splits
        .clone()
        .unwrap_or_else(|| vec!["train".into()]);
    if splits.iter().any(|split| split == "held_out") {
        return Err(BenchmarkError::new(
            "validation",
            "A selection never reads held-out evidence",
        ));
    }
    let weights = query.weights.unwrap_or_default();
    if [weights.quality, weights.speed, weights.cost]
        .iter()
        .any(|w| !w.is_finite() || *w < 0.0)
        || weights.quality <= 0.0
    {
        return Err(BenchmarkError::new(
            "validation",
            "Role weights are non-negative and weigh quality",
        ));
    }
    let min_cases = query.min_cases.unwrap_or(COVERAGE_THRESHOLD).max(1);
    let cutoff = query.cutoff_at.unwrap_or_else(now);
    let evidence = routing::get_evidence(
        data,
        &RoutingEvidenceQuery {
            schema_version: 1,
            mode: "class".into(),
            purpose: "analysis".into(),
            target_version_id: None,
            target_family: String::new(),
            work_class_id: query.work_class_id.clone(),
            facets: query.facets.clone(),
            role_context_hash: CLEAN_CONTEXT.into(),
            entry_state_hash: None,
            candidates: query.candidates.clone(),
            cutoff_at: cutoff,
            permitted_splits: splits,
            objective: RoutingObjective {
                kind: "quality".into(),
                min_quality: 0.0,
            },
            constraints: RoutingConstraints::default(),
            max_age_ms: MAX_EVIDENCE_AGE_MS,
            timeout_seconds: None,
        },
    )?;
    // Candidates with measured evidence that may be chosen.
    let usable: Vec<(&RoutingEvidenceRow, BTreeMap<String, CaseMeasure>)> = evidence
        .candidates
        .iter()
        .filter(|row| row.available && !matches!(row.status.as_str(), "unavailable" | "excluded"))
        .map(|row| (row, measures(data, &row.attempt_ids, cutoff)))
        .filter(|(_, cases)| !cases.is_empty())
        .collect();
    let shared: BTreeSet<&str> = match usable.split_first() {
        None => BTreeSet::new(),
        Some(((_, first), rest)) => first
            .keys()
            .map(String::as_str)
            .filter(|case| rest.iter().all(|(_, cases)| cases.contains_key(*case)))
            .collect(),
    };
    let record = |pick: &dyn Fn(&CaseMeasure) -> Option<f64>, case: &str| {
        usable
            .iter()
            .filter_map(|(_, cases)| cases.get(case).filter(|m| m.reward >= 0.5).and_then(pick))
            .min_by(f64::total_cmp)
    };
    let mut standings: Vec<CandidateStanding> = evidence
        .candidates
        .iter()
        .map(|row| {
            let measured = usable
                .iter()
                .find(|(usable, _)| usable.candidate_key == row.candidate_key)
                .map(|(_, cases)| cases);
            let on_shared: Vec<(&str, &CaseMeasure)> = measured
                .map(|cases| {
                    shared
                        .iter()
                        .filter_map(|case| cases.get(*case).map(|m| (*case, m)))
                        .collect()
                })
                .unwrap_or_default();
            let quality = (!on_shared.is_empty()).then(|| {
                on_shared.iter().map(|(_, m)| m.reward).sum::<f64>() / on_shared.len() as f64
            });
            let mean_share = |pick: &dyn Fn(&CaseMeasure) -> Option<f64>| {
                let shares: Vec<f64> = on_shared
                    .iter()
                    .filter(|(_, m)| m.reward >= 0.5)
                    .filter_map(|(case, m)| share(record(pick, case), pick(m)))
                    .collect();
                (!shares.is_empty()).then(|| shares.iter().sum::<f64>() / shares.len() as f64)
            };
            let speed_share = mean_share(&|m| m.duration);
            let cost_share = mean_share(&|m| m.cost);
            let score = quality.map(|q| {
                let mut total = weights.quality * q;
                let mut weight = weights.quality;
                if let Some(s) = speed_share {
                    total += weights.speed * s;
                    weight += weights.speed;
                }
                if let Some(c) = cost_share {
                    total += weights.cost * c;
                    weight += weights.cost;
                }
                total / weight
            });
            CandidateStanding {
                candidate_key: row.candidate_key.clone(),
                configuration: row.configuration.clone(),
                status: row.status.clone(),
                reason: row.reason.clone(),
                quality,
                speed_share,
                cost_share,
                score,
            }
        })
        .collect();
    let prior: Vec<String> = query.prior.iter().map(candidate_key).collect();
    let prior_rank = |key: &str| prior.iter().position(|p| p == key).unwrap_or(usize::MAX);
    let available: BTreeSet<String> = query
        .candidates
        .iter()
        .filter(|c| c.available)
        .map(|c| candidate_key(&c.configuration))
        .collect();
    let by_evidence = (usable.len() >= 2 && shared.len() as u32 >= min_cases)
        .then(|| {
            standings
                .iter()
                .filter(|s| s.score.is_some() && available.contains(&s.candidate_key))
                .max_by(|a, b| {
                    a.score
                        .partial_cmp(&b.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(
                            a.quality
                                .partial_cmp(&b.quality)
                                .unwrap_or(std::cmp::Ordering::Equal),
                        )
                        .then(prior_rank(&b.candidate_key).cmp(&prior_rank(&a.candidate_key)))
                        .then(b.candidate_key.cmp(&a.candidate_key))
                })
        })
        .flatten();
    let (chosen_key, source, reason) = match by_evidence {
        Some(best) => (
            Some(best.candidate_key.clone()),
            "evidence",
            format!(
                "Best weighted score on the {} cases of the class every candidate measured",
                shared.len()
            ),
        ),
        None => {
            let short = format!(
                "The class has {} cases every candidate measured, short of {}",
                shared.len(),
                min_cases
            );
            match prior.iter().find(|key| available.contains(*key)) {
                Some(key) => (
                    Some(key.clone()),
                    "prior",
                    format!("{short}; the persona's ranking decides"),
                ),
                None => (
                    None,
                    "none",
                    format!("{short}, and no ranked candidate is available"),
                ),
            }
        }
    };
    standings.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(prior_rank(&a.candidate_key).cmp(&prior_rank(&b.candidate_key)))
    });
    let chosen = chosen_key.as_ref().and_then(|key| {
        query
            .candidates
            .iter()
            .find(|c| &candidate_key(&c.configuration) == key)
            .map(|c| c.configuration.clone())
    });
    Ok(Selection {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: now(),
        work_class_id: query.work_class_id.clone(),
        facets: query.facets.clone(),
        chosen,
        chosen_key,
        source: source.into(),
        reason,
        shared_cases: shared.len() as u32,
        min_cases,
        weights,
        standings,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessQuery {
    pub work_class_id: String,
    pub candidates: Vec<RoutingCandidate>,
    #[serde(default)]
    pub weights: Option<RoleWeights>,
    #[serde(default)]
    pub prior: Vec<Configuration>,
    #[serde(default)]
    pub min_cases: Option<u32>,
}

/// One policy's mean reward over the harness's cases.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyResult {
    /// `fixed`, `best_fixed`, `oracle`, `persona` or `selector`.
    pub policy: String,
    pub candidate_key: Option<String>,
    pub mean_reward: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessReport {
    pub work_class_id: String,
    /// Held-out cases every candidate has a complete cell on.
    pub cases: u32,
    pub policies: Vec<PolicyResult>,
    /// The selector's mean reward over the best fixed configuration's.
    pub selector_gain: Option<f64>,
    pub reason: String,
}

/// Replays the selector on the class's held-out cases against the fixed
/// policies (see the module).
pub fn harness(data: &QueryData, query: &HarnessQuery) -> Result<HarnessReport> {
    let pool = analysis::pool(data, &ResultQuery::default());
    let runs: BTreeMap<&str, &BenchmarkRun> = data
        .runs
        .iter()
        .filter(|run| !run.request.preview)
        .map(|run| (run.id.as_str(), run))
        .collect();
    let keys: Vec<String> = query
        .candidates
        .iter()
        .map(|c| candidate_key(&c.configuration))
        .collect();
    // Each held-out case of the class with a complete cell for every candidate.
    let mut rewards: Vec<(&BenchmarkVersion, Vec<f64>)> = Vec::new();
    for version in pool.iter().filter(|v| {
        v.manifest.split == "held_out" && v.manifest.work_class_id == query.work_class_id
    }) {
        let required = analysis::required_repetitions(data, version) as usize;
        let mut row = Vec::new();
        for key in &keys {
            let attempts: Vec<&Attempt> = data
                .attempts
                .iter()
                .filter(|a| {
                    a.version_id == version.id
                        && &candidate_key(&analysis::execution_configuration(a)) == key
                })
                .collect();
            let cell = analysis::latest_cell_attempts(&attempts, &runs, None);
            let scores: Vec<f64> = cell
                .iter()
                .filter_map(|a| analysis::score_as_of(a, None))
                .collect();
            if scores.len() < required {
                break;
            }
            row.push(case_reward(&scores));
        }
        if row.len() == keys.len() {
            rewards.push((version, row));
        }
    }
    let cases = rewards.len();
    if cases == 0 || keys.is_empty() {
        return Ok(HarnessReport {
            work_class_id: query.work_class_id.clone(),
            cases: 0,
            policies: Vec::new(),
            selector_gain: None,
            reason: "No held-out case of the class has a complete cell for every candidate".into(),
        });
    }
    let mean = |pick: &dyn Fn(&[f64]) -> f64| {
        rewards.iter().map(|(_, row)| pick(row)).sum::<f64>() / cases as f64
    };
    let mut policies: Vec<PolicyResult> = keys
        .iter()
        .enumerate()
        .map(|(index, key)| PolicyResult {
            policy: "fixed".into(),
            candidate_key: Some(key.clone()),
            mean_reward: mean(&|row| row[index]),
        })
        .collect();
    let best_fixed = policies
        .iter()
        .max_by(|a, b| a.mean_reward.total_cmp(&b.mean_reward))
        .cloned()
        .expect("at least one candidate");
    policies.push(PolicyResult {
        policy: "best_fixed".into(),
        ..best_fixed.clone()
    });
    policies.push(PolicyResult {
        policy: "oracle".into(),
        candidate_key: None,
        mean_reward: mean(&|row| row.iter().copied().fold(0.0, f64::max)),
    });
    if let Some(index) = query
        .prior
        .iter()
        .find_map(|prior| keys.iter().position(|k| *k == candidate_key(prior)))
    {
        policies.push(PolicyResult {
            policy: "persona".into(),
            candidate_key: Some(keys[index].clone()),
            mean_reward: mean(&|row| row[index]),
        });
    }
    // The selector chooses per case, from train evidence and the case's facets.
    let mut selected = 0.0;
    for (version, row) in &rewards {
        let selection = select(
            data,
            &SelectionQuery {
                work_class_id: query.work_class_id.clone(),
                facets: version.manifest.facets.clone(),
                candidates: query.candidates.clone(),
                weights: query.weights,
                prior: query.prior.clone(),
                min_cases: query.min_cases,
                cutoff_at: None,
                permitted_splits: None,
            },
        )?;
        selected += selection
            .chosen_key
            .and_then(|key| keys.iter().position(|k| *k == key))
            .map_or(0.0, |index| row[index]);
    }
    let selector = selected / cases as f64;
    policies.push(PolicyResult {
        policy: "selector".into(),
        candidate_key: None,
        mean_reward: selector,
    });
    Ok(HarnessReport {
        work_class_id: query.work_class_id.clone(),
        cases: cases as u32,
        policies,
        selector_gain: Some(selector - best_fixed.mean_reward),
        reason: format!("{cases} held-out cases with a complete cell for every candidate"),
    })
}

impl Store {
    /// Keeps a selection as its decision snapshot.
    pub async fn save_selection(&self, selection: &Selection) -> Result<()> {
        sqlx::query(
            "INSERT INTO selector_decisions(id,created_at,work_class_id,data_json) VALUES(?,?,?,?)",
        )
        .bind(&selection.id)
        .bind(selection.created_at)
        .bind(&selection.work_class_id)
        .bind(serde_json::to_string(selection)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration(model: &str) -> Configuration {
        Configuration {
            id: model.into(),
            provider_id: "claude".into(),
            account_id: Some("account".into()),
            model_id: model.into(),
            effort: Some("high".into()),
            fast_mode: Some(false),
            billing_mode: "subscription".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("runtime".into()),
            model_name: None,
        }
    }

    /// Ten train and four held-out debug cases. `strong` solves every train
    /// case and the easy held-out ones, `fast` solves half the train cases
    /// in a fifth of the time and the hard held-out ones.
    fn data() -> QueryData {
        let mut data = super::super::analysis::tests::dataset();
        data.attempts.clear();
        data.runs.truncate(1);
        data.runs[0].request.configurations = vec![configuration("strong"), configuration("fast")];
        data.runs[0].request.timeout_seconds = 3_600;
        let finished = now() - 60_000;
        data.versions.clear();
        for index in 0..14 {
            let mut manifest = super::super::runner::seed_definitions().remove(0);
            manifest.work_class_id = "debug".into();
            manifest.task_family = format!("family-{index}");
            manifest.split = if index < 10 { "train" } else { "held_out" }.into();
            manifest.facets.difficulty = Some(if index % 2 == 0 { "easy" } else { "hard" }.into());
            data.versions.push(BenchmarkVersion {
                id: format!("case-{index}"),
                definition_id: format!("definition-{index}"),
                content_hash: format!("hash-{index}"),
                published_at: 1,
                manifest,
                carries_from: None,
            });
        }
        data.runs[0].request.version_ids = data.versions.iter().map(|v| v.id.clone()).collect();
        for version in data.versions.clone() {
            let index: usize = version.id.trim_start_matches("case-").parse().unwrap();
            let hard = index % 2 == 1;
            for model in ["strong", "fast"] {
                let pass = match (model, index < 10, hard) {
                    ("strong", true, _) => true,
                    ("fast", true, _) => !hard,
                    ("strong", false, _) => !hard,
                    ("fast", false, _) => hard,
                    _ => false,
                };
                let config = configuration(model);
                data.attempts.push(Attempt {
                    id: format!("{model}-{}", version.id),
                    run_id: data.runs[0].id.clone(),
                    version_id: version.id.clone(),
                    configuration: config.clone(),
                    repetition: 0,
                    phase: "terminal".into(),
                    outcome: Some(if pass { "pass" } else { "fail" }.into()),
                    reason: None,
                    wait_until: None,
                    session_id: None,
                    host_run_id: None,
                    observed: Some(config),
                    started_at: Some(finished - 1_000),
                    finished_at: Some(finished),
                    duration_ms: Some(if model == "fast" { 200 } else { 1_000 }),
                    output: Some("output".into()),
                    evidence_hash: Some("sealed".into()),
                    usage: TokenUsage {
                        cost: Some(0.01),
                        ..TokenUsage::default()
                    },
                    evaluations: vec![],
                    event_cursor: 1,
                    workflow_steps: Vec::new(),
                    resolved_model: None,
                });
            }
        }
        data
    }

    fn candidates() -> Vec<RoutingCandidate> {
        ["strong", "fast"]
            .map(|model| RoutingCandidate {
                configuration: configuration(model),
                available: true,
                reason: None,
            })
            .to_vec()
    }

    fn query(prior: &[&str]) -> SelectionQuery {
        SelectionQuery {
            work_class_id: "debug".into(),
            facets: TaskFacets::default(),
            candidates: candidates(),
            weights: None,
            prior: prior.iter().map(|model| configuration(model)).collect(),
            min_cases: None,
            cutoff_at: None,
            permitted_splits: None,
        }
    }

    #[test]
    fn evidence_decides_once_the_class_is_covered_and_the_prior_until_then() {
        let data = data();
        let chosen = select(&data, &query(&["fast"])).unwrap();
        assert_eq!(chosen.source, "evidence");
        assert_eq!(chosen.shared_cases, 10);
        assert_eq!(
            chosen.chosen_key,
            Some(candidate_key(&configuration("strong")))
        );
        // Fast's speed cannot buy back the cases it fails.
        let fast = chosen
            .standings
            .iter()
            .find(|s| s.configuration.model_id == "fast")
            .unwrap();
        assert_eq!(fast.quality, Some(0.5));
        assert_eq!(fast.speed_share, Some(1.0));
        // Short of the threshold the persona's ranking decides.
        let mut short = query(&["fast"]);
        short.min_cases = Some(11);
        let chosen = select(&data, &short).unwrap();
        assert_eq!(chosen.source, "prior");
        assert_eq!(
            chosen.chosen_key,
            Some(candidate_key(&configuration("fast")))
        );
        assert!(chosen.reason.contains("short of 11"), "{}", chosen.reason);
        // Held-out evidence is never read.
        let mut leaking = query(&[]);
        leaking.permitted_splits = Some(vec!["held_out".into()]);
        assert!(select(&data, &leaking).is_err());
    }

    #[test]
    fn the_harness_measures_the_selector_against_fixed_policies() {
        let data = data();
        let report = harness(
            &data,
            &HarnessQuery {
                work_class_id: "debug".into(),
                candidates: candidates(),
                weights: None,
                prior: vec![configuration("fast")],
                min_cases: Some(4),
            },
        )
        .unwrap();
        assert_eq!(report.cases, 4);
        let of = |policy: &str| {
            report
                .policies
                .iter()
                .find(|p| p.policy == policy)
                .unwrap()
                .mean_reward
        };
        assert_eq!(of("best_fixed"), 0.5);
        assert_eq!(of("oracle"), 1.0);
        assert_eq!(of("persona"), 0.5);
        // Train evidence by difficulty points at fast for easy cases and strong
        // for hard ones; on held-out each fails there, so the selector loses
        // to the best fixed configuration and may not decide.
        assert_eq!(of("selector"), 0.0);
        assert_eq!(report.selector_gain, Some(-0.5));
    }
}
