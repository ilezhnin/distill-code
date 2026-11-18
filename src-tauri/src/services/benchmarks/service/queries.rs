//! What the app reads: the change notice and the page data.
use super::*;

impl BenchmarkService {
    pub async fn changed(&self) {
        notify_changed(&self.store, self.app.as_ref()).await;
    }

    /// What every analysis reads. Views asking at once share one load, and
    /// none overlaps another (see [`flights::Flights`]).
    pub async fn query_data(&self) -> Result<Arc<QueryData>> {
        self.queries
            .share("query-data", || self.load_query_data())
            .await
    }

    pub(in super::super) async fn load_query_data(&self) -> Result<QueryData> {
        // Analyses read a definition's archive state only; its draft stays in
        // the store, and published manifests come parsed from the store.
        let definitions = self.store.definition_states().await?;
        let versions = self.store.all_versions().await?;
        let mut runs = self.store.all_runs().await?;
        // A mixed-worker trajectory is not a measurement of its root column
        // or of any one of its workers. Raw run/attempt views retain it.
        runs.retain(|run| run.request.workflow_policy.is_none());
        // A cost the provider left out is its tokens at the list prices of the
        // day, so every board and the model page price every provider alike.
        let catalog = self.store.catalog_entries().await?;
        for attempt in runs.iter_mut().flat_map(|run| run.attempts.iter_mut()) {
            attempt.usage.cost = model_catalog::attempt_cost(
                &catalog,
                &attempt.configuration,
                &attempt.usage,
                attempt.finished_at.or(attempt.started_at),
            );
        }
        // Cells of a version an evaluator-only republication replaced are the
        // carrying version's cells in every analysis; the store keeps them
        // where they ran.
        let carried = analysis::carried_versions(&versions);
        if !carried.is_empty() {
            for run in &mut runs {
                for id in &mut run.request.version_ids {
                    if let Some(to) = carried.get(id) {
                        id.clone_from(to);
                    }
                }
                for attempt in &mut run.attempts {
                    if let Some(to) = carried.get(&attempt.version_id) {
                        attempt.version_id.clone_from(to);
                    }
                }
            }
        }
        let attempts = runs.iter().flat_map(|r| r.attempts.clone()).collect();
        let releases = self.store.releases().await?;
        // Every analysis reads this data, so a measurement of an unknown
        // effort is left out of all of them alike, and an attempt its event
        // record stopped is unscored in all of them alike; the store keeps
        // both as they settled.
        Ok(evidence::with_answer_caps(effort::with_known_effort(
            QueryData {
                releases,
                definitions,
                versions,
                runs,
                attempts,
                required_repetitions: analysis::REQUIRED_REPETITIONS,
            },
        )))
    }
}
