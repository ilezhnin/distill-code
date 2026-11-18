//! When a run waits for its operator. A cell that fails keeps the failure to
//! itself: it waits, settles, or is left for the operator
//! ([`leave_for_operator`]) while the run goes on with its other cells. The
//! run stops only for a cause that is its own, or once nothing of it can go
//! on; every such stop is a [`Stop`] and goes through
//! [`BenchmarkService::stop_for_operator`]. Two stops are not a failure's and
//! stay with their owners: a restart of the app (`Store::recover`) and a
//! judge queue that stalled once nothing else of the run can go on
//! (`judge_watchdog::check_queue`, a pause).
use super::*;

/// Why a run stops for its operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in super::super) enum Stop {
    /// The store could not keep what the run measures.
    Storage,
    /// The provider refused the run's selection from its first cell on.
    SelectionRefused,
    /// The run's time to dispatch is over.
    DispatchDeadline,
    /// Cells were lost in a row to a cause that is not their own (see
    /// [`lost_cells_limit`]).
    CellsLost,
    /// Nothing of the run can go on by itself, and cells of it are left for
    /// the operator.
    NothingCanGoOn,
}

impl Stop {
    fn words(self) -> &'static str {
        match self {
            Self::Storage => "the store could not keep its results",
            Self::SelectionRefused => "the provider refused its selection from the first test on",
            Self::DispatchDeadline => "its time to dispatch is over",
            Self::CellsLost => "tests in a row were lost to a failure that is not their own",
            Self::NothingCanGoOn => "the tests left need the operator, and nothing else can go on",
        }
    }
}

/// How many cells in a row, with none measured between them, a run loses to
/// a failure that is not the model's answer before the cause reads as the
/// run's own. A run that measures a lost cell again by itself or on resume
/// affords a few; a run that forbids retries loses each one for good, so the
/// first one stops it.
pub(in super::super) fn lost_cells_limit(request: &RunRequest) -> u32 {
    if request.automatic_retry() {
        INFRASTRUCTURE_STREAK
    } else {
        1
    }
}

impl BenchmarkService {
    /// The one place a run stops for its operator.
    pub(in super::super) async fn stop_for_operator(&self, run_id: &str, why: Stop) -> Result<()> {
        log::warn!(
            "[benchmarks] run {run_id} waits for the operator: {}",
            why.words()
        );
        self.store.set_run_state(run_id, "needs_attention").await
    }

    /// A cell of `run` sent on `scope` (see [`quota_scope`]) settled lost:
    /// the run stops once as many in a row were as it affords.
    pub(in super::super) async fn cell_lost(&self, run: &BenchmarkRun, scope: &str) -> Result<()> {
        if infrastructure_streak(&run.id, scope, true) >= lost_cells_limit(&run.request) {
            self.stop_for_operator(&run.id, Stop::CellsLost).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;

    #[tokio::test]
    async fn a_run_stops_once_it_lost_as_many_cells_in_a_row_as_it_affords() {
        let (dir, s, _) = setup().await;
        let run = s.start_run(serial_request(&s).await).await.unwrap();
        let scope = quota_scope(&run.attempts[0].configuration);
        let state = || async { s.store.run_state(&run.id).await.unwrap() };
        for _ in 1..INFRASTRUCTURE_STREAK {
            s.cell_lost(&run, &scope).await.unwrap();
        }
        assert_eq!(state().await, "running");
        // A turn that settled otherwise ends the row.
        infrastructure_streak(&run.id, &scope, false);
        s.cell_lost(&run, &scope).await.unwrap();
        assert_eq!(state().await, "running");
        for _ in 1..INFRASTRUCTURE_STREAK {
            s.cell_lost(&run, &scope).await.unwrap();
        }
        assert_eq!(state().await, "needs_attention");
        dir.close().await;
    }

    #[tokio::test]
    async fn a_run_that_forbids_retries_stops_at_the_first_cell_it_lost() {
        let (dir, s, _) = setup().await;
        let mut request = serial_request(&s).await;
        request.execution_limits = Some(RunExecutionLimits {
            retry_policy: RunRetryPolicy::None,
            dispatch_not_after_ms: None,
        });
        let run = s.start_run(request).await.unwrap();
        let scope = quota_scope(&run.attempts[0].configuration);
        s.cell_lost(&run, &scope).await.unwrap();
        assert_eq!(s.store.run_state(&run.id).await.unwrap(), "needs_attention");
        dir.close().await;
    }
}
