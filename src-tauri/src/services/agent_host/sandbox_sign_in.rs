//! When the host renews the sandbox sign-in of an account, and what waits for
//! it.
//!
//! Every benchmark session in the sandbox starts on a private copy of its
//! account's sign-in, and admission keeps each one inside the lifetime of
//! that copy. A renewal replaces the account's grant and its refresh token,
//! so it runs only while no session of the account is alive, and no session
//! of the account starts while it runs. While running sessions keep a renewal
//! waiting, new tests of the account wait as well, so the account drains
//! instead of a test with a shorter time limit starting after every one that
//! finishes; later steps of a workflow already running finish first.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::RwLock;

/// What a renewal asked for an account does now.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    /// The grant lasts as long as asked, and no renewal is waiting.
    Covered,
    /// Sessions of the account still run on the grant: the request waits.
    Wait,
    /// No session of the account is alive: renew now.
    Renew,
}

#[derive(Default)]
struct Account {
    /// Shared by every session start of the account, held alone by a renewal.
    gate: Arc<RwLock<()>>,
    /// The expiry of the grant a renewal waits to replace, while it waits.
    due: Option<i64>,
    /// The last renewal that failed: the grant it tried to replace, when,
    /// and what its callers were told.
    failure: Option<Failure>,
}

struct Failure {
    expiry: i64,
    at: i64,
    message: String,
}

/// Renewal state of every account, by account route key.
#[derive(Default)]
pub(super) struct SignInRenewals {
    accounts: Mutex<HashMap<String, Account>>,
}

impl SignInRenewals {
    fn with<T>(&self, key: &str, f: impl FnOnce(&mut Account) -> T) -> T {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f(accounts.entry(key.to_owned()).or_default())
    }

    /// The gate of `key`: a session start of the account holds it shared
    /// until its process has copied the grant; a renewal holds it alone from
    /// its check of live sessions until the renewed grant is saved.
    pub(super) fn gate(&self, key: &str) -> Arc<RwLock<()>> {
        self.with(key, |account| Arc::clone(&account.gate))
    }

    /// Whether a renewal of `key` waits for its running sessions to end.
    pub(super) fn is_due(&self, key: &str) -> bool {
        self.with(key, |account| account.due.is_some())
    }

    /// What a renewal asked of `key` does, for a grant that expires at
    /// `expiry`, asked to last until `until_ms`, while `live_sessions` of the
    /// account are alive; records the wait (see [`step`]).
    pub(super) fn step(&self, key: &str, expiry: i64, until_ms: i64, live_sessions: usize) -> Step {
        self.with(key, |account| {
            step(&mut account.due, expiry, until_ms, live_sessions)
        })
    }

    /// The renewal of `key` ran, whatever its result: nothing waits for it.
    pub(super) fn settle(&self, key: &str) {
        self.with(key, |account| account.due = None);
    }

    /// The renewal of `key`, for a grant that expires at `expiry`, could not
    /// start yet (no sandbox lane was free): sessions of the account keep
    /// waiting for it.
    pub(super) fn defer(&self, key: &str, expiry: i64) {
        self.with(key, |account| account.due = Some(expiry));
    }

    /// What a renewal of `key`'s grant that expires at `expiry` failed with,
    /// when it failed less than `retry_ms` before `now`: that grant is not
    /// renewed again yet. A new sign-in is another grant and renews at once.
    pub(super) fn recent_failure(
        &self,
        key: &str,
        expiry: i64,
        now: i64,
        retry_ms: i64,
    ) -> Option<String> {
        self.with(key, |account| {
            account
                .failure
                .as_ref()
                .filter(|failure| failure.expiry == expiry && now - failure.at < retry_ms)
                .map(|failure| failure.message.clone())
        })
    }

    /// Records that the renewal of `key`'s grant that expires at `expiry`
    /// failed at `now` with `message`; whether this grant had not failed
    /// before (what is worth a warning).
    pub(super) fn fail(&self, key: &str, expiry: i64, now: i64, message: &str) -> bool {
        self.with(key, |account| {
            let news = account
                .failure
                .as_ref()
                .is_none_or(|failure| failure.expiry != expiry);
            account.failure = Some(Failure {
                expiry,
                at: now,
                message: message.to_owned(),
            });
            news
        })
    }

    /// A renewal of `key` succeeded: no failure holds it back any more.
    pub(super) fn clear_failure(&self, key: &str) {
        self.with(key, |account| account.failure = None);
    }
}

/// What a renewal asked for a grant that expires at `expiry` does, asked to
/// last until `until_ms` while `live_sessions` of its account are alive.
/// `due` is the expiry of the grant an earlier request waits to renew. A grant
/// that expires later than that one was renewed since, by another renewal or
/// a new sign-in, and the wait ends.
fn step(due: &mut Option<i64>, expiry: i64, until_ms: i64, live_sessions: usize) -> Step {
    if due.is_some_and(|waiting| expiry > waiting) {
        *due = None;
    }
    if due.is_none() && expiry > until_ms {
        return Step::Covered;
    }
    if live_sessions > 0 {
        *due = Some(expiry);
        return Step::Wait;
    }
    Step::Renew
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPIRY: i64 = 1_800_000_000_000;

    #[test]
    fn a_grant_that_lasts_needs_no_renewal() {
        let mut due = None;
        assert_eq!(step(&mut due, EXPIRY, EXPIRY - 1, 3), Step::Covered);
        assert_eq!(due, None);
    }

    #[test]
    fn a_short_grant_renews_only_once_no_session_of_the_account_is_alive() {
        let mut due = None;
        assert_eq!(step(&mut due, EXPIRY, EXPIRY, 2), Step::Wait);
        assert_eq!(due, Some(EXPIRY));
        assert_eq!(step(&mut due, EXPIRY, EXPIRY + 1, 1), Step::Wait);
        assert_eq!(step(&mut due, EXPIRY, EXPIRY + 1, 0), Step::Renew);
        // An expired grant is renewed the same way.
        assert_eq!(step(&mut None, EXPIRY, EXPIRY + 10, 0), Step::Renew);
    }

    /// A session whose own shorter limit the grant still covers waits too
    /// while a renewal is due, so the account drains.
    #[test]
    fn while_a_renewal_waits_a_covered_session_waits_as_well() {
        let mut due = Some(EXPIRY);
        assert_eq!(step(&mut due, EXPIRY, EXPIRY - 3_600_000, 1), Step::Wait);
        assert_eq!(step(&mut due, EXPIRY, EXPIRY - 3_600_000, 0), Step::Renew);
    }

    /// A grant renewed elsewhere ends the wait; one that still falls short
    /// starts a new one.
    #[test]
    fn a_grant_renewed_since_ends_the_wait() {
        let mut due = Some(EXPIRY);
        assert_eq!(
            step(&mut due, EXPIRY + 21_600_000, EXPIRY + 1, 4),
            Step::Covered
        );
        assert_eq!(due, None);
        let mut due = Some(EXPIRY);
        assert_eq!(
            step(&mut due, EXPIRY + 60_000, EXPIRY + 120_000, 1),
            Step::Wait
        );
        assert_eq!(due, Some(EXPIRY + 60_000));
    }

    #[test]
    fn the_state_of_one_account_never_holds_another() {
        let renewals = SignInRenewals::default();
        assert_eq!(renewals.step("grok\u{1f}a", EXPIRY, EXPIRY, 1), Step::Wait);
        assert!(renewals.is_due("grok\u{1f}a"));
        assert!(!renewals.is_due("grok\u{1f}b"));
        assert!(!Arc::ptr_eq(
            &renewals.gate("grok\u{1f}a"),
            &renewals.gate("grok\u{1f}b")
        ));
        assert!(Arc::ptr_eq(
            &renewals.gate("grok\u{1f}a"),
            &renewals.gate("grok\u{1f}a")
        ));
        renewals.settle("grok\u{1f}a");
        assert!(!renewals.is_due("grok\u{1f}a"));
        // A renewal that found no free lane keeps the account waiting, and
        // runs with the next request once no session is alive.
        renewals.defer("grok\u{1f}a", EXPIRY);
        assert!(renewals.is_due("grok\u{1f}a"));
        assert_eq!(
            renewals.step("grok\u{1f}a", EXPIRY, EXPIRY - 1, 0),
            Step::Renew
        );
    }

    /// A renewal holds the gate alone: a session start waits for it, and a
    /// renewal waits for a session start already past its check.
    #[tokio::test]
    async fn a_renewal_and_a_session_start_exclude_each_other() {
        let renewals = SignInRenewals::default();
        let gate = renewals.gate("grok\u{1f}a");
        let starting = Arc::clone(&gate).read_owned().await;
        assert!(gate.try_write().is_err());
        drop(starting);
        let renewing = gate.try_write().unwrap();
        assert!(gate.try_read().is_err());
        drop(renewing);
        assert!(gate.try_read().is_ok());
    }
}
