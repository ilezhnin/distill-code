use super::*;
use std::collections::BTreeMap;

fn coverage(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("insufficient_training_evidence", message)
}

fn canonical_request(mut request: FitRequest) -> Result<FitRequest> {
    if !routing::WORK_CLASSES.contains(&request.work_class_id.as_str())
        || !(MIN_CASES..=MAX_CASES).contains(&request.version_ids.len())
        || !(2..=MAX_CANDIDATES).contains(&request.configurations.len())
        || request.cutoff_at < 0
        || request.cutoff_at > super::super::store::now()
    {
        return Err(invalid("Fit requires a known class, 8 to 256 explicit training versions, 2 to 32 candidates and a past cutoff"));
    }
    let w = request.weights;
    if [w.quality, w.speed, w.cost]
        .iter()
        .any(|v| !v.is_finite() || *v < 0.0)
        || w.quality < 0.5
        || (w.quality + w.speed + w.cost - 1.0).abs() > 1e-9
    {
        return Err(invalid(
            "Fit weights must sum to one, with quality at least 0.5",
        ));
    }
    request.version_ids.sort();
    if request
        .version_ids
        .windows(2)
        .any(|pair| pair[0] == pair[1])
    {
        return Err(invalid("Fit versions must be distinct"));
    }
    for configuration in &mut request.configurations {
        if configuration
            .inventory_revision
            .as_deref()
            .is_none_or(|r| r.trim().is_empty())
        {
            return Err(invalid(
                "Every fitted candidate requires a known runtime revision",
            ));
        }
        configuration.id = routing::candidate_key(configuration);
        configuration.account_id = None;
    }
    request.configurations.sort_by(|a, b| a.id.cmp(&b.id));
    if request
        .configurations
        .windows(2)
        .any(|pair| pair[0].id == pair[1].id)
    {
        return Err(invalid("Fit candidates must have distinct identities"));
    }
    Ok(request)
}

/// Never consult held-out rewards, even to discover the candidate inventory.
pub fn fit(data: &QueryData, request: FitRequest) -> Result<FitArtifact> {
    let request = canonical_request(request)?;
    let ledger = super::super::export::ledger_rows_at(
        data,
        false,
        "learned-selector-v1",
        request.cutoff_at,
    )?;
    let rows: BTreeMap<_, _> = ledger
        .iter()
        .filter_map(|r| r["taskVersion"].as_str().map(|id| (id, r)))
        .collect();
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    let mut examples = Vec::new();
    let mut common_cases = 0;
    let mut common_groups = BTreeSet::new();
    let mut scopes = BTreeSet::new();
    for id in &request.version_ids {
        let row = rows.get(id.as_str()).ok_or_else(|| {
            coverage(format!(
                "Version {id} is not in the training pool at the cutoff"
            ))
        })?;
        let version = versions[id.as_str()];
        if version.manifest.work_class_id != request.work_class_id {
            return Err(invalid(format!(
                "Version {id} belongs to another work class"
            )));
        }
        // Root workflows are evaluated separately; fit executor tasks with their
        // visible entry state, not a collapsed multi-step root's outcome.
        if version.manifest.workflow.is_some() {
            return Err(invalid(
                "Fit individual executor tasks, not multi-step workflow roots",
            ));
        }
        let task = PublicTask::from(&version.manifest);
        features::extract(&task)?;
        scopes.insert(features::scope_hash(&task)?);
        let matrix = row["matrix"]
            .as_array()
            .ok_or_else(|| invalid("Training matrix is absent"))?;
        let mut targets = Vec::new();
        for configuration in &request.configurations {
            if configuration.execution_profile != task.execution_profile {
                return Err(invalid(
                    "Candidates must use the training task's execution profile",
                ));
            }
            let cell = matrix
                .iter()
                .find(|cell| cell["configuration"]["candidateKey"] == configuration.id)
                .ok_or_else(|| {
                    coverage(format!(
                        "Candidate {} has no eligible training column",
                        configuration.model_id
                    ))
                })?;
            if cell["configuration"]["inventoryRevision"].as_str()
                != configuration.inventory_revision.as_deref()
            {
                return Err(coverage(format!(
                    "Candidate {} has a different runtime at the cutoff",
                    configuration.model_id
                )));
            }
            let status = cell["observationStatus"].as_str().unwrap_or("unknown");
            if !matches!(status, "observed" | "not_planned" | "authored_by_candidate") {
                return Err(coverage(format!(
                    "Version {id}, candidate {}: {status}",
                    configuration.model_id
                )));
            }
            let observed = status == "observed";
            let reward = observed.then(|| cell["reward"].as_f64()).flatten();
            if observed && reward.is_none_or(|r| !r.is_finite() || !(0.0..=1.0).contains(&r)) {
                return Err(invalid(
                    "An observed training reward must be between zero and one",
                ));
            }
            let mean_duration_ms = if observed {
                cell["outcomes"].as_array().and_then(|outcomes| {
                    let durations: Option<Vec<f64>> = outcomes
                        .iter()
                        .map(|o| {
                            o["durationMs"]
                                .as_f64()
                                .filter(|v| v.is_finite() && *v >= 0.0)
                        })
                        .collect();
                    durations
                        .filter(|v| !v.is_empty())
                        .map(|v| v.iter().sum::<f64>() / v.len() as f64)
                })
            } else {
                None
            };
            targets.push(TrainingTarget {
                candidate_key: configuration.id.clone(),
                status: status.into(),
                reward,
                utility: None,
                mean_duration_ms,
                mean_cost: observed
                    .then(|| cell["meanCost"].as_f64())
                    .flatten()
                    .filter(|v| v.is_finite() && *v >= 0.0),
                evidence: cell.clone(),
            });
        }
        // Sparse authored/not-planned cells are masked, never converted to zero.
        let observed = targets.iter().filter(|t| t.reward.is_some()).count();
        if observed < 2 {
            return Err(coverage(format!(
                "Version {id} needs at least two observed, non-author candidates"
            )));
        }
        let split_group = row["splitGroup"]
            .as_str()
            .unwrap_or(&version.manifest.task_family)
            .to_owned();
        if observed == request.configurations.len() {
            common_cases += 1;
            common_groups.insert(split_group.clone());
        }
        utilities(&mut targets, request.weights);
        examples.push(TrainingExample {
            version_id: id.clone(),
            content_hash: version.content_hash.clone(),
            family: version.manifest.task_family.clone(),
            split_group,
            evaluator_revision: version.manifest.evaluator.revision.clone(),
            task,
            targets,
        });
    }
    if common_cases < MIN_CASES || common_groups.len() < 2 {
        return Err(coverage(format!("Need at least 8 common training cases in 2 independent groups; found {common_cases} cases in {} groups", common_groups.len())));
    }
    if scopes.len() != 1 {
        return Err(invalid(
            "Fit one role, permission and execution context at a time",
        ));
    }
    let snapshot = TrainingSnapshot { request, examples };
    let mut model = refit(&snapshot, common_cases)?;
    model.id = model_hash(&model)?;
    validate_model(&model)?;
    Ok(FitArtifact {
        created_at: super::super::store::now(),
        model,
        snapshot,
    })
}

/// Unknown resources remove that objective for the entire comparison. A cheap
/// or fast failed answer cannot earn resource credit independent of quality.
pub(super) fn utilities(targets: &mut [TrainingTarget], weights: RoleWeights) {
    let successful: Vec<_> = targets
        .iter()
        .filter(|t| t.reward.is_some_and(|r| r > 0.0))
        .collect();
    let reference = |measure: fn(&TrainingTarget) -> Option<f64>| -> Option<f64> {
        let values: Option<Vec<f64>> = successful.iter().map(|t| measure(t)).collect();
        values.and_then(|v| v.into_iter().min_by(f64::total_cmp))
    };
    let fastest = reference(|t| t.mean_duration_ms);
    let cheapest = reference(|t| t.mean_cost);
    let speed_weight = if fastest.is_some() {
        weights.speed
    } else {
        0.0
    };
    let cost_weight = if cheapest.is_some() {
        weights.cost
    } else {
        0.0
    };
    let total = weights.quality + speed_weight + cost_weight;
    let share = |reference: Option<f64>, own: Option<f64>| match (reference, own) {
        (Some(best), Some(own)) if own > 0.0 => (best / own).min(1.0),
        (Some(_), Some(_)) => 1.0,
        _ => 0.0,
    };
    for target in targets {
        target.utility = target.reward.map(|q| {
            q * (weights.quality
                + speed_weight * share(fastest, target.mean_duration_ms)
                + cost_weight * share(cheapest, target.mean_cost))
                / total
        });
    }
}

/// Deterministic full-batch gradient descent; the recipe fixes every parameter.
/// A declared related group has equal total weight, regardless of case count.
fn regress(samples: &[(Vec<f64>, f64, f64)]) -> Vec<f64> {
    let mut coefficients = vec![0.0; DIMENSIONS];
    let weight: f64 = samples.iter().map(|(_, _, w)| w).sum();
    coefficients[0] = samples.iter().map(|(_, y, w)| y * w).sum::<f64>() / weight;
    for _ in 0..ITERATIONS {
        let mut gradient = vec![0.0; DIMENSIONS];
        for (x, y, w) in samples {
            let error = features::dot(x, &coefficients) - y;
            for (g, x) in gradient.iter_mut().zip(x) {
                *g += w * error * x / weight;
            }
        }
        for (index, (coefficient, gradient)) in coefficients.iter_mut().zip(gradient).enumerate() {
            let penalty = if index == 0 {
                0.0
            } else {
                REGULARIZATION * *coefficient
            };
            *coefficient -= LEARNING_RATE * (gradient + penalty);
        }
    }
    coefficients
}

pub(super) fn refit(snapshot: &TrainingSnapshot, common_cases: usize) -> Result<LearnedModel> {
    let examples = &snapshot.examples;
    let vectors: Vec<_> = examples
        .iter()
        .map(|e| features::extract(&e.task))
        .collect::<Result<_>>()?;
    let mut candidates = Vec::new();
    for configuration in &snapshot.request.configurations {
        let mut groups = BTreeMap::new();
        for e in examples {
            if e.targets
                .iter()
                .any(|t| t.candidate_key == configuration.id && t.reward.is_some())
            {
                *groups.entry(&e.split_group).or_insert(0usize) += 1;
            }
        }
        let samples = |utility: bool| {
            examples
                .iter()
                .zip(&vectors)
                .filter_map(|(e, x)| {
                    let target = e
                        .targets
                        .iter()
                        .find(|t| t.candidate_key == configuration.id)?;
                    let y = if utility {
                        target.utility
                    } else {
                        target.reward
                    }?;
                    Some((x.clone(), y, 1.0 / groups[&e.split_group] as f64))
                })
                .collect::<Vec<_>>()
        };
        let quality = samples(false);
        candidates.push(CandidateModel {
            candidate_key: configuration.id.clone(),
            configuration: configuration.clone(),
            cases: quality.len(),
            quality_coefficients: regress(&quality),
            utility_coefficients: regress(&samples(true)),
        });
    }
    let unique = |values: Vec<String>| {
        values
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    };
    Ok(LearnedModel {
        id: String::new(),
        recipe: RECIPE.into(),
        feature_version: FEATURE_VERSION.into(),
        candidate_key_algorithm: routing::CANDIDATE_KEY_ALGORITHM.into(),
        work_class_id: snapshot.request.work_class_id.clone(),
        cutoff_at: snapshot.request.cutoff_at,
        weights: snapshot.request.weights,
        snapshot_hash: hash(snapshot)?,
        training_cases: examples.len(),
        common_cases,
        training_families: unique(examples.iter().map(|e| e.family.clone()).collect()),
        training_groups: unique(examples.iter().map(|e| e.split_group.clone()).collect()),
        scope_hashes: unique(
            examples
                .iter()
                .map(|e| features::scope_hash(&e.task))
                .collect::<Result<_>>()?,
        ),
        candidates,
    })
}
