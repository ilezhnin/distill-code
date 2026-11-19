//! Judging: who may judge an answer, how a panel is seated and asked, and what
//! its votes settle.
use super::*;

mod asking;
mod discovery;
mod documents;
pub(super) mod judge_corrections;
pub(super) mod judge_recovery;
pub(super) mod judge_watchdog;
mod listings;
pub(super) mod ordinary_judging;
mod panel;
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
