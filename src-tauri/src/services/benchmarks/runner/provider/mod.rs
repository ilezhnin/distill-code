//! The provider side of a run: the backend port, its native implementation
//! (sessions, owned turns, what a turn captured and how it ended) and the test
//! double.
use super::shared::*;
// What this system takes from the other two.
use super::engine::{
    admission_window, collection_context, dispatch_key, evaluate, hold_provider_until,
    is_quota_wait, keep_sealed, mark_phase, refused_for_quota, sign_in_admitted, stopped_for_quota,
    turn_owner, ACCOUNT_BUSY, NO_PROVIDER_START, QUOTA_WAIT, SESSION_LOST,
    SESSION_LOST_BEFORE_ANSWER, SIGN_IN_WAIT, SIGN_IN_WAIT_REASON,
};
use super::judging::{
    by_headroom, in_flight, judge_watchdog, ordinary_judging, qualification_carrier,
    requires_browser_runtime, settle_interrupted_judge, JudgeEvidence, JudgeStop, RunInventories,
    JUDGES_BUSY, JUDGE_POLICY_RENEWAL, JUDGING_STOPPED, RENDERER_BUSY,
};
// The faults of the test double speak in the words of judging.
#[cfg(test)]
use super::judging::judge_quota_wait;
#[cfg(test)]
use super::judging::JUDGE_ADMISSION_WAIT;

mod backend;
mod capture;
mod collection;
mod credentials;
mod execution;
mod fake;
mod native;
pub(crate) mod native_receipt;
mod outcome;
mod owned_turns;
pub(in crate::services::benchmarks) mod reconnect;

pub use self::{backend::*, fake::*, native::*};
pub(super) use self::{capture::*, collection::*, credentials::*};
pub(crate) use self::{outcome::*, owned_turns::*};

#[cfg(test)]
mod reconciliation_tests;
