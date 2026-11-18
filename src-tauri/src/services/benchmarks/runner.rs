use super::{
    analysis::{self, matches_selection},
    evaluation, fixtures, judge_checks,
    model_catalog::{concrete_model, model_identity},
    store::{now, Store},
    types::*,
    BenchmarkService,
};
use crate::services::{
    agent_host::{execution::*, repository_execution, text_execution, AgentHost},
    benchmark_sandbox as sandbox, credential_lease,
};
use futures_util::{future::BoxFuture, FutureExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    panic::AssertUnwindSafe,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::watch;

mod account_pace;
mod admission_window;
pub mod collection_context;
pub(super) mod diagnostics;
mod engine;
mod judge_corrections;
mod judge_recovery;
mod judge_watchdog;
mod judging;
pub(crate) mod native_receipt;
mod ordinary_judging;
mod preparation_watchdog;
mod provider;
pub(super) mod reconnect;

pub use self::{engine::*, judging::*, provider::*};

#[cfg(test)]
mod pipeline_tests;

#[cfg(test)]
mod reconciliation_tests;

#[cfg(test)]
mod execution_limits_tests;

#[cfg(test)]
mod quota_resource_tests;

#[cfg(test)]
mod judge_quota_tests;

#[cfg(test)]
mod judge_availability_tests;

#[cfg(test)]
mod judge_discovery_diagnostics_tests;
#[cfg(test)]
mod judge_inventory_diagnostics_tests;

#[cfg(test)]
mod manual_judge_diagnostics_tests;

#[cfg(test)]
mod carried_evaluation_tests;

#[cfg(test)]
mod judge_scheduling_tests;

#[cfg(test)]
mod judge_selection_tests;

#[cfg(test)]
mod evaluation_admission_tests;

#[cfg(test)]
mod recovery_evaluation_tests;

#[cfg(test)]
mod unstarted_admission_tests;

#[cfg(test)]
mod held_pass_tests;

#[cfg(test)]
mod evaluation_wait_tests;

#[cfg(test)]
mod infrastructure_retry_tests;

#[cfg(test)]
mod sign_in_renewal_tests;

#[cfg(test)]
mod collection_context_tests;

#[cfg(test)]
mod turn_seat_tests;

#[cfg(test)]
mod mixed_profile_tests;
#[cfg(test)]
mod run_faults_tests;

#[cfg(test)]
mod tests;
