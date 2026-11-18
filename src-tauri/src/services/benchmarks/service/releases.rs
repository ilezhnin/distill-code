//! Releases, schedules and the seed definitions.
use super::*;

impl BenchmarkService {
    /// Freezes every live training/evaluation test's newest published version,
    /// named `name` or the next `vN`. A release that would repeat the newest
    /// one is refused: nothing in the pool changed.
    pub async fn create_release(&self, name: Option<String>) -> Result<PoolRelease> {
        let data = self.query_data().await?;
        let version_ids: Vec<String> = analysis::live_versions(&data, None)
            .into_iter()
            .filter(|version| analysis::is_ranked_split(&version.manifest.split))
            .map(|version| version.id.clone())
            .collect();
        if version_ids.is_empty() {
            return Err(BenchmarkError::new(
                "validation",
                "Publish a training or held-out test before releasing the pool",
            ));
        }
        if let Some(newest) = analysis::release_at(&data, None) {
            // A version that only re-evaluates a frozen one is no change.
            let carried = analysis::carried_versions(&data.versions);
            let mut frozen: Vec<String> = newest
                .version_ids
                .iter()
                .map(|id| carried.get(id).unwrap_or(id).clone())
                .collect();
            frozen.sort();
            if frozen == version_ids {
                return Err(BenchmarkError::new(
                    "validation",
                    format!("The pool has not changed since {}", newest.name),
                ));
            }
        }
        let name = name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("v{}", data.releases.len() + 1));
        if name.chars().count() > 40 || data.releases.iter().any(|r| r.name == name) {
            return Err(BenchmarkError::new(
                "validation",
                "A release needs a new name of at most 40 characters",
            ));
        }
        let release = PoolRelease {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            created_at: now(),
            version_ids,
        };
        self.store.save_release(&release).await?;
        self.changed().await;
        Ok(release)
    }

    pub async fn save_schedule(&self, mut schedule: Schedule) -> Result<Schedule> {
        campaigns::validate(&schedule)?;
        if let Some(existing) = self
            .store
            .schedules()
            .await?
            .iter()
            .find(|s| s.id == schedule.id)
        {
            schedule.generated_run_ids = existing.generated_run_ids.clone();
        }
        if schedule.id.is_empty() {
            schedule.id = uuid::Uuid::new_v4().to_string();
        }
        if schedule.name.trim().is_empty()
            || schedule.interval_minutes < 5
            || schedule.interval_minutes > 525600
        {
            return Err(BenchmarkError::new(
                "validation",
                "Schedule requires a name and an interval of 5 minutes to one year",
            ));
        }
        let preview = self.preview_run(&schedule.request).await?;
        if !preview.valid {
            return Err(BenchmarkError::new("validation", preview.issues.join("; ")));
        }
        if schedule.enabled && schedule.next_due_at < now() {
            return Err(BenchmarkError::new(
                "validation",
                "Select a future due time; missed work is not replayed",
            ));
        }
        campaigns::save_user_edit(self, &mut schedule).await?;
        self.wake.notify_one();
        Ok(schedule)
    }

    pub(in super::super) async fn seed(&self) -> Result<()> {
        if self.store.has_definitions().await? {
            return Ok(());
        }
        for draft in seeds::definitions() {
            let protected = matches!(draft.evaluator.kind.as_str(), "javascript" | "browser");
            let def = self.store.save_draft(None, None, draft).await?;
            if !protected || worker::available() {
                self.store.publish(&def.id, def.draft_revision).await?;
            }
        }
        Ok(())
    }
}
