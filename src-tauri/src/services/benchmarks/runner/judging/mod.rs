//! Judging: who may judge an answer, how a panel is seated and asked, and what
//! its votes settle.
use super::shared::*;
// What this system takes from the other two.
use super::engine::{
    account_pace, admission_window, diagnostics, exhaust_judge_on_quota, exhausted_until,
    judge_quota_stop, left_for_operator, mark_phase, pace_key, quota_reset, trusted_headroom, Seat,
    ACCOUNT_BUSY, ACCOUNT_SLOTS, EVALUATION_RETRY, QUOTA_RETRY_MS, SIGN_IN_WAIT,
};
use super::provider::{
    acknowledge_lane, consume_event, host_error, native_refusal, offered_efforts, profile_refusal,
    reconnect, repository_inventory_revision, text_inventory_revision, text_runtime_snapshot,
    unstarted_refusal, with_app_sign_in, CredentialWindow, ExecutionBackend, NativeBackend,
};

mod asking;
pub(in crate::services::benchmarks) mod checks;
mod discovery;
mod documents;
pub(in crate::services::benchmarks) mod frozen;
pub(super) mod judge_corrections;
pub(super) mod judge_recovery;
pub(super) mod judge_watchdog;
mod listings;
pub(super) mod ordinary_judging;
mod panel;
pub mod pool;
mod response;
mod seating;
mod service;
mod votes;
mod waiting;

pub use self::discovery::*;
pub(in crate::services::benchmarks) use self::waiting::*;
pub(crate) use self::{documents::*, seating::*, votes::*};
pub(super) use self::{listings::*, panel::*};

#[cfg(test)]
mod judge_availability_tests;
#[cfg(test)]
mod judge_discovery_diagnostics_tests;
#[cfg(test)]
mod judge_inventory_diagnostics_tests;
#[cfg(test)]
mod judge_quota_tests;
#[cfg(test)]
mod judge_scheduling_tests;
#[cfg(test)]
mod judge_selection_tests;
#[cfg(test)]
mod manual_judge_diagnostics_tests;
