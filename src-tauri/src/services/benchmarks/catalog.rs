use super::{
    evaluation, fixtures,
    store::{event, now, Store},
    types::*,
};

pub fn validate(d: &BenchmarkDraft) -> ValidationReport {
    let mut issues = fixtures::validate(d);
    issues.extend(super::routing::validate_draft(d));
    issues.extend(super::workflow::validate(d));
    issues.extend(evaluation::validate(&d.evaluator));
    if d.schema_version != 1 {
        issues.push("Unsupported schema version".into());
    }
    for (name, v) in [
        ("Name", &d.name),
        ("Category", &d.category),
        ("Task family", &d.task_family),
        ("Prompt", &d.prompt),
        ("Source", &d.source),
        ("License", &d.license),
    ] {
        if v.trim().is_empty() {
            issues.push(format!("{name} is required"));
        }
    }
    if !["development", "train", "held_out"].contains(&d.split.as_str()) {
        issues.push("Invalid dataset split".into());
    }
    if !["native_text", "protected_repository", "isolated_ui"]
        .contains(&d.execution_profile.as_str())
    {
        issues.push("Invalid execution profile".into());
    }
    if !["task_metrics", "controlled_quota", "capacity"].contains(&d.measurement_profile.as_str()) {
        issues.push("Invalid measurement profile".into());
    }
    if d.permissions.context != "clean" {
        issues.push("Benchmark context must be clean".into());
    }
    if d.limits.timeout_seconds == 0
        || d.limits.timeout_seconds > super::MAX_TIME_LIMIT_SECONDS
        || d.limits.max_turns != 1
        || d.limits.max_artifact_bytes == 0
        || d.limits.max_artifact_bytes > 16 * 1024 * 1024
        || d.repetitions == 0
        || d.repetitions > 100
    {
        issues.push(format!(
            "Limits require 1–{} seconds, one turn, 1–16 MiB artifacts and 1–100 repetitions",
            super::MAX_TIME_LIMIT_SECONDS
        ));
    }
    if d.prompt.len() > 128 * 1024 {
        issues.push("Prompt exceeds 128 KiB".into());
    }
    if d.prompt.len()
        + d.fixtures
            .iter()
            .map(|f| f.content.len() + f.path.len() + 20)
            .sum::<usize>()
        > 256 * 1024
    {
        issues.push("Prompt and public fixtures exceed the 256 KiB native text limit".into());
    }
    ValidationReport {
        valid: issues.is_empty(),
        issues,
    }
}

impl Store {
    pub async fn save_draft(
        &self,
        id: Option<&str>,
        revision: Option<i64>,
        mut draft: BenchmarkDraft,
    ) -> Result<BenchmarkDefinition> {
        // Incomplete drafts are allowed, but imports still cannot carry execution actions or unsafe paths.
        super::routing::normalize_draft(&mut draft);
        let structural = fixtures::validate(&draft);
        if !structural.is_empty() {
            return Err(BenchmarkError::new("validation", structural.join("; ")));
        }
        if serde_json::to_vec(&draft)?.len() > 10 * 1024 * 1024 {
            return Err(BenchmarkError::new(
                "validation",
                "Definition exceeds 10 MiB",
            ));
        }
        let key = id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut tx = self.pool.begin().await?;
        if id.is_some() {
            let changed=sqlx::query("UPDATE benchmark_definitions SET draft_json=?,revision=revision+1 WHERE id=? AND revision=?").bind(serde_json::to_string(&draft)?).bind(&key).bind(revision.unwrap_or(-1)).execute(&mut *tx).await?.rows_affected();
            if changed != 1 {
                return Err(BenchmarkError::new(
                    "revision_conflict",
                    "Draft changed elsewhere; reload before saving",
                ));
            }
        } else {
            sqlx::query("INSERT INTO benchmark_definitions(id,draft_json,revision) VALUES(?,?,1)")
                .bind(&key)
                .bind(serde_json::to_string(&draft)?)
                .execute(&mut *tx)
                .await?;
        }
        event(&mut tx, &key, "definition_changed").await?;
        tx.commit().await?;
        self.definition(&key).await
    }
    pub async fn publish(&self, id: &str, revision: i64) -> Result<BenchmarkVersion> {
        let def = self.definition(id).await?;
        if def.draft_revision != revision {
            return Err(BenchmarkError::new(
                "revision_conflict",
                "Draft changed before publication",
            ));
        }
        let check = validate(&def.draft);
        if !check.valid {
            return Err(BenchmarkError::new("validation", check.issues.join("; ")));
        }
        if matches!(def.draft.evaluator.kind.as_str(), "javascript" | "browser") {
            let good = super::worker::evaluate(&def.draft, &def.draft.evaluator.known_good).await?;
            let bad = super::worker::evaluate(&def.draft, &def.draft.evaluator.known_bad).await?;
            if good.verdict != "pass" || bad.verdict != "fail" {
                return Err(BenchmarkError::new("validation","Protected evaluator must accept its known-good and reject its known-bad reference"));
            }
        }
        let hash = fixtures::publish_blob(&self.root, &def.draft).await?;
        let mut tx = self.pool.begin().await?;
        let current =
            sqlx::query_scalar::<_, i64>("SELECT revision FROM benchmark_definitions WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if current != revision {
            return Err(BenchmarkError::new(
                "revision_conflict",
                "Draft changed during publication",
            ));
        }
        let cross_split:i64=sqlx::query_scalar("SELECT COUNT(*) FROM benchmark_versions WHERE json_extract(manifest_json,'$.taskFamily')=? AND json_extract(manifest_json,'$.split')!=?").bind(&def.draft.task_family).bind(&def.draft.split).fetch_one(&mut *tx).await?;
        if cross_split != 0 {
            return Err(BenchmarkError::new(
                "validation",
                "A task family cannot cross dataset splits",
            ));
        }
        let existing = sqlx::query_scalar::<_, String>(
            "SELECT id FROM benchmark_versions WHERE definition_id=? AND content_hash=?",
        )
        .bind(id)
        .bind(&hash)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(key) = existing {
            // The pool takes a definition's newest version, so content an older
            // version holds cannot become current again; only the current
            // version republishes.
            let superseded = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM benchmark_versions newer JOIN benchmark_versions found ON found.definition_id=newer.definition_id WHERE found.id=? AND newer.published_at>found.published_at",
            )
            .bind(&key)
            .fetch_one(&mut *tx)
            .await?;
            if superseded != 0 {
                return Err(BenchmarkError::new(
                    "validation",
                    "This draft matches an earlier published version; change it before publishing it again",
                ));
            }
            tx.commit().await?;
            return self.version(&key).await;
        }
        let v = BenchmarkVersion {
            id: uuid::Uuid::new_v4().to_string(),
            definition_id: id.into(),
            content_hash: hash,
            published_at: now(),
            manifest: def.draft,
        };
        sqlx::query("INSERT INTO benchmark_versions(id,definition_id,content_hash,manifest_json,published_at) VALUES(?,?,?,?,?)").bind(&v.id).bind(id).bind(&v.content_hash).bind(serde_json::to_string(&v.manifest)?).bind(v.published_at).execute(&mut *tx).await?;
        event(&mut tx, id, "version_published").await?;
        tx.commit().await?;
        Ok(v)
    }
    pub async fn archive(&self, id: &str, archived: bool) -> Result<BenchmarkDefinition> {
        let mut tx = self.pool.begin().await?;
        let at = now();
        // A restore keeps the period it ends, so a dated pool inside it never
        // owes the definition; a later archive starts a new period. An archive
        // older than its recorded time starts where `analysis::pool` puts it:
        // after the last non-preview run that planned one of its versions, or
        // at the start of time when none did.
        if !archived {
            sqlx::query(
                "INSERT INTO benchmark_definition_archives(definition_id,archived_at,restored_at)
                 SELECT d.id,COALESCE(d.archived_at,
                    (SELECT MAX(r.updated_at)+1 FROM run_plans r
                     JOIN json_each(r.request_json,'$.versionIds') planned
                     JOIN benchmark_versions v ON v.id=planned.value
                     WHERE v.definition_id=d.id
                        AND COALESCE(json_extract(r.request_json,'$.preview'),0)=0),
                    0),?
                 FROM benchmark_definitions d WHERE d.id=? AND d.archived=1",
            )
            .bind(at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        // Dated pools retire a definition from its first archive time on.
        sqlx::query("UPDATE benchmark_definitions SET archived=?,archived_at=CASE WHEN ? THEN COALESCE(archived_at,?) ELSE NULL END,revision=revision+1 WHERE id=?")
            .bind(archived)
            .bind(archived)
            .bind(at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, id, "definition_changed").await?;
        tx.commit().await?;
        self.definition(id).await
    }
    pub async fn duplicate(&self, id: &str) -> Result<BenchmarkDefinition> {
        let mut draft = self.definition(id).await?.draft;
        draft.name = format!("{} (copy)", draft.name);
        self.save_draft(None, None, draft).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn archiving_records_the_first_archive_time() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        assert_eq!(definition.archived_at, None);
        let archived = store.archive(&definition.id, true).await.unwrap();
        let at = archived.archived_at.expect("archive time recorded");
        assert!(archived.archived);
        // Archiving again keeps the first time; the listing reads it too.
        sqlx::query("UPDATE benchmark_definitions SET archived_at=? WHERE id=?")
            .bind(at - 100)
            .bind(&definition.id)
            .execute(&store.pool)
            .await
            .unwrap();
        let again = store.archive(&definition.id, true).await.unwrap();
        assert_eq!(again.archived_at, Some(at - 100));
        let listed = store.definitions().await.unwrap();
        assert_eq!(listed[0].archived_at, Some(at - 100));
        let restored = store.archive(&definition.id, false).await.unwrap();
        assert!(!restored.archived);
        assert_eq!(restored.archived_at, None);
        // The restore keeps the period it ended; a second archive opens another.
        let [(from, until)] = restored.archive_history[..] else {
            panic!("one closed period: {:?}", restored.archive_history);
        };
        assert_eq!(from, at - 100);
        assert!(until >= at);
        let again = store.archive(&definition.id, true).await.unwrap();
        assert!(again.archived_at.is_some_and(|start| start >= until));
        let twice = store.archive(&definition.id, false).await.unwrap();
        assert_eq!(twice.archive_history.len(), 2);
        assert_eq!(twice.archive_history[0], (from, until));
        // Restoring a live definition records nothing.
        let live = store.archive(&definition.id, false).await.unwrap();
        assert_eq!(live.archive_history.len(), 2);
    }
    /// The catalog and runs as the evidence queries read them.
    async fn query_data(store: &Store) -> QueryData {
        let definitions = store.all_definitions().await.unwrap();
        QueryData {
            versions: definitions
                .iter()
                .flat_map(|d| d.versions.clone())
                .collect(),
            definitions,
            runs: store.all_runs().await.unwrap(),
            attempts: vec![],
            required_repetitions: 1,
        }
    }
    fn pooled(data: &QueryData, as_of: Option<i64>, version: &str) -> bool {
        super::super::analysis::pool(
            data,
            &ResultQuery {
                as_of,
                ..Default::default()
            },
        )
        .iter()
        .any(|v| v.id == version)
    }
    #[tokio::test]
    async fn restoring_an_archive_older_than_its_recorded_time_keeps_its_period() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let mut versions = Vec::new();
        for task_family in ["planned", "unplanned"] {
            let mut draft = super::super::runner::seed_definitions().remove(0);
            draft.task_family = task_family.into();
            let definition = store.save_draft(None, None, draft).await.unwrap();
            versions.push(store.publish(&definition.id, 1).await.unwrap());
        }
        let [planned, unplanned] = &versions[..] else {
            unreachable!()
        };
        sqlx::query("UPDATE benchmark_versions SET published_at=10")
            .execute(&store.pool)
            .await
            .unwrap();
        // One run planned the first case and last changed at 1000; a preview
        // run changed later and does not count.
        for (id, updated_at, preview) in [("run", 1000, false), ("preview", 5000, true)] {
            let request = serde_json::json!({"requestKey":id,"versionIds":[planned.id],"configurations":[],"repetitions":1,"timeoutSeconds":30,"maxExecutions":1,"preview":preview});
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,0,?,?)")
                .bind(id)
                .bind(id)
                .bind(updated_at)
                .bind(request.to_string())
                .execute(&store.pool)
                .await
                .unwrap();
        }
        // Both were archived before the archive time was recorded.
        sqlx::query("UPDATE benchmark_definitions SET archived=1,archived_at=NULL")
            .execute(&store.pool)
            .await
            .unwrap();
        let before = query_data(&store).await;
        assert!(pooled(&before, Some(1000), &planned.id));
        assert!(!pooled(&before, Some(2000), &planned.id));
        assert!(!pooled(&before, Some(2000), &unplanned.id));
        for version in &versions {
            let restored = store.archive(&version.definition_id, false).await.unwrap();
            let [(from, until)] = restored.archive_history[..] else {
                panic!("one closed period: {:?}", restored.archive_history);
            };
            assert_eq!(from, if version.id == planned.id { 1001 } else { 0 });
            assert!(until > 5000);
        }
        // The restore changes no earlier dated pool; the current one owes both.
        let after = query_data(&store).await;
        assert!(pooled(&after, Some(1000), &planned.id));
        assert!(!pooled(&after, Some(2000), &planned.id));
        assert!(!pooled(&after, Some(2000), &unplanned.id));
        assert!(pooled(&after, None, &planned.id));
        assert!(pooled(&after, None, &unplanned.id));
    }
    #[tokio::test]
    async fn content_of_an_earlier_version_cannot_republish_as_current() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let draft = super::super::runner::seed_definitions().remove(0);
        let definition = store.save_draft(None, None, draft.clone()).await.unwrap();
        let first = store.publish(&definition.id, 1).await.unwrap();
        sqlx::query("UPDATE benchmark_versions SET published_at=1 WHERE id=?")
            .bind(&first.id)
            .execute(&store.pool)
            .await
            .unwrap();
        let mut changed = draft.clone();
        changed.prompt.push_str(" Use compact JSON.");
        store
            .save_draft(Some(&definition.id), Some(1), changed)
            .await
            .unwrap();
        let second = store.publish(&definition.id, 2).await.unwrap();
        // Reverting the draft reports that the pool would keep the newer version.
        store
            .save_draft(Some(&definition.id), Some(2), draft)
            .await
            .unwrap();
        assert_eq!(
            store.publish(&definition.id, 3).await.unwrap_err().code,
            "validation"
        );
        let data = query_data(&store).await;
        assert!(pooled(&data, None, &second.id));
        assert!(!pooled(&data, None, &first.id));
        // The current version still republishes as itself.
        let current = store.definition(&definition.id).await.unwrap();
        let mut again = current.draft.clone();
        again.prompt.push_str(" Use compact JSON.");
        store
            .save_draft(Some(&definition.id), Some(current.draft_revision), again)
            .await
            .unwrap();
        assert_eq!(
            store.publish(&definition.id, 4).await.unwrap().id,
            second.id
        );
    }
    #[tokio::test]
    async fn entry_state_hash_tracks_actual_public_fixture_contents() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let mut draft = super::super::seeds::definitions().remove(0);
        draft.fixtures = vec![Fixture {
            path: "source.txt".into(),
            content: "first public state".into(),
        }];
        draft.entry_state = Some(EntryState {
            schema_version: 1,
            root_task_id: "authored-task".into(),
            step_id: "continuation".into(),
            parent_step_id: None,
            fixture_snapshot_hash: "untrusted authored hash".into(),
            conversation_prefix: "Visible context".into(),
            previous_reports: vec![],
            remaining_budget_seconds: 30,
            content_hash: "untrusted content hash".into(),
        });
        let first = store.save_draft(None, None, draft.clone()).await.unwrap();
        let first_entry = first.draft.entry_state.as_ref().unwrap();
        assert_eq!(
            first_entry.fixture_snapshot_hash,
            fixtures::hash(&serde_json::to_vec(&draft.fixtures).unwrap())
        );
        assert_eq!(
            first_entry.content_hash,
            super::super::routing::entry_hash(first_entry)
        );
        draft.fixtures[0].content = "changed public state".into();
        let changed = store
            .save_draft(Some(&first.id), Some(first.draft_revision), draft)
            .await
            .unwrap();
        let changed_entry = changed.draft.entry_state.unwrap();
        assert_ne!(
            first_entry.fixture_snapshot_hash,
            changed_entry.fixture_snapshot_hash
        );
        assert_ne!(first_entry.content_hash, changed_entry.content_hash);
    }
    #[tokio::test]
    async fn drafts_conflict_and_publication_is_immutable() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let draft = super::super::runner::seed_definitions().remove(0);
        let d = store.save_draft(None, None, draft.clone()).await.unwrap();
        let original = store.publish(&d.id, 1).await.unwrap();
        assert_eq!(original.id, store.publish(&d.id, 1).await.unwrap().id);
        let mut changed = draft;
        changed.prompt.push_str(" Use compact JSON.");
        store
            .save_draft(Some(&d.id), Some(1), changed.clone())
            .await
            .unwrap();
        assert_eq!(
            store
                .save_draft(Some(&d.id), Some(1), changed)
                .await
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        let later = store.publish(&d.id, 2).await.unwrap();
        assert_ne!(original.content_hash, later.content_hash);
        assert_eq!(
            store.version(&original.id).await.unwrap().manifest.prompt,
            original.manifest.prompt
        );
        store.archive(&d.id, true).await.unwrap();
        assert!(store.version(&original.id).await.is_ok());
    }
    #[tokio::test]
    async fn interrupted_blob_has_no_published_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let draft = super::super::runner::seed_definitions().remove(0);
        let d = store.save_draft(None, None, draft.clone()).await.unwrap();
        let hash = fixtures::publish_blob(&store.root, &draft).await.unwrap();
        assert!(store.versions_for(&d.id).await.unwrap().is_empty());
        let v = store.publish(&d.id, 1).await.unwrap();
        assert_eq!(v.content_hash, hash);
        tokio::fs::write(
            store.root.join("versions").join(hash).join("manifest.json"),
            "tampered",
        )
        .await
        .unwrap();
        assert!(
            fixtures::verify_blob(&store.root, &v.content_hash, &v.manifest)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn split_leakage_and_traversal_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let mut draft = super::super::runner::seed_definitions().remove(0);
        let d = store.save_draft(None, None, draft.clone()).await.unwrap();
        store.publish(&d.id, 1).await.unwrap();
        draft.split = "held_out".into();
        let second = store.save_draft(None, None, draft.clone()).await.unwrap();
        assert!(store.publish(&second.id, 1).await.is_err());
        draft.fixtures.push(Fixture {
            path: "../hidden".into(),
            content: "x".into(),
        });
        assert!(store.save_draft(None, None, draft).await.is_err());
    }
}
