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
use super::{
    execution::NativeProvider,
    sandbox_sign_in::{SignInRenewals, Step},
};
use crate::services::credential_lease;
use futures_util::future::BoxFuture;

/// Why a test waits while its account drains for a renewal.
pub(crate) const APP_SIGN_IN_DRAIN: &str = "the Distill sign-in of this account renews once the tests running on it finish; this test starts then";

/// Why a test waits while a chat or CLI of its account keeps its sign-in
/// from being renewed.
pub(crate) const APP_SIGN_IN_HELD: &str = "the Distill sign-in this test needs is renewed once the chats and CLIs running on that account stop; this test starts then";

/// How long after a failed renewal of the same grant the next one may run:
/// a refused refresh token is not retried by every admission.
const RETRY_AFTER_FAILURE_MS: i64 = 15 * 60_000;

/// How far ahead the keep-alive asks every grant to last: it renews a grant
/// this long before its CLI's own window, whether or not a session runs.
/// Why a test waits when the grant its lease would come from no longer lasts
/// for it at the start: its next try renews the grant first.
pub(crate) const APP_SIGN_IN_SHORT: &str =
    "the Distill sign-in this test runs on is renewed before it starts";

pub(crate) const KEEPALIVE_LEAD_MS: i64 = 30 * 60_000;

/// When the keep-alive first looks, after the host starts: soon, so a renewal
/// a stopped app cut short is settled and a grant near its end renewed.
pub(crate) const KEEPALIVE_FIRST_PASS: std::time::Duration = std::time::Duration::from_secs(30);

/// How often the keep-alive looks at every app sign-in.
pub(crate) const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

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
    drain: bool,
    io: &mut impl RenewalIo,
) -> Result<Option<i64>, String> {
    let expiry = io
        .expiry()
        .map_err(|error| format!("capability_missing: {error}"))?;
    let Some(expiry) = expiry else {
        renewals.settle(key);
        return Ok(None);
    };
    let needed = credential_lease::required_expiry(provider, until_ms);
    let lasts = expiry >= needed;
    // A later step of work already running needs only a grant that lasts;
    // new work also waits while the account drains for a renewal.
    if !drain && lasts {
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
    let live = io.live_leases().await;
    match renewals.step(key, expiry, needed, live) {
        Step::Covered => return Ok(Some(expiry)),
        Step::Wait => return Err(format!("sign_in_wait: {APP_SIGN_IN_DRAIN}")),
        Step::Renew => {}
    }
    let natural = io.now() >= expiry.saturating_sub(credential_lease::natural_window_ms(provider));
    // A forced renewal rotates the refresh token; a chat or CLI of the
    // account that still holds the old one could replay it. Whether each CLI
    // reads its store again before it refreshes is not verified, so a forced
    // renewal waits until none of them runs. A renewal in the CLI's own window
    // is the refresh every CLI of the account would make anyway.
    if !natural {
        let others = io.other_holders().await;
        if others > 0 {
            renewals.settle(key);
            log::info!(
                "[agent-host] the Distill {} sign-in of {key} renews once its {others} chat or CLI process(es) stop",
                provider.key()
            );
            return if lasts {
                Ok(Some(expiry))
            } else {
                Err(format!("sign_in_wait: {APP_SIGN_IN_HELD}"))
            };
        }
    }
    log::info!(
        "[agent-host] renewing the Distill {} sign-in of {key}{}",
        provider.key(),
        if natural { " (in its own window)" } else { "" }
    );
    let result = io.renew(natural).await;
    renewals.settle(key);
    let after = match result.and_then(|()| io.expiry()) {
        Ok(after) => after,
        Err(error) => return Err(failed(renewals, key, provider, expiry, io.now(), &error)),
    };
    if after.is_some_and(|after| after <= expiry) {
        return Err(failed(
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
        "[agent-host] Distill {} sign-in of {key} renewed",
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

fn failed(
    renewals: &SignInRenewals,
    key: &str,
    provider: NativeProvider,
    expiry: i64,
    now: i64,
    error: &str,
) -> String {
    let message = format!(
        "capability_missing: The Distill {} sign-in was not renewed ({error}); the grant is kept. If it stays refused, sign in again in Settings > AI providers",
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
            Box::pin(async move { self.holders })
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
            Box::pin(async {})
        }
        fn now(&self) -> i64 {
            self.now
        }
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
            true,
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
                true,
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
            true,
            &mut early,
        )
        .await
        .unwrap();
        assert_eq!(expiry, Some(NOW + 8 * HOUR));
        assert_eq!(early.renewals, [false]);
        assert_eq!(early.retired, 1);
        for left in [credential_lease::CLAUDE_RENEWAL_WINDOW_MS, 0, -HOUR] {
            let mut late = Scripted::new(Some(NOW + left), Some(NOW + 8 * HOUR));
            ensure(&renewals, KEY, NativeProvider::Claude, NOW, true, &mut late)
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
            true,
            &mut busy,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("sign_in_wait:"), "{error}");
        assert!(busy.renewals.is_empty());
        assert!(renewals.is_due(KEY));
        // A short test the grant still covers waits as well.
        assert!(
            ensure(&renewals, KEY, NativeProvider::Claude, NOW, true, &mut busy)
                .await
                .unwrap_err()
                .starts_with("sign_in_wait:")
        );
        // A later step of work already running goes on while its grant lasts.
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW,
                false,
                &mut busy
            )
            .await,
            Ok(Some(NOW + HOUR))
        );
        assert!(renewals.is_due(KEY));
        busy.leases = 0;
        assert_eq!(
            ensure(&renewals, KEY, NativeProvider::Claude, NOW, true, &mut busy).await,
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
            true,
            &mut refused,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("capability_missing:"), "{error}");
        assert!(error.contains("invented refusal") && error.contains("kept"));
        assert_eq!(refused.grant, Ok(Some(NOW + HOUR)));
        assert_eq!(refused.retired, 0);
        let again = ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            until,
            true,
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
            true,
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
            true,
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
            true,
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
                true,
                &mut missing
            )
            .await,
            Err("capability_missing: not signed in".into())
        );
        assert!(missing.renewals.is_empty());
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
            true,
            &mut idle,
        )
        .await
        .unwrap();
        assert_eq!(idle.renewals, [false]);
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
            true,
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
            true,
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
                true,
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
            true,
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
        assert_eq!(
            ensure(
                &renewals,
                KEY,
                NativeProvider::Claude,
                NOW + 2 * HOUR,
                true,
                &mut held
            )
            .await,
            Err(format!("sign_in_wait: {APP_SIGN_IN_HELD}"))
        );
        // What the grant covers still starts.
        assert_eq!(
            ensure(&renewals, KEY, NativeProvider::Claude, NOW, true, &mut held).await,
            Ok(Some(NOW + HOUR))
        );
        assert!(held.renewals.is_empty());
        assert!(!renewals.is_due(KEY));
        let mut late = Scripted::new(Some(NOW + 60_000), Some(NOW + 8 * HOUR));
        late.holders = 2;
        ensure(&renewals, KEY, NativeProvider::Claude, NOW, true, &mut late)
            .await
            .unwrap();
        assert_eq!(late.renewals, [true]);
        held.holders = 0;
        ensure(
            &renewals,
            KEY,
            NativeProvider::Claude,
            NOW + 2 * HOUR,
            true,
            &mut held,
        )
        .await
        .unwrap();
        assert_eq!(held.renewals, [false]);
    }
}
