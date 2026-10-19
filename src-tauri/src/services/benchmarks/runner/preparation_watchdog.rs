//! A bound on how long a single-task attempt may prepare without reaching a
//! provider. Every wait inside preparation has its own limit (a sign-in
//! renewal, an account's spawn queue, a bridge start, sandbox admission), but
//! nothing bounded them together, so an attempt queued behind several of them
//! could hold its flight, and its run's pause, for an hour.
//!
//! The watchdog looks only at what the store says the attempt reached: while
//! it is still `preparing` with no session, turn or acknowledged selection,
//! nothing was sent, and dropping its preparation loses no paid work. The
//! attempt then settles as a `resource_busy` refusal, which the unstarted
//! path requeues. Workflow roots stay `preparing` while their steps run, so
//! they are never bounded here.
use super::super::types::{BenchmarkError, Result};
use std::future::Future;
use std::time::Duration;

/// Longer than the bounded waits of one preparation added together.
pub(super) const PREPARATION_LIMIT: Duration = Duration::from_secs(30 * 60);
/// How often a preparation past its limit is checked.
pub(super) const CHECK_EVERY: Duration = Duration::from_secs(60);

pub(super) const PREPARATION_EXPIRED: &str =
    "resource_busy: preparation did not reach a provider session within 30 min; nothing was sent";

/// `execution`, unless it is still unstarted (`unstarted` answers from the
/// store) once `limit` has passed. Both run in one task, so the store is
/// read only while `execution` waits at one of its awaits: an attempt that
/// saved its dispatch is no longer unstarted, and one that has not saved it
/// has sent nothing. The execution is boxed: a turn's future is deep, and an
/// unoptimized build gives each awaiting poll a stack slot for it.
pub(super) async fn bounded<T, E, U>(
    execution: E,
    limit: Duration,
    every: Duration,
    mut unstarted: impl FnMut() -> U,
) -> Result<T>
where
    E: Future<Output = Result<T>>,
    U: Future<Output = bool>,
{
    let started = tokio::time::Instant::now();
    let mut execution = Box::pin(execution);
    loop {
        tokio::select! {
            done = &mut execution => return done,
            _ = tokio::time::sleep(every.min(limit)) => {
                if started.elapsed() >= limit && unstarted().await {
                    log::warn!("[benchmarks] {PREPARATION_EXPIRED}");
                    return Err(BenchmarkError::new("resource_busy", PREPARATION_EXPIRED));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    const LIMIT: Duration = Duration::from_millis(60);
    const EVERY: Duration = Duration::from_millis(10);

    #[tokio::test]
    async fn an_unstarted_preparation_past_its_limit_is_refused() {
        let error = bounded(
            std::future::pending::<Result<u32>>(),
            LIMIT,
            EVERY,
            || async { true },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "resource_busy");
        assert!(error.message.starts_with("resource_busy:"));
    }

    #[tokio::test]
    async fn a_started_turn_or_a_quick_preparation_is_never_cut() {
        // Past the limit, but the store says the attempt reached a provider.
        let started = AtomicBool::new(false);
        let execution = async {
            tokio::time::sleep(LIMIT * 3).await;
            Ok(7u32)
        };
        let answer = bounded(execution, LIMIT, EVERY, || {
            started.store(true, Ordering::SeqCst);
            async { false }
        })
        .await
        .unwrap();
        assert_eq!(answer, 7);
        assert!(started.load(Ordering::SeqCst));
        // Inside the limit nothing is asked at all.
        let quick = bounded(
            async {
                tokio::time::sleep(EVERY * 2).await;
                Ok(1u32)
            },
            LIMIT,
            EVERY,
            || async { panic!("asked inside the limit") },
        )
        .await
        .unwrap();
        assert_eq!(quick, 1);
    }
}
