//! Initial native repository input for explicitly opted-in standalone collection.
//! The attempt owns its immutable input; the existing budget row owns its clock.
use super::super::{artifact_context, fixtures, repository, store::Store, types::*};
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub schema_version: u32,
    pub attempt_id: String,
    pub run_id: String,
    pub version_id: String,
    pub version_content_hash: String,
    pub manifest_hash: String,
    pub timeout_seconds: u32,
    pub budget: artifact_context::BudgetLease,
    pub repository: artifact_context::Input,
    pub content_hash: String,
}

fn invalid(message: &str) -> BenchmarkError {
    BenchmarkError::new("collection_context_conflict", message)
}

fn enabled(version: &BenchmarkVersion) -> bool {
    version.manifest.environment["nativeRepositoryRecipe"].as_str()
        == Some(repository::ARTIFACT_RECIPE)
}

fn binding(attempt: &Attempt, version: &BenchmarkVersion, timeout: u32) -> Result<String> {
    Ok(fixtures::hash(&serde_json::to_vec(&(
        "standalone-repository-input-v1",
        &attempt.id,
        &attempt.run_id,
        &version.id,
        &version.content_hash,
        &version.manifest,
        timeout,
    ))?))
}

impl Context {
    fn hash(&self) -> Result<String> {
        let mut context = self.clone();
        context.content_hash.clear();
        Ok(fixtures::hash(&serde_json::to_vec(&context)?))
    }

    pub(super) fn new(
        attempt: &Attempt,
        version: &BenchmarkVersion,
        timeout: u32,
        budget: artifact_context::BudgetLease,
        input: artifact_context::Input,
    ) -> Result<Self> {
        let mut context = Self {
            schema_version: 1,
            attempt_id: attempt.id.clone(),
            run_id: attempt.run_id.clone(),
            version_id: version.id.clone(),
            version_content_hash: version.content_hash.clone(),
            manifest_hash: fixtures::hash(&serde_json::to_vec(&version.manifest)?),
            timeout_seconds: timeout,
            budget,
            repository: input,
            content_hash: String::new(),
        };
        context.content_hash = context.hash()?;
        Ok(context)
    }

    async fn verify(
        &self,
        store: &Store,
        attempt: &Attempt,
        version: &BenchmarkVersion,
    ) -> Result<()> {
        let snapshot = repository::snapshot(&version.manifest)?;
        let before = &self.repository.before;
        let digest =
            |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        if self.schema_version != 1
            || self.content_hash != self.hash()?
            || self.attempt_id != attempt.id
            || self.run_id != attempt.run_id
            || self.version_id != version.id
            || self.version_content_hash != version.content_hash
            || self.manifest_hash != fixtures::hash(&serde_json::to_vec(&version.manifest)?)
            || self.timeout_seconds != self.budget.root_cap_seconds
            || self.timeout_seconds != self.budget.step_cap_seconds
            || self.budget.root_id != attempt.id
            || self.budget.step_key != format!("collection:{}", attempt.id)
            || self.budget.recipe != artifact_context::CLOCK_RECIPE
            || self.repository.access_all
            || !self.repository.lineage.is_empty()
            || before.recipe != repository::ARTIFACT_RECIPE
            || before.root_tree != snapshot.tree
            || before.before_tree != snapshot.tree
            || before.after_tree != snapshot.tree
            || !before.patch.is_empty()
            || before.patch_hash != fixtures::hash(b"")
            || !digest(&before.archive_hash)
        {
            return Err(invalid("Frozen standalone collection input changed"));
        }
        // Recovery may inspect a terminal turn after expiry. Read and compare
        // the original clock without granting another execution allowance.
        if store.native_budget(&self.budget.step_key).await?.as_ref() != Some(&self.budget) {
            return Err(invalid("Standalone collection budget authority changed"));
        }
        let row = sqlx::query(
            "SELECT input_hash,consent_hash FROM task_budget_bindings WHERE request_key=?",
        )
        .bind(&self.budget.step_key)
        .fetch_one(&store.pool)
        .await?;
        if row.try_get::<String, _>("input_hash")?
            != binding(attempt, version, self.timeout_seconds)?
            || row.try_get::<String, _>("consent_hash")? != version.content_hash
        {
            return Err(invalid("Standalone collection budget binding changed"));
        }
        Ok(())
    }

    fn project(&self, mut version: BenchmarkVersion) -> Result<BenchmarkVersion> {
        version.manifest.environment[artifact_context::CLOCK_KEY] =
            serde_json::to_value(&self.budget)?;
        version.manifest.environment[artifact_context::INPUT_KEY] =
            serde_json::to_value(&self.repository)?;
        Ok(version)
    }
}

pub(super) async fn reserve(
    store: &Store,
    attempt: &Attempt,
    version: &BenchmarkVersion,
    timeout: u32,
) -> Result<artifact_context::BudgetLease> {
    let key = format!("collection:{}", attempt.id);
    let saved = store.native_budget(&key).await?;
    let origin = saved.as_ref().map_or_else(
        || attempt.started_at.unwrap_or_else(super::now),
        |budget| budget.root_started_at_ms,
    );
    let root = artifact_context::BudgetLease {
        recipe: artifact_context::CLOCK_RECIPE.into(),
        root_id: attempt.id.clone(),
        root_started_at_ms: origin,
        root_cap_seconds: timeout,
        step_key: key.clone(),
        step_started_at_ms: origin,
        step_cap_seconds: timeout,
    };
    store
        .reserve_task_budget(
            &key,
            &binding(attempt, version, timeout)?,
            &version.content_hash,
            Some(&root),
            timeout,
            timeout,
            &attempt.id,
        )
        .await
}

pub(super) async fn prepare(
    store: &Store,
    attempt: &mut Attempt,
    version: BenchmarkVersion,
    timeout: u32,
) -> Result<BenchmarkVersion> {
    if !enabled(&version) || version.manifest.workflow.is_some() {
        return Ok(version);
    }
    // Workflow children already own a separately committed native context.
    let child: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_steps WHERE attempt_id=?")
        .bind(&attempt.id)
        .fetch_one(&store.pool)
        .await?;
    if child != 0 {
        return Ok(version);
    }
    if version.manifest.execution_profile != "protected_repository"
        || !repository::is_repository_case(&version.manifest)
        || version.manifest.entry_state.is_none()
        || version.manifest.environment["nativeBudgetRecipe"].as_str()
            != Some(artifact_context::CLOCK_RECIPE)
        || version
            .manifest
            .environment
            .get(artifact_context::CLOCK_KEY)
            .is_some()
        || version
            .manifest
            .environment
            .get(artifact_context::INPUT_KEY)
            .is_some()
    {
        return Err(invalid(
            "Standalone collection requires a declared native repository contract",
        ));
    }
    let timeout = super::effective_timeout_seconds(timeout, &version.manifest);
    if let Some(context) = &attempt.collection_context {
        context.verify(store, attempt, &version).await?;
        if context.timeout_seconds != timeout {
            return Err(invalid(
                "Standalone collection cannot change its frozen budget",
            ));
        }
        reserve(store, attempt, &version, timeout).await?;
        return context.project(version);
    }
    if attempt.session_id.is_some() || attempt.host_run_id.is_some() {
        return Err(invalid(
            "Started standalone collection has no frozen native input",
        ));
    }
    let budget = reserve(store, attempt, &version, timeout).await?;
    let snapshot = repository::snapshot(&version.manifest)?;
    let prepared = repository::advance_until(
        &snapshot,
        &[],
        false,
        version.manifest.limits.max_artifact_bytes as usize,
        super::unsigned_deadline(budget.deadline_at_ms()?)?,
    )
    .await?;
    let context = Context::new(
        attempt,
        &version,
        timeout,
        budget,
        artifact_context::Input {
            before: prepared.artifact,
            lineage: vec![],
            access_all: false,
        },
    )?;
    context.verify(store, attempt, &version).await?;
    attempt.collection_context = Some(context.clone());
    store.save_attempt(attempt).await?;
    context.project(version)
}

pub(in crate::services::benchmarks) async fn recover(
    store: &Store,
    attempt: &Attempt,
    version: BenchmarkVersion,
) -> Result<BenchmarkVersion> {
    if !enabled(&version) {
        if attempt.collection_context.is_some() {
            return Err(invalid(
                "Native collection input belongs to an opted-in version",
            ));
        }
        return Ok(version);
    }
    let context = attempt.collection_context.as_ref().ok_or_else(|| {
        invalid("Standalone repository recovery requires its frozen native input")
    })?;
    context.verify(store, attempt, &version).await?;
    context.project(version)
}
