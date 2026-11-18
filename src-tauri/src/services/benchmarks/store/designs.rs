//! The board's cards: one per case with its cells, scoring batch and workflow activity.
use super::*;

impl Store {
    /// A rendering from the newest complete cell per creative brief and
    /// configuration. Repetitions must belong to the same run and request.
    pub async fn list_designs(&self, q: &ResultQuery) -> Result<Vec<DesignEntry>> {
        let catalog = self.catalog_entries().await?;
        let versions = q
            .version_ids
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let rows = sqlx::query(
            "SELECT a.data_json,v.manifest_json,r.created_at,
                    json_extract(r.request_json,'$.repetitions')
             FROM attempts a
             JOIN benchmark_versions v ON v.id=a.version_id
             JOIN run_plans r ON r.id=a.run_id
             WHERE json_extract(v.manifest_json,'$.workClassId')='creative'
                AND COALESCE(json_extract(r.request_json,'$.preview'),0)=0
                AND (? IS NULL OR a.run_id=?)
                AND (? IS NULL OR a.version_id IN (SELECT value FROM json_each(?)))
             ORDER BY r.created_at DESC,r.id,a.rowid DESC",
        )
        .bind(&q.run_id)
        .bind(&q.run_id)
        .bind(&versions)
        .bind(&versions)
        .fetch_all(&self.pool)
        .await?;
        // A rendering of an unknown effort is no entry (see `effort`). An
        // attempt without an acknowledgment is judged by what its run's
        // attempts of the same request were acknowledged at.
        let mut defaulted = crate::services::benchmarks::effort::DefaultedRequests::default();
        for row in sqlx::query(
            "SELECT run_id,json_extract(data_json,'$.configuration') FROM attempts
             WHERE json_extract(data_json,'$.observed.effort')=?",
        )
        .bind(crate::services::benchmarks::effort::CLI_DEFAULT_EFFORT)
        .fetch_all(&self.pool)
        .await?
        {
            let requested: Configuration = serde_json::from_str(&row.get::<String, _>(1))?;
            defaulted.add(&row.get::<String, _>(0), &requested);
        }
        // One card per brief and model as the leaderboard counts it: runtime
        // revisions and defaulted controls do not split a model. Rows come newest
        // first. Only complete scored cells can supply a card; a failed
        // triple remains a result, while a single rendering is no measurement.
        let mut candidates: Vec<(Attempt, BenchmarkDraft, i64, u32)> = Vec::new();
        let mut repetitions = std::collections::BTreeMap::<_, std::collections::BTreeSet<_>>::new();
        let mut cards: std::collections::BTreeMap<(String, String), (u8, usize)> =
            std::collections::BTreeMap::new();
        for row in rows {
            let mut attempt: Attempt = serde_json::from_str(&row.get::<String, _>(0))?;
            // A candidate that authored the brief is not an entry of it.
            if attempt.outcome.as_deref() == Some("excluded")
                || crate::services::benchmarks::analysis::is_superseded(&attempt)
                || crate::services::benchmarks::effort::effort_unknown(&attempt, &defaulted)
            {
                continue;
            }
            let manifest: BenchmarkDraft = serde_json::from_str(&row.get::<String, _>(1))?;
            // The gallery compares quality, so a rendering of a brief its
            // candidate wrote stays out of it, as on every quality board.
            if crate::services::benchmarks::routing::authored_by_candidate(
                &manifest,
                &attempt.configuration,
            ) {
                continue;
            }
            // A rendering its event record stopped is unscored, as on every
            // board (see `evidence`).
            crate::services::benchmarks::evidence::rendering_with_answer_cap(
                &mut attempt,
                manifest.limits.max_artifact_bytes,
            );
            if attempt.phase != "terminal"
                || crate::services::benchmarks::analysis::score_as_of(&attempt, q.as_of).is_none()
            {
                continue;
            }
            let required = crate::services::benchmarks::analysis::REQUIRED_REPETITIONS
                .max(manifest.repetitions)
                .max(row.get::<i64, _>(3) as u32);
            repetitions
                .entry((
                    attempt.run_id.clone(),
                    attempt.version_id.clone(),
                    attempt.configuration.id.clone(),
                ))
                .or_default()
                .insert(attempt.repetition);
            candidates.push((attempt, manifest, row.get(2), required));
        }
        // The card each candidate of a complete cell belongs to.
        let mut keys: Vec<Option<(String, String)>> = Vec::with_capacity(candidates.len());
        for (index, (attempt, _, _, required)) in candidates.iter().enumerate() {
            if repetitions[&(
                attempt.run_id.clone(),
                attempt.version_id.clone(),
                attempt.configuration.id.clone(),
            )]
                .len()
                < *required as usize
            {
                keys.push(None);
                continue;
            }
            let key = (
                attempt.version_id.clone(),
                crate::services::benchmarks::analysis::leaderboard_key(&card_configuration(
                    attempt,
                )),
            );
            keys.push(Some(key.clone()));
            let tier = card_tier(attempt);
            let card = cards.entry(key).or_insert((tier, index));
            if tier > card.0 && candidates[card.1].0.run_id == attempt.run_id {
                *card = (tier, index);
            }
        }
        let mut chosen: Vec<usize> = cards.into_values().map(|(_, index)| index).collect();
        chosen.sort_unstable();
        let mut out = Vec::new();
        for index in chosen {
            let (attempt, manifest, run_created_at, required) = &candidates[index];
            let configuration = card_configuration(attempt).into_owned();
            let review = attempt
                .evaluations
                .iter()
                .rev()
                .find(|e| e.provenance == "human" && e.score.is_some())
                .map(|e| DesignReview {
                    score: e.score.unwrap_or_default(),
                    reason: e.reason.clone(),
                    details: e.details.clone(),
                    created_at: e.created_at,
                });
            let judges = attempt.evaluations[scoring_batch(&attempt.evaluations)]
                .iter()
                .filter(|e| e.provenance == "judge")
                .filter_map(|e| {
                    Some(DesignJudge {
                        configuration: e.judge.clone()?,
                        score: e.score?,
                        reason: e.reason.clone(),
                        details: e
                            .details
                            .as_ref()
                            .map(|d| d.get("criteria").unwrap_or(d).clone()),
                    })
                })
                .collect();
            let score = crate::services::benchmarks::analysis::score(attempt);
            // Every scored rendering of the card's brief and model, each with
            // the image its own panel scored.
            let mut points: Vec<DesignPoint> = candidates
                .iter()
                .zip(&keys)
                .filter(|(_, key)| key.is_some() && **key == keys[index])
                .map(|((point, _, _, _), _)| {
                    let batch = &point.evaluations[scoring_batch(&point.evaluations)];
                    DesignPoint {
                        attempt_id: point.id.clone(),
                        run_id: point.run_id.clone(),
                        repetition: point.repetition,
                        finished_at: point.finished_at,
                        duration_ms: point.duration_ms,
                        cost: crate::services::benchmarks::model_catalog::attempt_cost(
                            &catalog,
                            &point.configuration,
                            &point.usage,
                            point.finished_at.or(point.started_at),
                        ),
                        score: crate::services::benchmarks::analysis::score(point),
                        judges: batch
                            .iter()
                            .filter(|e| e.provenance == "judge" && e.score.is_some())
                            .count() as u32,
                        rendering: batch_rendering(batch),
                    }
                })
                .collect();
            points.sort_by(|a, b| {
                b.finished_at
                    .cmp(&a.finished_at)
                    .then(a.repetition.cmp(&b.repetition))
            });
            out.push(DesignEntry {
                attempt_id: attempt.id.clone(),
                run_id: attempt.run_id.clone(),
                run_created_at: *run_created_at,
                version_id: attempt.version_id.clone(),
                name: manifest.name.clone(),
                task_family: manifest.task_family.clone(),
                difficulty: manifest.facets.difficulty.clone(),
                output_format: manifest.facets.output_format.clone(),
                configuration,
                phase: attempt.phase.clone(),
                outcome: crate::services::benchmarks::analysis::effective_outcome(
                    attempt.outcome.as_deref(),
                    &attempt.evaluations,
                ),
                output: attempt.output.clone(),
                finished_at: attempt.finished_at,
                duration_ms: attempt.duration_ms,
                output_tokens: attempt.usage.output,
                // The candidate's own generation; judge calls are the benchmark's expense.
                cost: crate::services::benchmarks::model_catalog::attempt_cost(
                    &catalog,
                    &attempt.configuration,
                    &attempt.usage,
                    attempt.finished_at.or(attempt.started_at),
                ),
                review,
                judges,
                score,
                required_repetitions: *required,
                completed_repetitions: repetitions[&(
                    attempt.run_id.clone(),
                    attempt.version_id.clone(),
                    attempt.configuration.id.clone(),
                )]
                    .len() as u32,
                rendering: batch_rendering(
                    &attempt.evaluations[scoring_batch(&attempt.evaluations)],
                ),
                points,
            });
        }
        Ok(out)
    }
}

/// Only entered roots can contribute live child metadata. The run/phase index
/// narrows roots before any manifest is read; each child lookup uses the unique
/// root/index key. Protected step inputs and outputs never leave SQLite.
pub(super) const WORKFLOW_ACTIVITY_SQL: &str = "WITH selected_roots AS MATERIALIZED (
    SELECT a.id,a.run_id,a.version_id,a.phase,a.rowid AS root_order,
        a.repetition,
        json_extract(a.data_json,'$.outcome') AS outcome
    FROM json_each(?) listed
    JOIN run_plans r ON r.id=listed.value
    JOIN attempts a ON a.run_id=r.id
    WHERE r.state IN ('running','pausing','cancelling','needs_attention')
        AND a.phase IN ('preparing','dispatching','running','collecting')
        AND json_extract(a.data_json,'$.startedAt') IS NOT NULL
        AND COALESCE(json_extract(a.data_json,'$.outcome'),'')<>'superseded'
    )
    SELECT a.run_id,a.id,a.version_id,a.phase,a.outcome,
        (SELECT json_group_array(json(step)) FROM (
            SELECT json_object(
                'attemptId',s.attempt_id,'index',s.step_index,'phase',s.phase,
                'outcome',json_extract(s.data_json,'$.outcome'),
                'startedAt',json_extract(s.data_json,'$.startedAt'),
                'finishedAt',json_extract(s.data_json,'$.finishedAt'),
                'sessionId',json_extract(s.data_json,'$.sessionId'),
                'hostRunId',json_extract(s.data_json,'$.hostRunId'),
                'configuration',json(COALESCE(json_extract(s.data_json,'$.observed'),
                    json_extract(s.data_json,'$.configuration')))) AS step
            FROM workflow_steps s WHERE s.root_attempt_id=a.id ORDER BY s.step_index
        )), a.repetition
    FROM selected_roots a JOIN benchmark_versions v ON v.id=a.version_id
    WHERE json_type(v.manifest_json,'$.workflow')='object'
    ORDER BY a.root_order";

pub(super) async fn workflow_activity(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_ids: &[String],
) -> Result<HashMap<String, Vec<WorkflowActivity>>> {
    let mut activity: HashMap<String, Vec<WorkflowActivity>> = HashMap::new();
    if run_ids.is_empty() {
        return Ok(activity);
    }
    let rows = sqlx::query(WORKFLOW_ACTIVITY_SQL)
        .bind(serde_json::to_string(run_ids)?)
        .fetch_all(&mut **tx)
        .await?;
    for row in rows {
        activity
            .entry(row.get(0))
            .or_default()
            .push(WorkflowActivity {
                root_attempt_id: row.get(1),
                version_id: row.get(2),
                phase: row.get(3),
                outcome: row.get(4),
                steps: serde_json::from_str(row.get(5))?,
                repetition: row.get::<i64, _>(6) as u32,
            });
    }
    Ok(activity)
}

pub(super) fn open_cells(rows: Option<&str>) -> Vec<OpenRunCell> {
    rows.and_then(|rows| serde_json::from_str::<Vec<(String, String, i64)>>(rows).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|(configuration_id, version_id, running)| OpenRunCell {
            configuration_id,
            version_id,
            running: running != 0,
        })
        .collect()
}

/// The model a gallery card stands for: the leaderboard's own attribution, so
/// a refused selection stays with the candidate that was asked for.
pub(super) fn card_configuration(attempt: &Attempt) -> std::borrow::Cow<'_, Configuration> {
    crate::services::benchmarks::analysis::execution_configuration(attempt)
}

/// The judge batch a card shows: the newest one whose valid votes reached its
/// panel size, else the newest one. An unfinished re-evaluation never hides a
/// settled panel.
pub(super) fn scoring_batch(evaluations: &[Evaluation]) -> std::ops::Range<usize> {
    let markers: Vec<usize> = evaluations
        .iter()
        .enumerate()
        .filter(|(_, e)| e.provenance == "render")
        .map(|(index, _)| index)
        .collect();
    let batch = |position: usize| {
        let start = markers[position];
        start
            ..markers
                .get(position + 1)
                .copied()
                .unwrap_or(evaluations.len())
    };
    for position in (0..markers.len()).rev() {
        let range = batch(position);
        let expected = evaluations[range.start]
            .details
            .as_ref()
            .and_then(|d| d["expectedJudges"].as_u64())
            .unwrap_or(1) as usize;
        let votes = evaluations[range.clone()]
            .iter()
            .filter(|e| {
                e.provenance == "judge"
                    && e.score
                        .is_some_and(|s| s.is_finite() && (0.0..=1.0).contains(&s))
            })
            .count();
        if votes >= expected {
            return range;
        }
    }
    match markers.last() {
        Some(_) => batch(markers.len() - 1),
        None => 0..evaluations.len(),
    }
}

/// The image a judge batch scored: its render marker's screenshot.
pub(super) fn batch_rendering(batch: &[Evaluation]) -> Option<String> {
    batch
        .first()
        .filter(|e| e.provenance == "render")?
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == "screenshot")
        .map(|artifact| artifact.path.clone())
}

/// How well an attempt can stand for its card: a scored rendering, a rendering,
/// a settled attempt, anything else. A rendering awaiting its panel has a
/// sealed generation and stands like a settled one.
pub(super) fn card_tier(attempt: &Attempt) -> u8 {
    if !matches!(attempt.phase.as_str(), "terminal" | AWAITING_JUDGES) {
        return 0;
    }
    let rendering = attempt
        .output
        .as_deref()
        .is_some_and(|o| !o.trim().is_empty())
        && !matches!(
            attempt.outcome.as_deref(),
            Some(
                "cancelled"
                    | "selection_changed"
                    | "execution_violation"
                    | "interrupted"
                    | "dispatch_uncertain"
            )
        );
    match (
        rendering,
        crate::services::benchmarks::analysis::score(attempt).is_some(),
    ) {
        (true, true) => 3,
        (true, false) => 2,
        _ => 1,
    }
}
