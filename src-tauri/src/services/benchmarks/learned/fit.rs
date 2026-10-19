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
    // The exact rule is the default; naming it must not change the hash.
    if request.runtime_match == Some(super::super::export::RuntimeMatch::Exact) {
        request.runtime_match = None;
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
    let ledger = super::super::export::ledger_rows_matching(
        data,
        false,
        LEDGER_SALT,
        request.cutoff_at,
        request
            .runtime_match
            .unwrap_or(super::super::export::RuntimeMatch::Exact),
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
        // A fit reads the train split only: held-out cases are the permanent
        // evaluation set and never shape a model.
        if version.manifest.split != "train" {
            return Err(invalid(format!(
                "Version {id} is not a training case; a fit never reads held-out cases"
            )));
        }
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
            // A candidate this case never measured, or measured incompletely,
            // is absent here: masked, never a zero.
            let Some(cell) = matrix
                .iter()
                .find(|cell| cell["configuration"]["candidateKey"] == configuration.id)
            else {
                targets.push(absent(&configuration.id));
                continue;
            };
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
                targets.push(absent(&configuration.id));
                continue;
            }
            let observed = status == "observed";
            if observed && version.manifest.environment.get("judgePanel").is_some() {
                let outcomes = cell["outcomes"]
                    .as_array()
                    .filter(|rows| !rows.is_empty())
                    .ok_or_else(|| coverage("Frozen rubric outcomes are absent"))?;
                for outcome in outcomes {
                    let attempt = data
                        .attempts
                        .iter()
                        .find(|attempt| {
                            Some(attempt.id.as_str()) == outcome["attemptId"].as_str()
                                && attempt.version_id == version.id
                        })
                        .ok_or_else(|| coverage("Frozen rubric attempt is absent"))?;
                    super::super::judge_panel::validate_evidence(
                        &version.manifest,
                        attempt,
                        request.cutoff_at,
                    )?;
                }
            }
            let reward = observed.then(|| cell["reward"].as_f64()).flatten();
            if observed && reward.is_none_or(|r| !r.is_finite() || !(0.0..=1.0).contains(&r)) {
                return Err(invalid(
                    "An observed training reward must be between zero and one",
                ));
            }
            targets.push(TrainingTarget {
                candidate_key: configuration.id.clone(),
                status: status.into(),
                reward,
                utility: None,
                mean_duration_ms: observed.then(|| mean_duration(cell)).flatten(),
                mean_cost: observed.then(|| mean_cost(cell)).flatten(),
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
    let _ = common_groups;
    let groups: BTreeSet<_> = examples.iter().map(|e| &e.split_group).collect();
    if groups.len() < 2 {
        return Err(coverage(
            "Training cases must come from at least two independent groups",
        ));
    }
    // Candidates need not share cases; each needs enough of its own.
    for configuration in &request.configurations {
        let measured = examples
            .iter()
            .filter(|e| {
                e.targets
                    .iter()
                    .any(|t| t.candidate_key == configuration.id && t.reward.is_some())
            })
            .count();
        if measured < MIN_CANDIDATE_CASES {
            return Err(coverage(format!(
                "Candidate {} has {measured} measured training cases; the pool needs {MIN_CANDIDATE_CASES}",
                configuration.model_id
            )));
        }
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

/// A candidate a training case did not measure completely: masked.
fn absent(candidate_key: &str) -> TrainingTarget {
    TrainingTarget {
        candidate_key: candidate_key.to_owned(),
        status: "absent".into(),
        reward: None,
        utility: None,
        mean_duration_ms: None,
        mean_cost: None,
        evidence: serde_json::Value::Null,
    }
}

/// A ledger cell's mean repetition duration, unknown if any repetition lacks one.
pub(super) fn mean_duration(cell: &serde_json::Value) -> Option<f64> {
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
}

/// A ledger cell's mean reported cost, when every repetition reported one.
pub(super) fn mean_cost(cell: &serde_json::Value) -> Option<f64> {
    cell["meanCost"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
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

/// Soft targets use softmax(measured utility / temperature); the selection
/// head minimizes KL(target || policy). Utility includes the configured
/// quality, speed and cost objectives over public hashed task features.
pub(super) fn selection_distribution(
    targets: &[TrainingTarget],
    configurations: &[Configuration],
) -> Result<Vec<(usize, f64)>> {
    let mut observed = Vec::new();
    for (index, configuration) in configurations.iter().enumerate() {
        let Some(target) = targets
            .iter()
            .find(|target| target.candidate_key == configuration.id && target.status == "observed")
        else {
            continue;
        };
        let utility = target
            .utility
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
            .ok_or_else(|| invalid("An observed selection target needs a finite utility"))?;
        observed.push((index, utility / SELECTION_TEMPERATURE));
    }
    if observed.len() < 2 {
        return Err(coverage(
            "A joint selection target needs two observed candidates",
        ));
    }
    let logits: Vec<_> = observed.iter().map(|(_, value)| *value).collect();
    Ok(observed
        .into_iter()
        .zip(softmax(&logits)?)
        .map(|((index, _), probability)| (index, probability))
        .collect())
}

/// SplitMix64: a fixed, portable stream for the recipe's subset draws.
pub(super) fn split_mix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The case's full measured distribution, then seeded random subsets of at
/// least two of its candidates. A softmax restricted to a subset equals the
/// full softmax renormalized over it, so each subset target is that. The
/// stream depends only on the recipe seed and the case's version id.
pub(super) fn subset_targets(
    example: &TrainingExample,
    full: &[(usize, f64)],
) -> Result<Vec<Vec<(usize, f64)>>> {
    let mut draws = vec![full.to_vec()];
    if full.len() <= 2 {
        return Ok(draws);
    }
    let digest = Sha256::digest(example.version_id.as_bytes());
    let mut state =
        SUBSET_SEED ^ u64::from_le_bytes(digest[..8].try_into().expect("eight digest bytes"));
    let unit = |state: &mut u64| (split_mix(state) >> 11) as f64 / (1u64 << 53) as f64;
    while draws.len() < SUBSET_DRAWS {
        let mut subset: Vec<(usize, f64)> = Vec::new();
        for member in full {
            if unit(&mut state) < SUBSET_INCLUSION {
                subset.push(*member);
            }
        }
        while subset.len() < 2 {
            let pick = full[(split_mix(&mut state) % full.len() as u64) as usize];
            if subset.iter().all(|(index, _)| *index != pick.0) {
                subset.push(pick);
            }
        }
        subset.sort_by_key(|(index, _)| *index);
        let total: f64 = subset.iter().map(|(_, p)| p).sum();
        if !(total.is_finite() && total > 0.0) {
            return Err(invalid("A selection subset has no probability mass"));
        }
        draws.push(subset.into_iter().map(|(i, p)| (i, p / total)).collect());
    }
    Ok(draws)
}

pub(super) fn train_selection(
    snapshot: &TrainingSnapshot,
    vectors: &[Vec<f64>],
) -> Result<Vec<Vec<f64>>> {
    let mut groups = BTreeMap::new();
    for example in &snapshot.examples {
        *groups.entry(&example.split_group).or_insert(0usize) += 1;
    }
    // Every case contributes its full measured set and seeded random subsets
    // of it, each a softmax target of its own over the subset's utilities.
    let targets = snapshot
        .examples
        .iter()
        .map(|example| {
            let full = selection_distribution(&example.targets, &snapshot.request.configurations)?;
            subset_targets(example, &full)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut heads = vec![vec![0.0; DIMENSIONS]; snapshot.request.configurations.len()];
    for _ in 0..ITERATIONS {
        let mut gradients = vec![vec![0.0; DIMENSIONS]; heads.len()];
        for ((example, x), draws) in snapshot.examples.iter().zip(vectors).zip(&targets) {
            // Each related group has equal total weight, shared by the case's
            // draws. Unobserved candidates enter neither the target nor the
            // policy's training denominator.
            let weight = 1.0 / (groups[&example.split_group] * groups.len() * draws.len()) as f64;
            for target in draws {
                let logits: Vec<_> = target
                    .iter()
                    .map(|(index, _)| features::dot(x, &heads[*index]))
                    .collect();
                for ((index, target), probability) in target.iter().zip(softmax(&logits)?) {
                    let error = weight * (probability - target);
                    for (gradient, feature) in gradients[*index].iter_mut().zip(x) {
                        *gradient += error * feature;
                    }
                }
            }
        }
        for (head, gradient) in heads.iter_mut().zip(gradients) {
            for (index, (coefficient, gradient)) in head.iter_mut().zip(gradient).enumerate() {
                let penalty = if index == 0 {
                    0.0
                } else {
                    REGULARIZATION * *coefficient
                };
                *coefficient -= LEARNING_RATE * (gradient + penalty);
            }
        }
    }
    Ok(heads)
}

pub(super) fn refit(snapshot: &TrainingSnapshot, common_cases: usize) -> Result<LearnedModel> {
    let examples = &snapshot.examples;
    let vectors: Vec<_> = examples
        .iter()
        .map(|e| features::extract(&e.task))
        .collect::<Result<_>>()?;
    let selection_heads = train_selection(snapshot, &vectors)?;
    let mut candidates = Vec::new();
    for (configuration, selection_head) in
        snapshot.request.configurations.iter().zip(selection_heads)
    {
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
            selection_coefficients: Some(selection_head),
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
        recipe_parameters: Some(RECIPE_PARAMETERS),
    })
}
