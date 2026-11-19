//! Running a plan: the engine, judging and the provider side. Each system
//! names in its own module what it takes from the other two; what all three
//! take from outside the runner is `shared`.
/// What the three systems share from outside the runner.
mod shared {
    pub(super) use super::super::{
        analysis::{self, matches_selection},
        evaluation, fixtures, judge_checks,
        model_catalog::{concrete_model, model_identity},
        store::{now, Store},
        types::*,
        BenchmarkService,
    };
    pub(super) use crate::services::{
        agent_host::{execution::*, repository_execution, text_execution, AgentHost},
        benchmark_sandbox as sandbox, credential_lease,
    };
    pub(super) use futures_util::{future::BoxFuture, FutureExt};
    pub(super) use serde_json::{json, Value};
    pub(super) use sha2::{Digest, Sha256};
    pub(super) use std::{
        panic::AssertUnwindSafe,
        sync::Arc,
        time::{Duration, Instant},
    };
    pub(super) use tauri::Manager;
    pub(super) use tokio::sync::watch;
}
// The runner's own scenario tests read all of it.
#[cfg(test)]
use self::shared::*;

mod engine;
mod judging;
mod provider;

pub use self::{engine::*, judging::*, provider::*};

#[cfg(test)]
mod pipeline_tests;

#[cfg(test)]
mod mixed_profile_tests;
#[cfg(test)]
mod run_faults_tests;

#[cfg(test)]
mod tests;
