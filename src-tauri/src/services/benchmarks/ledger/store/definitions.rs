//! Definitions, drafts and published versions.
use super::*;

/// A SQL expression reading a [`ManifestSummary`] out of the manifest JSON in
/// `column`, path by path. Nothing outside these paths leaves SQLite, however
/// large the prompt, fixtures, checks or environment are. Defaults follow
/// [`BenchmarkDraft`]'s serde defaults. `json()` keeps nested values JSON
/// through CASE and subqueries.
fn manifest_summary_sql(column: &str) -> String {
    const SQL: &str = "json_object(
        'name',json_extract(@,'$.name'),
        'category',json_extract(@,'$.category'),
        'taskFamily',json_extract(@,'$.taskFamily'),
        'split',json_extract(@,'$.split'),
        'executionProfile',json_extract(@,'$.executionProfile'),
        'measurementProfile',json_extract(@,'$.measurementProfile'),
        'evaluator',json_object('kind',json_extract(@,'$.evaluator.kind'),'revision',json_extract(@,'$.evaluator.revision')),
        'limits',json_object('timeoutSeconds',json_extract(@,'$.limits.timeoutSeconds'),'maxTurns',json_extract(@,'$.limits.maxTurns'),'maxArtifactBytes',json_extract(@,'$.limits.maxArtifactBytes')),
        'repetitions',json_extract(@,'$.repetitions'),
        'workClassId',COALESCE(json_extract(@,'$.workClassId'),'general'),
        'roleId',json_extract(@,'$.roleId'),
        'roleContextHash',COALESCE(json_extract(@,'$.roleContextHash'),'clean-v1'),
        'facets',json_object('language',json_extract(@,'$.facets.language'),'domain',json_extract(@,'$.facets.domain'),'difficulty',json_extract(@,'$.facets.difficulty'),'inputBytes',json_extract(@,'$.facets.inputBytes'),'outputFormat',json_extract(@,'$.facets.outputFormat')),
        'entryState',json(CASE WHEN json_type(@,'$.entryState')='object' THEN json_object('contentHash',json_extract(@,'$.entryState.contentHash')) END),
        'workflow',json(CASE WHEN json_type(@,'$.workflow')='object' THEN json_object('steps',json((SELECT json_group_array(json_object('id',json_extract(s.value,'$.id'),'scope',json(CASE WHEN json_type(s.value,'$.scope')='object' THEN json_object('roleId',json_extract(s.value,'$.scope.roleId'),'workClassId',json_extract(s.value,'$.scope.workClassId'),'purpose',json_extract(s.value,'$.scope.purpose'),'stepBudgetSeconds',json_extract(s.value,'$.scope.stepBudgetSeconds')) END))) FROM json_each(@,'$.workflow.steps') s))) END),
        'environment',json_object(
            'authoredBy',json(CASE WHEN json_type(@,'$.environment.authoredBy')='array' THEN (SELECT json_group_array(json_object('providerId',json_extract(a.value,'$.providerId'),'modelId',json_extract(a.value,'$.modelId'),'effort',json_extract(a.value,'$.effort'))) FROM json_each(@,'$.environment.authoredBy') a WHERE a.type='object' AND json_type(a.value,'$.providerId')='text' AND json_type(a.value,'$.modelId')='text' AND json_type(a.value,'$.effort') IN ('text','null')) END),
            'splitGroup',CASE WHEN json_type(@,'$.environment.splitGroup')='text' THEN json_extract(@,'$.environment.splitGroup') END,
            'judgePanel',json(CASE WHEN json_type(@,'$.environment.judgePanel.judges')='array' THEN json_object('judges',json((SELECT json_group_array(json_object('providerId',json_extract(j.value,'$.providerId'),'modelId',json_extract(j.value,'$.modelId'),'effort',json_extract(j.value,'$.effort'))) FROM json_each(@,'$.environment.judgePanel.judges') j))) WHEN json_type(@,'$.environment.judgePanel')='object' THEN json_object() END),
            'generator',json(CASE WHEN json_type(@,'$.environment.generator.family')='text' THEN json_object('family',json_extract(@,'$.environment.generator.family')) END)))";
    SQL.replace('@', column)
}

/// Parses [`manifest_summary_sql`]'s JSON. Environment keys a manifest does
/// not declare stay absent rather than null.
fn manifest_summary(json: &str) -> Result<ManifestSummary> {
    let mut summary: ManifestSummary = serde_json::from_str(json)?;
    if let serde_json::Value::Object(environment) = &mut summary.environment {
        environment.retain(|_, value| !value.is_null());
    }
    Ok(summary)
}

impl Store {
    /// UI catalog window: the newest 1,000 definitions, as summaries. SQLite
    /// reads the listed paths out of each manifest, so the app never holds
    /// the task contents of the whole catalog at once. Evidence and export
    /// consumers must use all_definitions so old published cases remain visible.
    pub async fn definition_summaries(&self) -> Result<Vec<BenchmarkDefinitionSummary>> {
        let rows = sqlx::query(&format!(
            "SELECT id,revision,archived,archived_at,{} FROM benchmark_definitions ORDER BY rowid DESC LIMIT 1000",
            manifest_summary_sql("draft_json")
        ))
        .fetch_all(&self.pool)
        .await?;
        let versions = format!(
            "SELECT id,content_hash,published_at,carries_from,{} FROM benchmark_versions WHERE definition_id=? ORDER BY published_at DESC,rowid DESC",
            manifest_summary_sql("manifest_json")
        );
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let id: String = r.get(0);
            let mut listed = Vec::new();
            for v in sqlx::query(&versions)
                .bind(&id)
                .fetch_all(&self.pool)
                .await?
            {
                listed.push(BenchmarkVersionSummary {
                    id: v.get(0),
                    definition_id: id.clone(),
                    content_hash: v.get(1),
                    published_at: v.get(2),
                    carries_from: v.get(3),
                    manifest: manifest_summary(v.get(4))?,
                });
            }
            out.push(BenchmarkDefinitionSummary {
                archive_history: self.archive_history(&id).await?,
                draft_revision: r.get(1),
                archived: r.get(2),
                archived_at: r.get(3),
                draft: manifest_summary(r.get(4))?,
                versions: listed,
                id,
            });
        }
        Ok(out)
    }

    pub async fn has_definitions(&self) -> Result<bool> {
        Ok(
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM benchmark_definitions)")
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub async fn all_definitions(&self) -> Result<Vec<BenchmarkDefinition>> {
        let mut definitions = Vec::new();
        let mut after = 0i64;
        loop {
            let rows=sqlx::query("SELECT rowid,id FROM benchmark_definitions WHERE rowid>? ORDER BY rowid LIMIT 1000")
                .bind(after).fetch_all(&self.pool).await?;
            let count = rows.len();
            for row in rows {
                after = row.get(0);
                definitions.push(self.definition(row.get(1)).await?);
            }
            if count < 1000 {
                break;
            }
        }
        Ok(definitions)
    }

    pub async fn definition(&self, id: &str) -> Result<BenchmarkDefinition> {
        let r = sqlx::query(
            "SELECT revision,archived,archived_at FROM benchmark_definitions WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| BenchmarkError::new("validation", "Definition not found"))?;
        let (draft_revision, draft) = self.draft(id, r.get(0)).await?;
        Ok(BenchmarkDefinition {
            id: id.into(),
            draft: Arc::unwrap_or_clone(draft),
            draft_revision,
            archived: r.get(1),
            archived_at: r.get(2),
            archive_history: self.archive_history(id).await?,
            versions: self.versions_for(id).await?,
        })
    }

    /// `id`'s draft at `revision`, parsed once per revision; a newer revision
    /// is read together with its own number.
    pub(super) async fn draft(
        &self,
        id: &str,
        revision: i64,
    ) -> Result<(i64, Arc<BenchmarkDraft>)> {
        let cached = self.parsed.drafts.lock().unwrap().get(id).cloned();
        if let Some((at, draft)) = cached.filter(|(at, _)| *at == revision) {
            return Ok((at, draft));
        }
        let r = sqlx::query("SELECT revision,draft_json FROM benchmark_definitions WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| BenchmarkError::new("validation", "Definition not found"))?;
        let revision: i64 = r.get(0);
        let draft = Arc::new(serde_json::from_str::<BenchmarkDraft>(r.get(1))?);
        self.parsed
            .drafts
            .lock()
            .unwrap()
            .insert(id.into(), (revision, draft.clone()));
        Ok((revision, draft))
    }

    /// What the analyses read of every definition, in catalog order: whether
    /// and when it was archived. No draft or manifest is read.
    pub async fn definition_states(&self) -> Result<Vec<DefinitionState>> {
        let mut history: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
        for r in sqlx::query(
            "SELECT definition_id,archived_at,restored_at FROM benchmark_definition_archives ORDER BY archived_at",
        )
        .fetch_all(&self.pool)
        .await?
        {
            history
                .entry(r.get(0))
                .or_default()
                .push((r.get(1), r.get(2)));
        }
        let rows =
            sqlx::query("SELECT id,archived,archived_at FROM benchmark_definitions ORDER BY rowid")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let id: String = r.get(0);
                DefinitionState {
                    archive_history: history.remove(&id).unwrap_or_default(),
                    id,
                    archived: r.get(1),
                    archived_at: r.get(2),
                }
            })
            .collect())
    }

    /// Every published version: definitions in catalog order, each one's
    /// newest first, as [`Self::all_definitions`] lists them.
    pub async fn all_versions(&self) -> Result<Vec<BenchmarkVersion>> {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT v.id FROM benchmark_versions v JOIN benchmark_definitions d ON d.id=v.definition_id ORDER BY d.rowid,v.published_at DESC,v.rowid DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            out.push(Arc::unwrap_or_clone(self.version_shared(&id).await?));
        }
        Ok(out)
    }

    /// Drops the parsed copies, for fixtures that rewrite a stored manifest
    /// or draft in place behind the store.
    #[cfg(test)]
    pub(crate) fn forget_parsed(&self) {
        self.parsed.versions.lock().unwrap().clear();
        self.parsed.drafts.lock().unwrap().clear();
    }

    /// Archive periods a restore closed, oldest first.
    pub(super) async fn archive_history(&self, id: &str) -> Result<Vec<(i64, i64)>> {
        let rows = sqlx::query(
            "SELECT archived_at,restored_at FROM benchmark_definition_archives WHERE definition_id=? ORDER BY archived_at",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| (r.get(0), r.get(1))).collect())
    }

    pub async fn versions_for(&self, id: &str) -> Result<Vec<BenchmarkVersion>> {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM benchmark_versions WHERE definition_id=? ORDER BY published_at DESC,rowid DESC",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(ids.len());
        for version in ids {
            out.push(Arc::unwrap_or_clone(self.version_shared(&version).await?));
        }
        Ok(out)
    }

    /// [`Self::require_current_versions`] for the work an admitted run goes
    /// on with. A version an evaluator-only republication carries is still
    /// its case, the task unchanged but for the check, and the runner
    /// evaluates its new turns with the carrying version's evaluator; a run
    /// that holds it goes on (11-16: three paused runs held the six
    /// suite-writing tests republished for share scoring). A version
    /// replaced any other way is retired.
    pub async fn require_continuable_versions(&self, ids: &[String]) -> Result<()> {
        let mut carrying = Vec::with_capacity(ids.len());
        for id in ids {
            carrying.push(self.carried_version(id).await?.id);
        }
        self.require_current_versions(&carrying).await
    }

    /// Historical manifests stay readable; only current versions accept new work.
    pub async fn require_current_versions(&self, ids: &[String]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::require_current_versions_in(&mut tx, ids).await
    }

    pub(in crate::services::benchmarks) async fn require_current_versions_in(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        ids: &[String],
    ) -> Result<()> {
        for id in ids {
            let current: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM benchmark_versions v JOIN benchmark_definitions d ON d.id=v.definition_id WHERE v.id=? AND d.archived=0 AND v.id=(SELECT newest.id FROM benchmark_versions newest WHERE newest.definition_id=v.definition_id ORDER BY newest.published_at DESC,newest.rowid DESC LIMIT 1))",
            ).bind(id).fetch_one(&mut **tx).await?;
            if !current {
                return Err(BenchmarkError::new(
                    "version_retired",
                    "This test version is archived or unavailable; select its latest published version for a new run",
                ));
            }
            let difficulty: Option<String> = sqlx::query_scalar("SELECT json_extract(manifest_json,'$.facets.difficulty') FROM benchmark_versions WHERE id=?")
                .bind(id).fetch_one(&mut **tx).await?;
            if !matches!(difficulty.as_deref(), Some("easy" | "medium" | "hard")) {
                return Err(BenchmarkError::new("validation", "Set the test difficulty to easy, medium or hard and publish it before starting new work"));
            }
        }
        Ok(())
    }

    pub async fn version(&self, id: &str) -> Result<BenchmarkVersion> {
        Ok(Arc::unwrap_or_clone(self.version_shared(id).await?))
    }

    /// A published version, its manifest parsed once: the small columns are
    /// read every time, and the cached copy is used while they all match.
    pub async fn version_shared(&self, id: &str) -> Result<Arc<BenchmarkVersion>> {
        let r=sqlx::query("SELECT definition_id,content_hash,published_at,carries_from FROM benchmark_versions WHERE id=?").bind(id).fetch_optional(&self.pool).await?.ok_or_else(||BenchmarkError::new("validation","Published version not found"))?;
        let (definition_id, content_hash, published_at, carries_from): (
            String,
            String,
            i64,
            Option<String>,
        ) = (r.get(0), r.get(1), r.get(2), r.get(3));
        let cached = self.parsed.versions.lock().unwrap().get(id).cloned();
        if let Some(version) = cached.filter(|v| {
            v.definition_id == definition_id
                && v.content_hash == content_hash
                && v.published_at == published_at
                && v.carries_from == carries_from
        }) {
            return Ok(version);
        }
        let manifest: String =
            sqlx::query_scalar("SELECT manifest_json FROM benchmark_versions WHERE id=?")
                .bind(id)
                .fetch_one(&self.pool)
                .await?;
        let version = Arc::new(BenchmarkVersion {
            id: id.into(),
            definition_id,
            content_hash,
            manifest: serde_json::from_str(&manifest)?,
            published_at,
            carries_from,
        });
        self.parsed
            .versions
            .lock()
            .unwrap()
            .insert(id.into(), version.clone());
        Ok(version)
    }

    /// The version that carries `id`'s cells now: the end of its chain of
    /// evaluator-only republications, or `id` itself.
    pub async fn carried_version(&self, id: &str) -> Result<BenchmarkVersion> {
        let mut current = id.to_owned();
        while let Some(next) = sqlx::query_scalar::<_, String>(
            "SELECT id FROM benchmark_versions WHERE carries_from=? ORDER BY published_at DESC LIMIT 1",
        )
        .bind(&current)
        .fetch_optional(&self.pool)
        .await?
        {
            current = next;
        }
        self.version(&current).await
    }
}
