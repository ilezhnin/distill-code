//! Publishing a version and carrying measured answers over to a republished evaluator.
use super::*;

/// One evaluation writer per attempt: a judge panel on one rendering never
/// blocks a review of another.
/// How long, and how often, a carried answer waits for room in the sandbox.
pub(in super::super) const CARRY_BUSY_PAUSE: std::time::Duration =
    std::time::Duration::from_secs(15);

pub(in super::super) const CARRY_BUSY_RETRIES: u32 = 40;

/// The checks that evaluate saved answers without a model.
pub(in super::super) const CARRIED_EVALUATORS: [&str; 4] =
    ["exact", "json", "javascript", "browser"];

/// The carried evaluations under way, and why the last one of each version
/// stopped, by store and version.
#[derive(Default)]
pub(in super::super) struct Carrying {
    pub(in super::super) running: std::collections::HashSet<String>,
    pub(in super::super) errors: HashMap<String, String>,
}

pub(in super::super) fn carrying() -> std::sync::MutexGuard<'static, Carrying> {
    static CARRYING: OnceLock<std::sync::Mutex<Carrying>> = OnceLock::new();
    CARRYING
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether the evaluator of `revision` has given `evaluations` its verdict.
pub(in super::super) fn evaluated_by(evaluations: &[Evaluation], revision: &str) -> bool {
    evaluations.iter().any(|evaluation| {
        evaluation.evaluator_revision == revision
            && !matches!(
                evaluation.provenance.as_str(),
                "human" | "human_visual" | "judge" | "judge_failure" | "render"
            )
    })
}

pub(in super::super) fn evaluation_lock(attempt_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(attempt_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(attempt_id.to_owned(), Arc::downgrade(&lock));
    lock
}

impl BenchmarkService {
    /// Publishes a new immutable version without changing earlier results.
    pub async fn publish_version(&self, id: &str, revision: i64) -> Result<BenchmarkVersion> {
        let version = self.store.publish(id, revision).await?;
        self.changed().await;
        Ok(version)
    }

    /// Publishes `draft` as the next version of the live test of the same
    /// name, keeping its measured answers: the draft may differ from the
    /// test's current version in its evaluator alone (see
    /// [`catalog::carried_evaluator`]). The new version carries the current
    /// one's cells; [`Self::evaluate_carried`] then evaluates their saved
    /// answers with the new evaluator. The test's own draft is replaced.
    pub async fn republish_evaluator(&self, draft: BenchmarkDraft) -> Result<BenchmarkVersion> {
        let named = sqlx::query_scalar::<_, String>(
            "SELECT d.id FROM benchmark_definitions d WHERE d.archived=0 AND (SELECT json_extract(v.manifest_json,'$.name') FROM benchmark_versions v WHERE v.definition_id=d.id ORDER BY v.published_at DESC,v.rowid DESC LIMIT 1)=?",
        )
        .bind(&draft.name)
        .fetch_all(&self.store.pool)
        .await?;
        let [id] = named.as_slice() else {
            return Err(BenchmarkError::new(
                "validation",
                if named.is_empty() {
                    "No published test has this definition's name"
                } else {
                    "Several tests have this definition's name; archive or rename the others first"
                },
            ));
        };
        let definition = self.store.definition(id).await?;
        // Checked on the draft as the store would save it, before it replaces
        // the test's own draft.
        let mut draft = draft;
        routing::normalize_draft(&mut draft);
        let current = self.store.versions_for(id).await?.into_iter().next();
        catalog::carried_evaluator(current.as_ref().map(|version| &version.manifest), &draft)?;
        let saved = self
            .store
            .save_draft(Some(id), Some(definition.draft_revision), draft)
            .await?;
        let version = self
            .store
            .publish_carrying(id, saved.draft_revision)
            .await?;
        self.changed().await;
        Ok(version)
    }

    /// The saved answers of the versions `version` carries that have a
    /// verdict to replace, oldest first, each with whether this version's
    /// evaluator has evaluated it. Budget failures, cancellations and
    /// infrastructure outcomes keep theirs, as in [`Self::rescore`].
    pub(in super::super) async fn carried_answers(
        &self,
        version: &BenchmarkVersion,
    ) -> Result<Vec<(String, bool)>> {
        use sqlx::Row;
        let mut chain = Vec::new();
        let mut from = version.carries_from.clone();
        while let Some(id) = from.filter(|id| !chain.contains(id)) {
            from = self.store.version(&id).await?.carries_from;
            chain.push(id);
        }
        let mut answers = Vec::new();
        for id in chain.iter().rev() {
            let rows = sqlx::query(
                "SELECT id,json_extract(data_json,'$.evaluations') FROM attempts WHERE version_id=?
                 AND json_extract(data_json,'$.phase')='terminal'
                 AND json_extract(data_json,'$.outcome') IN ('pass','fail','completed','evaluation_error')
                 AND json_type(data_json,'$.output')='text'
                 AND NOT EXISTS(SELECT 1 FROM workflow_steps w WHERE w.attempt_id=attempts.id)
                 ORDER BY rowid",
            )
            .bind(id)
            .fetch_all(&self.store.pool)
            .await?;
            for row in rows {
                let evaluations: Vec<Evaluation> = row
                    .get::<Option<String>, _>(1)
                    .map(|recorded| serde_json::from_str(&recorded))
                    .transpose()?
                    .unwrap_or_default();
                answers.push((
                    row.get::<String, _>(0),
                    evaluated_by(&evaluations, &version.manifest.evaluator.revision),
                ));
            }
        }
        Ok(answers)
    }

    /// How far the evaluation of the answers `version_id` carries has come.
    pub async fn carry_status(&self, version_id: &str) -> Result<CarryStatus> {
        let version = self.store.version(version_id).await?;
        let answers = self.carried_answers(&version).await?;
        let key = self.carry_key(version_id);
        let (running, last_error) = {
            let carrying = carrying();
            (
                carrying.running.contains(&key),
                carrying.errors.get(&key).cloned(),
            )
        };
        Ok(CarryStatus {
            version_id: version_id.into(),
            total: answers.len() as u32,
            evaluated: answers.iter().filter(|(_, evaluated)| *evaluated).count() as u32,
            running,
            last_error,
        })
    }

    /// The version whose carried answers can be evaluated now: one that
    /// carries, is current, and evaluates without a model.
    pub async fn carrying_version(&self, version_id: &str) -> Result<BenchmarkVersion> {
        let version = self.store.version(version_id).await?;
        if version.carries_from.is_none() {
            return Err(BenchmarkError::new(
                "validation",
                "This version keeps no answers of an earlier one",
            ));
        }
        self.store
            .require_current_versions(std::slice::from_ref(&version.id))
            .await?;
        if !CARRIED_EVALUATORS.contains(&version.manifest.evaluator.kind.as_str()) {
            return Err(BenchmarkError::new(
                "validation",
                "Only text, JSON, JavaScript and web page checks evaluate saved answers without a model",
            ));
        }
        Ok(version)
    }

    /// Every test whose current version has saved answers left to evaluate,
    /// running or stopped, oldest publication first: the activity strip
    /// shows this work beside the runs, and a restart that stopped it.
    pub async fn carry_activity(&self) -> Result<Vec<CarryActivity>> {
        let current = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT v.id,v.definition_id,COALESCE(json_extract(v.manifest_json,'$.name'),''),COALESCE(json_extract(v.manifest_json,'$.evaluator.kind'),'')
             FROM benchmark_versions v JOIN benchmark_definitions d ON d.id=v.definition_id
             WHERE d.archived=0 AND v.carries_from IS NOT NULL
               AND v.id=(SELECT newest.id FROM benchmark_versions newest WHERE newest.definition_id=v.definition_id ORDER BY newest.published_at DESC,newest.rowid DESC LIMIT 1)
             ORDER BY v.published_at,v.rowid",
        )
        .fetch_all(&self.store.pool)
        .await?;
        let mut activity = Vec::new();
        for (version_id, definition_id, name, kind) in current {
            if !CARRIED_EVALUATORS.contains(&kind.as_str()) {
                continue;
            }
            let status = self.carry_status(&version_id).await?;
            if status.running || status.evaluated < status.total {
                activity.push(CarryActivity {
                    definition_id,
                    name,
                    status,
                });
            }
        }
        Ok(activity)
    }

    pub(in super::super) fn carry_key(&self, version_id: &str) -> String {
        format!("{}\u{1f}{version_id}", self.store.root.display())
    }

    /// Evaluates every saved answer `version_id` carries that its evaluator
    /// has not evaluated yet: locally, one at a time, with no model call. Each
    /// answer keeps its recorded evaluations and gets the new one beside
    /// them, as "Evaluate again" adds one. Asked again, after a restart or a
    /// failure, it goes on with what is left.
    pub async fn evaluate_carried(&self, version_id: &str) -> Result<CarryStatus> {
        let version = self.carrying_version(version_id).await?;
        let key = self.carry_key(version_id);
        if !carrying().running.insert(key.clone()) {
            return self.carry_status(version_id).await;
        }
        carrying().errors.remove(&key);
        let passed = self.evaluate_carried_answers(&version).await;
        carrying().running.remove(&key);
        if let Err(error) = passed {
            log::warn!(
                "[benchmarks] evaluating the answers version {version_id} carries stopped: {}",
                error.message
            );
            carrying().errors.insert(key, error.message);
        }
        self.changed().await;
        self.carry_status(version_id).await
    }

    pub(in super::super) async fn evaluate_carried_answers(
        &self,
        version: &BenchmarkVersion,
    ) -> Result<()> {
        let mut failed = None;
        for (id, evaluated) in self.carried_answers(version).await? {
            if evaluated {
                continue;
            }
            match self.evaluate_carried_answer(version, &id).await {
                Ok(()) => self.changed().await,
                // Without the sandbox's renderer no answer can be evaluated.
                Err(error) if error.code == "capability_missing" => return Err(error),
                // One answer's failure leaves it for the next request.
                Err(error) => {
                    log::warn!(
                        "[benchmarks] carried answer {id} was not evaluated: {}",
                        error.message
                    );
                    failed = Some(error);
                }
            }
        }
        failed.map_or(Ok(()), Err)
    }

    pub(in super::super) async fn evaluate_carried_answer(
        &self,
        version: &BenchmarkVersion,
        id: &str,
    ) -> Result<()> {
        let lock = evaluation_lock(id);
        let _guard = lock.lock().await;
        let mut a = self.store.attempt(id).await?;
        // An answer recorded with a reconnect's broken streams in front of it
        // is evaluated as the model gave it, as "Evaluate again" does.
        if let Some(answer) = runner::reconnect::rebuilt_answer(
            &self.store.root,
            &a,
            version.manifest.limits.max_artifact_bytes,
        )
        .await
        {
            a.output = Some(answer);
        }
        let Some(output) = a.output.clone() else {
            return Ok(());
        };
        // An "Evaluate again" may have settled it while this one waited.
        if evaluated_by(&a.evaluations, &version.manifest.evaluator.revision) {
            return Ok(());
        }
        // Carried answers of every version share one lane, so several
        // republished tests never fill the sandbox with their backlog.
        static LANE: Mutex<()> = Mutex::const_new(());
        let _lane = LANE.lock().await;
        let mut busy = 0;
        let mut e = loop {
            match runner::evaluate(&version.manifest, &output).await {
                // The sandbox is full: its room comes back as jobs finish.
                Err(error) if error.code == "resource_busy" && busy < CARRY_BUSY_RETRIES => {
                    busy += 1;
                    tokio::time::sleep(CARRY_BUSY_PAUSE).await;
                }
                evaluated => break evaluated?,
            }
        };
        match e.details.get_or_insert_with(|| serde_json::json!({})) {
            serde_json::Value::Object(details) => {
                details.insert("carriedTo".into(), serde_json::json!(version.id));
            }
            other => *other = serde_json::json!({"carriedTo": version.id, "details": other.take()}),
        }
        a.outcome = Some(e.verdict.clone());
        a.evaluations.push(e);
        self.store.save_attempt(&a).await
    }
}
