//! The engine of a run: seats and pace, the scheduler, one attempt from start
//! to settle, what a failed try means, waits, and recovery.
use super::shared::*;
// What this system takes from the other two.
use super::judging::{
    judge_discovery_waiting, judge_document, judge_policy_waiting, judge_quota_waiting,
    judge_watchdog, judging_deferred, rubric_criteria, text_judged, JudgeStop, JUDGING_STOPPED,
};
use super::provider::{collection_budget, unsigned_deadline, unstarted_refusal, TurnCapture};

pub(super) mod account_pace;
pub(super) mod admission_window;
mod attempt;
pub mod collection_context;
pub(in crate::services::benchmarks) mod diagnostics;
mod failure;
mod learned;
mod measure_again;
mod pace;
pub(super) mod preparation_watchdog;
mod recovery;
mod schedule;
mod seats;
mod settle;
mod steps;
mod stop;
mod waits;

pub(in crate::services::benchmarks) use self::{attempt::*, failure::*, waits::*};
pub(super) use self::{measure_again::*, pace::*, stop::*};
pub use self::{seats::*, settle::*};

#[cfg(test)]
mod carried_evaluation_tests;
#[cfg(test)]
mod collection_context_tests;
#[cfg(test)]
mod evaluation_admission_tests;
#[cfg(test)]
mod evaluation_wait_tests;
#[cfg(test)]
mod execution_limits_tests;
#[cfg(test)]
mod held_pass_tests;
#[cfg(test)]
mod infrastructure_retry_tests;
#[cfg(test)]
mod quota_resource_tests;
#[cfg(test)]
mod recovery_evaluation_tests;
#[cfg(test)]
mod sign_in_renewal_tests;
#[cfg(test)]
mod turn_seat_tests;
#[cfg(test)]
mod unstarted_admission_tests;
