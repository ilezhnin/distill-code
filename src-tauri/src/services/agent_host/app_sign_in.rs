//! Renewals of the app's own sign-ins, the only ones a benchmark uses.
//!
//! Benchmark sessions in the sandbox run on leases of the app's sign-in
//! (see `credential_lease`), and the app is the only process that refreshes
//! a grant. A renewal asks the provider for a new grant on Windows, in the
//! account's own home, through the provider's own CLI:
//!
//! - outside the CLI's own renewal window it is forced (Claude: a sign-in
//!   from the stored refresh token; Codex: its account read with refresh;
//!   Grok: a process whose window covers what is left of the grant);
//! - inside that window, or once the grant expired, the CLI's own refresh
//!   is asked for (Claude: its usage read), the way every CLI of the app
//!   would refresh it on its next request.
//!
//! A renewal runs only while no lease of the account is alive: a refresh
//! may revoke the access token every live lease carries. Until then the
//! account drains (see [`super::sandbox_sign_in`]), and a lease is never
//! staged while a renewal runs. The keep-alive asks for a renewal well
//! before a grant expires, so a quiet night never leaves a dead sign-in.
//!
//! A drain admits nothing new until the account's longest test ends, so a
//! grant is also renewed ahead of need, while nothing runs on it (see
//! [`half_spent`]): a run then starts on a whole grant, not on the rest of
//! one that drains its account an hour later.
use super::{
    execution::NativeProvider,
    sandbox_sign_in::{SignInRenewals, Step},
};
use crate::services::credential_lease;
use futures_util::future::BoxFuture;

/// Why a test waits while its account drains for a renewal.
pub(crate) const APP_SIGN_IN_DRAIN: &str = "the Flock sign-in of this account renews once the tests running on it finish; this test starts then";

/// Why a test waits while a chat or CLI of its account keeps its sign-in
/// from being renewed.
pub(crate) const APP_SIGN_IN_HELD: &str = "the Flock sign-in this test needs is renewed once the chats and CLIs running on that account stop; this test starts then";

const APP_SIGN_IN_CHANGING: &str =
    "the account's sign-in is being updated; this test waits for the update to finish";

fn changing(error: &str) -> Option<String> {
    use crate::services::provider_accounts::{ACCOUNT_CHANGE_BUSY, AUTHORIZATION_CHANGING};
    matches!(error, ACCOUNT_CHANGE_BUSY | AUTHORIZATION_CHANGING)
        .then(|| format!("sign_in_wait: {APP_SIGN_IN_CHANGING}"))
}

/// How long after a failed renewal of the same grant the next one may run:
/// a refused refresh token is not retried by every admission.
const RETRY_AFTER_FAILURE_MS: i64 = 15 * 60_000;

/// How far ahead the keep-alive asks every grant to last: it renews a grant
/// this long before its CLI's own window, whether or not a session runs.
/// Why a test waits when the grant its lease would come from no longer lasts
/// for it at the start: its next try renews the grant first.
pub(crate) const APP_SIGN_IN_SHORT: &str =
    "the Flock sign-in this test runs on is renewed before it starts";

pub(crate) const KEEPALIVE_LEAD_MS: i64 = 30 * 60_000;

/// When the keep-alive first looks, after the host starts: soon, so a renewal
/// a stopped app cut short is settled and a grant near its end renewed.
pub(crate) const KEEPALIVE_FIRST_PASS: std::time::Duration = std::time::Duration::from_secs(30);

/// How often the keep-alive looks at every app sign-in.
pub(crate) const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Who asks for a grant to last, which decides what its renewal may cost
/// them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Asker {
    /// A later step of work already running: it goes on while its grant
    /// lasts, whatever waits for a renewal.
    Running,
    /// New work: it waits as well while the account drains for a renewal.
    New,
    /// A run's new test: as [`Asker::New`], and a grant past half of the
    /// time it admits such a test for is renewed first, while nothing runs
    /// on it (see [`half_spent`]).
    Test,
}

/// What a renewal needs from the app, its account and the provider. Tests
/// replace it to drive the real control flow.
pub(super) trait RenewalIo: Send {
    /// When the app's grant expires: `None` for one that does not expire,
    /// an error for a sign-in that is missing or unreadable.
    fn expiry(&mut self) -> Result<Option<i64>, String>;
    /// How many leases of the account are alive.
    fn live_leases(&mut self) -> BoxFuture<'_, usize>;
    /// Asks the provider for a new grant: with `natural`, the way the CLI
    /// refreshes inside its own window; otherwise forced.
    fn renew(&mut self, natural: bool) -> BoxFuture<'_, Result<(), String>>;
    /// How many chats or CLI processes of the app may hold the account's
    /// refresh token in memory: a forced renewal waits for none.
    fn other_holders(&mut self) -> BoxFuture<'_, usize>;
    /// After a renewal: retire the app's idle chat processes of the account,
    /// which may still hold the refresh token the renewal replaced.
    fn renewed(&mut self) -> BoxFuture<'_, ()>;
    /// The same idle-process cleanup before a forced renewal: an unowned
    /// inventory process must not count as an active refresh-token holder.
    /// The host's cleanup keeps attached chats, requests and borrowed bridges.
    fn retire_idle_holders(&mut self) -> BoxFuture<'_, ()> {
        self.renewed()
    }
    fn now(&self) -> i64;
}

/// Makes the app's grant of `provider`'s account `key` last until `until_ms`
/// for a lease (see [`credential_lease::covers`]), renewing it when it does
/// not, and returns its expiry. The caller holds the account's renewal gate
/// alone. Errors: `sign_in_wait:` while leases of the account are alive or
/// a renewal waits for them; `capability_missing:` for a sign-in that is
/// missing, unreadable, or that the provider would not renew.
pub(super) async fn ensure(
    renewals: &SignInRenewals,
    key: &str,
    provider: NativeProvider,
    until_ms: i64,
    asker: Asker,
    io: &mut impl RenewalIo,
) -> Result<Option<i64>, String> {
    let expiry = io.expiry().map_err(|error| {
        changing(&error).unwrap_or_else(|| format!("capability_missing: {error}"))
    })?;
    let Some(expiry) = expiry else {
        renewals.settle(key);
        return Ok(None);
    };
    let needed = credential_lease::required_expiry(provider, until_ms);
    let lasts = expiry >= needed;
    // A later step of work already running needs only a grant that lasts;
    // new work also waits while the account drains for a renewal.
    if asker == Asker::Running && lasts {
        return Ok(Some(expiry));
    }
    // A renewal of this grant failed a moment ago: the account does not
    // drain for another try, and what the grant still covers goes on.
    if let Some(error) = renewals.recent_failure(key, expiry, io.now(), RETRY_AFTER_FAILURE_MS) {
        renewals.settle(key);
        return if lasts { Ok(Some(expiry)) } else { Err(error) };
    }
    // A test no fresh grant could cover is refused before any renewal: a
    // rotation would not help it.
    if !lasts
        && credential_lease::fresh_lifetime_ms(provider)
            .is_some_and(|lifetime| needed.saturating_sub(io.now()) > lifetime)
    {
        renewals.settle(key);
        return Err(format!(
            "capability_missing: This test may run longer than a {} sign-in lasts; choose a shorter time limit",
            provider.key()
        ));
    }
    let natural = io.now() >= expiry.saturating_sub(credential_lease::natural_window_ms(provider));
    // agy refreshes an expired Google grant when its account is read.
    // It has no command to rotate a still-valid grant ahead of schedule.
    if provider == NativeProvider::Antigravity && !natural {
        return if lasts {
            Ok(Some(expiry))
        } else {
            Err("sign_in_wait: Waiting for Antigravity CLI to renew its Google sign-in before this test starts".into())
        };
    }
    // A forced renewal rotates the refresh token; a chat or CLI of the
    // account that still holds the old one could replay it. Whether each CLI
    // reads its store again before it refreshes is not verified, so a forced
    // renewal waits until none of them runs. A renewal in the CLI's own window
    // is the refresh every CLI of the account would make anyway.
    // Checked before the drain: a renewal that cannot run yet must not make
    // the account drain for it.
    if !natural && !lasts {
        io.retire_idle_holders().await;
        let others = io.other_holders().await;
        if others > 0 {
            renewals.settle(key);
            log::info!(
                "[agent-host] the Flock {} sign-in of {key} renews once its {others} chat or CLI process(es) stop",
                provider.key()
            );
            return Err(format!("sign_in_wait: {APP_SIGN_IN_HELD}"));
        }
    }
    let live = io.live_leases().await;
    // Nothing waits for this renewal, so it never makes a test wait or fail:
    // a holder, a refusal or a grant that came back no newer leaves the test
    // on the grant it has, and that grant is not tried again.
    let ahead = asker == Asker::Test
        && lasts
        && live == 0
        && half_spent(provider, expiry, needed, io.now())
        && !renewals.failed_for(key, expiry);
    if !ahead {
        match renewals.step(key, expiry, needed, live) {
            Step::Covered => return Ok(Some(expiry)),
            Step::Wait => return Err(format!("sign_in_wait: {APP_SIGN_IN_DRAIN}")),
            Step::Renew => {}
        }
    }
    // A grant that still lasts renews only for a drain other waiters asked
    // for; that renewal waits for the same holders, and the drain ends.
    if !natural && lasts {
        io.retire_idle_holders().await;
        if io.other_holders().await > 0 {
            renewals.settle(key);
            return Ok(Some(expiry));
        }
    }
    log::info!(
        "[agent-host] renewing the Flock {} sign-in of {key}{}",
        provider.key(),
        if natural {
            " (in its own window)"
        } else if ahead {
            " (ahead of need, while nothing runs on it)"
        } else {
            ""
        }
    );
    let result = io.renew(natural).await;
    renewals.settle(key);
    let kept = |error: String| if ahead { Ok(Some(expiry)) } else { Err(error) };
    let after = match result.and_then(|()| io.expiry()) {
        Ok(after) => after,
        Err(error) => {
            // Contention is not a refused refresh token and must not poison
            // this grant's renewal cache for fifteen minutes.
            if let Some(wait) = changing(&error) {
                return kept(wait);
            }
            return kept(failed(renewals, key, provider, expiry, io.now(), &error));
        }
    };
    if after.is_some_and(|after| after <= expiry) {
        return kept(failed(
            renewals,
            key,
            provider,
            expiry,
            io.now(),
            "the provider returned no newer grant",
        ));
    }
    renewals.clear_failure(key);
    if let Some(after) = after {
        credential_lease::record_fresh_lifetime(provider, after.saturating_sub(io.now()));
    }
    io.renewed().await;
    log::info!(
        "[agent-host] Flock {} sign-in of {key} renewed",
        provider.key()
    );
    if !credential_lease::covers(provider, after, until_ms) {
        return Err(format!(
            "capability_missing: The renewed {} sign-in does not last as long as this test may run",
            provider.key()
        ));
    }
    Ok(after)
}

/// Whether the grant that expires at `expiry` is past half of the time a
/// fresh one admits a test that needs it until `needed`. A Grok grant lasts
/// six hours and admits a test for its first 3 h 44 min; a run that began 2
/// h 45 min into one sent tests for 45 minutes and then drained its account
/// for over an hour (11-18).
fn half_spent(provider: NativeProvider, expiry: i64, needed: i64, now: i64) -> bool {
    let Some(lifetime) = credential_lease::fresh_lifetime_ms(provider) else {
        return false;
    };
    let admits = lifetime.saturating_sub(needed.saturating_sub(now));
    admits > 0 && expiry.saturating_sub(needed) < admits / 2
}

fn failed(
    renewals: &SignInRenewals,
    key: &str,
    provider: NativeProvider,
    expiry: i64,
    now: i64,
    error: &str,
) -> String {
    let message = format!(
        "capability_missing: The Flock {} sign-in was not renewed ({error}); the grant is kept. If it stays refused, sign in again in Settings > AI providers",
        provider.key()
    );
    if renewals.fail(key, expiry, now, &message) {
        log::warn!("[agent-host] {key}: {message}");
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;
    const KEY: &str = "claude-acp\u{1f}invented";

    /// A scripted account: the grant it holds, the grant a successful
    /// renewal leaves, its live leases, and what each renewal did.
    struct Scripted {
        grant: Result<Option<i64>, String>,
        renewed_grant: Option<i64>,
        leases: usize,
        holders: usize,
        idle_holders: usize,
        renewals: Vec<bool>,
        outcome: Result<(), String>,
        retired: usize,
        now: i64,
    }

    impl Scripted {
        fn new(grant: Option<i64>, renewed_grant: Option<i64>) -> Self {
            Self {
                grant: Ok(grant),
                renewed_grant,
                leases: 0,
                holders: 0,
                idle_holders: 0,
                renewals: Vec::new(),
                outcome: Ok(()),
                retired: 0,
                now: NOW,
            }
        }
    }

    impl RenewalIo for Scripted {
        fn expiry(&mut self) -> Result<Option<i64>, String> {
            self.grant.clone()
        }
        fn live_leases(&mut self) -> BoxFuture<'_, usize> {
            Box::pin(async move { self.leases })
        }
        fn other_holders(&mut self) -> BoxFuture<'_, usize> {
            Box::pin(async move { self.holders + self.idle_holders })
        }
        fn renew(&mut self, natural: bool) -> BoxFuture<'_, Result<(), String>> {
            self.renewals.push(natural);
            if self.outcome.is_ok() {
                if let Some(renewed) = self.renewed_grant {
                    self.grant = Ok(Some(renewed));
                }
            }
            Box::pin(async move { self.outcome.clone() })
        }
        fn renewed(&mut self) -> BoxFuture<'_, ()> {
            self.retired += 1;
            self.idle_holders = 0;
            Box::pin(async {})
        }
        fn now(&self) -> i64 {
            self.now
        }
    }

    #[tokio::test]
    async fn antigravity_waits_for_a_due_grant_then_checks_the_refreshed_expiry() {
        let renewals = SignInRenewals::default();
        let renewed = NOW + HOUR + 60_000;
        let mut io = Scripted::new(Some(NOW + 60_000), Some(renewed));
        let needed = NOW + 600_000;
        let provider = NativeProvider::Antigravity;
        let short = ensure(
            &renewals,
            "antigravity",
            provider,
            needed,
            Asker::Test,
            &mut io,
        )
        .await
        .unwrap_err();
        assert!(short.starts_with("sign_in_wait:"));
        assert!(io.renewals.is_empty());
        io.now += 60_000;
        assert_eq!(
            ensure(
                &renewals,
                "antigravity",
                provider,
                needed,
                Asker::Test,
                &mut io
            )
            .await,
            Ok(Some(renewed))
        );
        assert_eq!(io.renewals, [true]);
    }

    #[tokio::test]
    async fn a_grant_that_lasts_is_not_renewed() {
        let renewals = SignInRenewals::default();
        let mut io = Scripted::new(Some(NOW + 8 * HOUR), None);
        let expiry = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + HOUR,
            Asker::New,
            &mut io,
        )
        .await
        .unwrap();
        assert_eq!(expiry, Some(NOW + 8 * HOUR));
        assert!(io.renewals.is_empty());
        // A key that does not expire never renews.
        let mut key = Scripted::new(None, None);
        assert_eq!(
            ensure(
                &renewals,
                "zai",
                NativeProvider::Zai,
                i64::MAX,
                Asker::New,
                &mut key
            )
            .await,
            Ok(None)
        );
        assert!(key.renewals.is_empty());
    }

    /// A short grant is forced outside the CLI's own window, and renewed
    /// the CLI's own way inside it or once expired.
    #[tokio::test]
    async fn a_renewal_inside_the_natural_window_is_the_clis_own() {
        let renewals = SignInRenewals::default();
        let mut early = Scripted::new(Some(NOW + HOUR), Some(NOW + 8 * HOUR));
        let expiry = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + 2 * HOUR,
            Asker::New,
            &mut early,
        )
        .await
        .unwrap();
        assert_eq!(expiry, Some(NOW + 8 * HOUR));
        assert_eq!(early.renewals, [false]);
        assert_eq!(early.retired, 2);
        for left in [credential_lease::CLAUDE_RENEWAL_WINDOW_MS, 0, -HOUR] {
            let mut late = Scripted::new(Some(NOW + left), Some(NOW + 8 * HOUR));
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                Asker::New,
                &mut late,
            )
            .await
            .unwrap();
            assert_eq!(late.renewals, [true], "{left}");
        }
    }

    /// While leases of the account are alive the renewal waits, and so does
    /// every new admission, until the account drained.
    #[tokio::test]
    async fn a_renewal_drains_live_leases_first() {
        let renewals = SignInRenewals::default();
        let mut busy = Scripted::new(Some(NOW + HOUR), Some(NOW + 8 * HOUR));
        busy.leases = 2;
        let error = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + 2 * HOUR,
            Asker::New,
            &mut busy,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("sign_in_wait:"), "{error}");
        assert!(busy.renewals.is_empty());
        assert!(renewals.is_due(KEY));
        // A short test the grant still covers waits as well.
        assert!(ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW,
            Asker::New,
            &mut busy
        )
        .await
        .unwrap_err()
        .starts_with("sign_in_wait:"));
        // A later step of work already running goes on while its grant lasts.
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                Asker::Running,
                &mut busy
            )
            .await,
            Ok(Some(NOW + HOUR))
        );
        assert!(renewals.is_due(KEY));
        busy.leases = 0;
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                Asker::New,
                &mut busy
            )
            .await,
            Ok(Some(NOW + 8 * HOUR))
        );
        assert_eq!(busy.renewals, [false]);
        assert!(!renewals.is_due(KEY));
    }

    /// A failed renewal keeps the grant and is not retried by every
    /// admission; a new sign-in (another grant) is tried at once.
    #[tokio::test]
    async fn a_failed_renewal_keeps_the_grant_and_backs_off() {
        let renewals = SignInRenewals::default();
        let mut refused = Scripted::new(Some(NOW + HOUR), Some(NOW + 8 * HOUR));
        refused.outcome = Err("invented refusal".into());
        let until = NOW + 2 * HOUR;
        let error = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            until,
            Asker::New,
            &mut refused,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("capability_missing:"), "{error}");
        assert!(error.contains("invented refusal") && error.contains("kept"));
        assert_eq!(refused.grant, Ok(Some(NOW + HOUR)));
        // Only the pre-renewal idle cleanup ran; no grant was replaced.
        assert_eq!(refused.retired, 1);
        let again = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            until,
            Asker::New,
            &mut refused,
        )
        .await
        .unwrap_err();
        assert_eq!(again, error);
        assert_eq!(refused.renewals.len(), 1);
        assert!(!renewals.is_due(KEY));
        refused.now = NOW + RETRY_AFTER_FAILURE_MS;
        let _ = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            until,
            Asker::New,
            &mut refused,
        )
        .await;
        assert_eq!(refused.renewals.len(), 2);
        // A grant that came back no longer is a failure too.
        let renewals = SignInRenewals::default();
        let mut stale = Scripted::new(Some(NOW + HOUR), None);
        assert!(ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            until,
            Asker::New,
            &mut stale
        )
        .await
        .unwrap_err()
        .contains("no newer grant"));
        // Another grant than the one that failed is renewed at once.
        let mut signed_in_again = Scripted::new(Some(NOW + HOUR + 1), Some(NOW + 8 * HOUR));
        assert!(ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            until,
            Asker::New,
            &mut signed_in_again
        )
        .await
        .is_ok());
        assert_eq!(signed_in_again.renewals, [false]);
    }

    #[tokio::test]
    async fn a_missing_sign_in_is_a_missing_capability() {
        let renewals = SignInRenewals::default();
        let mut missing = Scripted::new(None, None);
        missing.grant = Err("not signed in".to_owned());
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                Asker::New,
                &mut missing
            )
            .await,
            Err("capability_missing: not signed in".into())
        );
        assert!(missing.renewals.is_empty());
    }

    #[tokio::test]
    async fn an_account_change_waits_without_caching_a_failed_grant() {
        use crate::services::provider_accounts::{ACCOUNT_CHANGE_BUSY, AUTHORIZATION_CHANGING};
        for message in [ACCOUNT_CHANGE_BUSY, AUTHORIZATION_CHANGING] {
            let renewals = SignInRenewals::default();
            let mut io = Scripted::new(Some(NOW + HOUR), Some(NOW + 8 * HOUR));
            io.outcome = Err(message.into());
            let result = ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW + 2 * HOUR,
                Asker::New,
                &mut io,
            )
            .await;
            assert_eq!(result, Err(format!("sign_in_wait: {APP_SIGN_IN_CHANGING}")));
            assert!(renewals
                .recent_failure(KEY, NOW + HOUR, NOW, RETRY_AFTER_FAILURE_MS)
                .is_none());
            io.outcome = Ok(());
            assert_eq!(
                ensure(
                    &renewals,
                    KEY,
                    NativeProvider::Claude,
                    NOW + 2 * HOUR,
                    Asker::New,
                    &mut io
                )
                .await,
                Ok(Some(NOW + 8 * HOUR))
            );
            assert_eq!(io.renewals.len(), 2);
        }
        let renewals = SignInRenewals::default();
        let mut io = Scripted::new(None, None);
        io.grant = Err(AUTHORIZATION_CHANGING.into());
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                Asker::New,
                &mut io
            )
            .await,
            Err(format!("sign_in_wait: {APP_SIGN_IN_CHANGING}"))
        );
        assert!(io.renewals.is_empty());
    }

    #[tokio::test]
    async fn a_forced_renewal_releases_idle_probes_but_waits_for_active_holders() {
        for active in [0, 1] {
            let renewals = SignInRenewals::default();
            let mut io = Scripted::new(Some(NOW + HOUR), Some(NOW + 8 * HOUR));
            io.idle_holders = 1;
            io.holders = active;
            let result = ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW + 2 * HOUR,
                Asker::New,
                &mut io,
            )
            .await;
            assert_eq!(io.idle_holders, 0);
            assert_eq!(io.holders, active);
            if active == 0 {
                assert_eq!(result, Ok(Some(NOW + 8 * HOUR)));
                assert_eq!(io.renewals, [false]);
            } else {
                assert_eq!(result, Err(format!("sign_in_wait: {APP_SIGN_IN_HELD}")));
                assert!(io.renewals.is_empty());
            }
        }
    }

    /// The keep-alive's horizon renews a grant before its CLI's own window,
    /// with no session alive.
    #[tokio::test]
    async fn the_keep_alive_renews_before_the_natural_window() {
        let renewals = SignInRenewals::default();
        let expiry = NOW + KEEPALIVE_LEAD_MS + credential_lease::CLAUDE_RENEWAL_WINDOW_MS;
        let mut idle = Scripted::new(Some(expiry), Some(NOW + 8 * HOUR));
        ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + KEEPALIVE_LEAD_MS,
            Asker::New,
            &mut idle,
        )
        .await
        .unwrap();
        assert_eq!(idle.renewals, [false]);
    }
    /// A run's new test on an idle account has a grant past half of its
    /// admitting time renewed first; nothing else asks for that, and it
    /// never costs the test anything.
    #[tokio::test]
    async fn a_half_spent_grant_is_renewed_for_a_test_while_nothing_runs_on_it() {
        // A fresh Grok grant lasts six hours; this one has three left and
        // the test needs one.
        const GROK: &str = "grok-acp\u{1f}invented";
        async fn asked(asker: Asker, io: &mut Scripted) -> Result<Option<i64>, String> {
            let renewals = SignInRenewals::default();
            ensure(&renewals, GROK, NativeProvider::Grok, NOW + HOUR, asker, io).await
        }
        let mut idle = Scripted::new(Some(NOW + 3 * HOUR), Some(NOW + 6 * HOUR));
        assert_eq!(
            asked(Asker::Test, &mut idle).await,
            Ok(Some(NOW + 6 * HOUR))
        );
        assert_eq!(idle.renewals, [false]);
        // The whole grant it left is not renewed again.
        assert_eq!(
            asked(Asker::Test, &mut idle).await,
            Ok(Some(NOW + 6 * HOUR))
        );
        assert_eq!(idle.renewals.len(), 1);
        // A listing, a judge or the keep-alive never asks for it, and a test
        // does not while a lease of the account is alive.
        let mut other = Scripted::new(Some(NOW + 3 * HOUR), Some(NOW + 6 * HOUR));
        assert_eq!(
            asked(Asker::New, &mut other).await,
            Ok(Some(NOW + 3 * HOUR))
        );
        other.leases = 1;
        assert_eq!(
            asked(Asker::Test, &mut other).await,
            Ok(Some(NOW + 3 * HOUR))
        );
        assert!(other.renewals.is_empty());
        // A chat or CLI that holds the sign-in keeps the grant as it is.
        let mut held = Scripted::new(Some(NOW + 3 * HOUR), Some(NOW + 6 * HOUR));
        held.holders = 1;
        assert_eq!(
            asked(Asker::Test, &mut held).await,
            Ok(Some(NOW + 3 * HOUR))
        );
        assert!(held.renewals.is_empty());
    }

    /// A renewal ahead of need that the provider refuses leaves the test on
    /// the grant it has, and is not tried on that grant again.
    #[tokio::test]
    async fn a_refused_renewal_ahead_of_need_costs_the_test_nothing() {
        const GROK: &str = "grok-acp\u{1f}invented";
        let renewals = SignInRenewals::default();
        let mut refused = Scripted::new(Some(NOW + 3 * HOUR), None);
        refused.outcome = Err("invented refusal".into());
        for _ in 0..2 {
            assert_eq!(
                ensure(
                    &renewals,
                    GROK,
                    NativeProvider::Grok,
                    NOW + HOUR,
                    Asker::Test,
                    &mut refused
                )
                .await,
                Ok(Some(NOW + 3 * HOUR))
            );
        }
        assert_eq!(refused.renewals.len(), 1);
        // Long after, the same grant is still left alone.
        refused.now = NOW + HOUR / 2;
        assert_eq!(
            ensure(
                &renewals,
                GROK,
                NativeProvider::Grok,
                NOW + HOUR,
                Asker::Test,
                &mut refused
            )
            .await,
            Ok(Some(NOW + 3 * HOUR))
        );
        assert_eq!(refused.renewals.len(), 1);
    }

    /// A failed renewal does not make the account drain again: what the
    /// grant still covers goes on, and the keep-alive sets no wait.
    #[tokio::test]
    async fn a_recent_failure_neither_drains_nor_blocks_covered_tests() {
        let renewals = SignInRenewals::default();
        let mut refused = Scripted::new(Some(NOW + HOUR), None);
        refused.outcome = Err("invented refusal".into());
        assert!(ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + 2 * HOUR,
            Asker::New,
            &mut refused
        )
        .await
        .is_err());
        refused.leases = 3;
        // The keep-alive asks again: no wait is recorded.
        assert!(ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + 2 * HOUR,
            Asker::New,
            &mut refused
        )
        .await
        .unwrap_err()
        .starts_with("capability_missing:"));
        assert!(!renewals.is_due(KEY));
        // A short test the grant covers starts.
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                Asker::New,
                &mut refused
            )
            .await,
            Ok(Some(NOW + HOUR))
        );
        assert_eq!(refused.renewals.len(), 1);
    }

    /// A test longer than any fresh grant is refused without a rotation.
    #[tokio::test]
    async fn a_test_no_fresh_grant_covers_is_refused_without_renewing() {
        let renewals = SignInRenewals::default();
        let mut io = Scripted::new(Some(NOW + HOUR), Some(NOW + 8 * HOUR));
        let error = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + 9 * HOUR,
            Asker::New,
            &mut io,
        )
        .await
        .unwrap_err();
        assert!(error.contains("shorter time limit"), "{error}");
        assert!(io.renewals.is_empty());
        assert!(!renewals.is_due(KEY));
    }

    /// A forced renewal waits while a chat or CLI of the account runs; one
    /// in the CLI's own window does not.
    #[tokio::test]
    async fn a_forced_renewal_waits_for_the_accounts_chats_and_clis() {
        let renewals = SignInRenewals::default();
        let mut held = Scripted::new(Some(NOW + HOUR), Some(NOW + 8 * HOUR));
        held.holders = 1;
        // Live leases do not make the account drain for a renewal that
        // cannot run yet.
        held.leases = 2;
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW + 2 * HOUR,
                Asker::New,
                &mut held
            )
            .await,
            Err(format!("sign_in_wait: {APP_SIGN_IN_HELD}"))
        );
        // What the grant covers still starts.
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                Asker::New,
                &mut held
            )
            .await,
            Ok(Some(NOW + HOUR))
        );
        assert!(held.renewals.is_empty());
        assert!(!renewals.is_due(KEY));
        let mut late = Scripted::new(Some(NOW + 60_000), Some(NOW + 8 * HOUR));
        late.holders = 2;
        ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW,
            Asker::New,
            &mut late,
        )
        .await
        .unwrap();
        assert_eq!(late.renewals, [true]);
        held.holders = 0;
        held.leases = 0;
        ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + 2 * HOUR,
            Asker::New,
            &mut held,
        )
        .await
        .unwrap();
        assert_eq!(held.renewals, [false]);
    }
}
