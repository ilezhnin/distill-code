//! How long a session may hold the sign-in it was given.
use super::*;

/// How much longer than an attempt and its cleanup margin the Flock grant
/// its lease is staged from must last: the session's own start margin (its
/// lease must cover the turn and 480 s, see `Inner::ensure_execution_bridge`,
/// 180 s more than the cleanup margin) and a minute for the checks between
/// the renewal and the start, so a test admitted here is never refused at
/// staging.
const RENEWAL_SLACK_MS: i64 = 240_000;

/// How many seconds of a test of `timeout_seconds` a lease of `provider`
/// must cover (see [`credential_lease::lease_span_ms`]).
fn lease_seconds(provider: NativeProvider, timeout_seconds: u32) -> u32 {
    let span = credential_lease::lease_span_ms(provider, i64::from(timeout_seconds) * 1000);
    u32::try_from(span / 1000).unwrap_or(timeout_seconds)
}

/// The Flock sign-in an admitted attempt's lease is staged from: its
/// provider, and when its grant expires (none: it does not). None for a
/// provider that keeps its own sandbox sign-in (Kimi).
pub(in super::super) type AppGrant = Option<(NativeProvider, Option<i64>)>;

/// What the credentials of an admitted attempt last until: the Flock grant
/// its lease is staged from, or the sandbox's own sign-in (Kimi).
pub(in super::super) enum CredentialWindow {
    Lease(NativeProvider, Option<i64>),
    Sandbox(sandbox::Status),
}

impl CredentialWindow {
    pub(in super::super) fn new(grant: AppGrant, status: sandbox::Status) -> Self {
        match grant {
            Some((provider, expiry)) => Self::Lease(provider, expiry),
            None => Self::Sandbox(status),
        }
    }

    /// Whether these credentials cover an attempt of `timeout_seconds` from
    /// `now_ms` and its cleanup margin, for `provider`'s `account`.
    pub(in super::super) fn require(
        &self,
        provider: &str,
        account: &str,
        now_ms: i64,
        timeout_seconds: u32,
    ) -> Result<()> {
        let missing = |error: String| BenchmarkError::new("capability_missing", error);
        match self {
            Self::Sandbox(status) => status
                .require_account_window(provider, account, now_ms, timeout_seconds)
                .map_err(|error| missing(error.to_string())),
            Self::Lease(native, expiry) => {
                let deadline =
                    sandbox::admission_deadline(now_ms, lease_seconds(*native, timeout_seconds))
                        .map_err(|error| missing(error.to_string()))?;
                if credential_lease::covers(*native, *expiry, deadline) {
                    Ok(())
                } else {
                    Err(missing(
                        "The Flock sign-in this test's lease comes from does not cover its time limit and cleanup margin; it is renewed before the next try".into(),
                    ))
                }
            }
        }
    }
}

/// Runs `admit`, an attempt's sandbox runtime checks, which start no
/// provider turn, once the Flock sign-in of `c`'s account lasts for the
/// attempt: `budget` seconds (none for planning) and the cleanup margin,
/// renewed first on Windows when it does not (see
/// `Inner::renew_app_sign_in`). `asker` says what the renewal may cost the
/// attempt: new work waits for a waiting renewal even when the grant still
/// covers its own limit, and a run's new test has a half-spent grant renewed
/// first while nothing runs on it. Returns what `admit`
/// returned and the grant its lease will be staged from; a provider that
/// keeps its own sandbox sign-in (Kimi) runs `admit` alone, whose checks
/// cover it.
pub(in super::super) fn with_app_sign_in<'a, T, F, Fut>(
    host: &'a Arc<crate::services::agent_host::router::Inner>,
    c: &'a Configuration,
    budget: Option<u32>,
    asker: SignInAsker,
    admit: F,
) -> BoxFuture<'a, Result<(T, AppGrant)>>
where
    T: Send + 'a,
    F: FnOnce() -> Fut + Send + 'a,
    Fut: std::future::Future<Output = Result<T>> + Send + 'a,
{
    Box::pin(async move {
        let Some(provider) =
            NativeProvider::for_harness(&c.provider_id).filter(|p| credential_lease::leased(*p))
        else {
            return admit().await.map(|admitted| (admitted, None));
        };
        let until = match budget {
            Some(seconds) => {
                sandbox::admission_deadline(now(), lease_seconds(provider, seconds))
                    .map_err(|error| BenchmarkError::new("capability_missing", error.to_string()))?
            }
            None => now(),
        };
        let expiry = host
            .renew_app_sign_in(
                &c.provider_id,
                c.account_id.as_deref().unwrap_or_default(),
                until.saturating_add(RENEWAL_SLACK_MS),
                asker,
            )
            .await
            .map_err(host_error)?;
        let admitted = admit().await?;
        Ok((admitted, Some((provider, expiry))))
    })
}
