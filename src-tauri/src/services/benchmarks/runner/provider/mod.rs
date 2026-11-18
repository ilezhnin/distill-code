//! The provider side of a run: the backend port, its native implementation
//! (sessions, owned turns, what a turn captured and how it ended) and the test
//! double.
use super::*;

mod backend;
mod capture;
mod collection;
mod credentials;
mod execution;
mod fake;
mod native;
mod outcome;
mod owned_turns;

pub use self::{backend::*, fake::*, native::*};
pub(super) use self::{capture::*, collection::*, credentials::*};
pub(crate) use self::{outcome::*, owned_turns::*};
