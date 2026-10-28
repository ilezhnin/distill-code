//! How many attempts the app prepares at once that the sandbox has not
//! admitted yet. No number bounds the attempts in flight: an admitted attempt
//! holds what the sandbox gave it, and the next one is prepared. The window is
//! one plus the admissions since the sandbox last refused one, counted over
//! the last minute. Candidate/judge and evaluator preparation use two fixed
//! lanes, both subject to the same native CPU, memory and timing broker.
//! A refusal parks its lane for fifteen seconds; a
//! completed job releases that wait early. Then one job probes admission,
//! and successes widen the window until the available capacity is filled.
//! An attempt preparing for
//! longer than STALE no longer counts, so one that hangs before it asks the
//! sandbox cannot hold the window shut.
use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long an admission widens the window.
const FRESH: Duration = Duration::from_secs(60);
/// How long a preparation counts against the window before it is taken to
/// wait for something other than the sandbox.
const STALE: Duration = Duration::from_secs(5 * 60);
pub(super) const RETRY: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Window {
    /// Attempts in preparation that the sandbox has not answered yet, since
    /// when, and the place's generation.
    preparing: HashMap<String, (Instant, u64)>,
    /// The generation the next place gets, so a guard of an earlier place of
    /// the same attempt never ends a later one.
    generation: u64,
    /// When the sandbox admitted attempts since it last refused one.
    admissions: VecDeque<Instant>,
    /// No new resource probes before this time, across all runs in this lane.
    retry_at: Option<Instant>,
    /// Jobs actually admitted, whose completion can free resources.
    running: HashMap<String, u64>,
    /// Durable waits are restored only once, never after completion woke us.
    restored: bool,
    /// Whether ready attempts wait for the window now, so it is logged once
    /// each time it starts to bind.
    binding: bool,
    /// How many preparations no longer counted when that was last logged.
    stale: usize,
}

impl Window {
    fn size(&mut self, now: Instant) -> usize {
        while self
            .admissions
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) > FRESH)
        {
            self.admissions.pop_front();
        }
        1 + self.admissions.len()
    }

    /// Preparations that still count: those younger than STALE.
    fn counted(&self, now: Instant) -> usize {
        self.preparing
            .values()
            .filter(|(since, _)| now.saturating_duration_since(*since) < STALE)
            .count()
    }

    fn has_room(&mut self, now: Instant) -> bool {
        if self.retry_at.is_some_and(|until| until > now) {
            return false;
        }
        let size = self.size(now);
        let counted = self.counted(now);
        let stale = self.preparing.len() - counted;
        if stale > self.stale {
            log::info!(
                "[benchmarks] preparation window: {stale} attempts have prepared for over {} s without the sandbox's answer and no longer count",
                STALE.as_secs()
            );
        }
        self.stale = stale;
        let room = counted < size;
        if !room && !self.binding {
            log::info!(
                "[benchmarks] preparation window binds: {counted} attempts prepare, the sandbox's recent answers allow {size}"
            );
        }
        self.binding = !room;
        room
    }

    /// The place's generation, or None while the window is full.
    fn begin(&mut self, id: &str, now: Instant) -> Option<u64> {
        if self.retry_at.is_some_and(|until| until > now) {
            return None;
        }
        if let Some((_, generation)) = self.preparing.get(id) {
            return Some(*generation);
        }
        if !self.has_room(now) {
            return None;
        }
        self.generation += 1;
        self.preparing.insert(id.to_owned(), (now, self.generation));
        Some(self.generation)
    }

    /// Ends `id`'s place of `generation`, not a later one of the same id.
    fn end(&mut self, id: &str, generation: u64) {
        if self
            .preparing
            .get(id)
            .is_some_and(|(_, current)| *current == generation)
        {
            self.preparing.remove(id);
        }
    }

    fn admitted(&mut self, id: &str, now: Instant) {
        if let Some((_, generation)) = self.preparing.remove(id) {
            self.running.insert(id.to_owned(), generation);
            self.admissions.push_back(now);
        }
    }

    fn refused(&mut self, id: &str, now: Instant) {
        self.preparing.remove(id);
        if self.retry_at.is_none_or(|until| until <= now) {
            log::info!(
                "[benchmarks] resource queue waits {} s after admission refusal; a completed job may wake it sooner",
                RETRY.as_secs()
            );
            self.retry_at = Some(now + RETRY);
        }
        self.admissions.clear();
    }

    fn finished(&mut self, id: &str) -> bool {
        if self.running.remove(id).is_none() {
            return false;
        }
        let woke = self.retry_at.take().is_some();
        if woke {
            log::info!(
                "[benchmarks] completed job freed resources; resource queue may probe again"
            );
        }
        woke
    }
}

/// Windows by the store they prepare for (each test service has its own).
static WINDOWS: LazyLock<Mutex<HashMap<String, Window>>> = LazyLock::new(Default::default);

const EVALUATION_LANE: &str = "\u{1e}evaluation";

/// Two fixed preparation lanes share the actual native resource broker.
/// Waiting CPU-heavy checks cannot occupy the candidate/judge preparation lane.
pub(super) fn evaluation_scope(scope: &str) -> String {
    format!("{scope}{EVALUATION_LANE}")
}

fn with<T>(scope: &str, apply: impl FnOnce(&mut Window) -> T) -> T {
    let mut windows = WINDOWS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    apply(windows.entry(scope.to_owned()).or_default())
}

/// Whether one more attempt may start preparing for `scope`.
pub(super) fn has_room(scope: &str) -> bool {
    with(scope, |window| window.has_room(Instant::now()))
}

/// Restore a pending resource wait after an app restart, once per store lane.
pub(super) fn restore(scope: &str, remaining: Duration) {
    with(scope, |window| {
        if !window.restored {
            window.restored = true;
            if !remaining.is_zero() {
                window.retry_at = Some(Instant::now() + remaining.min(RETRY));
            }
        }
    });
}

/// A shared wait, also used by already generated answers awaiting judges.
pub(super) fn remaining(scope: &str) -> Duration {
    with(scope, |window| {
        window.retry_at.map_or(Duration::ZERO, |until| {
            until.saturating_duration_since(Instant::now())
        })
    })
}

pub(super) fn finished(scope: &str, id: &str) -> bool {
    finish_generation(scope, id, None)
}

fn finish_generation(scope: &str, id: &str, generation: Option<u64>) -> bool {
    let mut windows = WINDOWS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(window) = windows.get_mut(scope) else {
        return false;
    };
    if !window
        .running
        .get(id)
        .is_some_and(|current| generation.is_none_or(|wanted| *current == wanted))
    {
        return false;
    }
    let woke = window.finished(id);
    // Either kind of completed native job can free resources for the other
    // lane. Only sandbox cooldowns are cleared; account quota waits live elsewhere.
    let other = scope
        .strip_suffix(EVALUATION_LANE)
        .map(str::to_owned)
        .unwrap_or_else(|| evaluation_scope(scope));
    let other_woke = windows
        .get_mut(&other)
        .is_some_and(|window| window.retry_at.take().is_some());
    woke || other_woke
}

#[cfg(test)]
pub(super) fn expire_wait(scope: &str) {
    with(scope, |window| window.retry_at = Some(Instant::now()));
}

/// An attempt's place in the window: it ends when dropped, however its
/// flight ends (returned, failed or panicked), unless the sandbox answered
/// first.
pub(super) struct Preparing {
    scope: String,
    id: String,
    generation: u64,
}

/// An evaluator can report native admission before its future completes.
/// Its running marker is also released if that future is dropped or panics.
pub(super) struct ObservedJob {
    preparing: Preparing,
}

impl Preparing {
    pub(super) fn observe(self) -> ObservedJob {
        ObservedJob { preparing: self }
    }
}

impl ObservedJob {
    pub(super) fn admitted(&self) {
        let Preparing {
            scope,
            id,
            generation,
        } = &self.preparing;
        with(scope, |window| {
            // Multiple helper receipts count once; an old observer must not
            // admit a later preparation that happens to reuse the same id.
            if window
                .preparing
                .get(id)
                .is_some_and(|(_, current)| current == generation)
            {
                window.admitted(id, Instant::now());
            }
        });
    }

    pub(super) fn finished(&self) -> bool {
        let Preparing {
            scope,
            id,
            generation,
        } = &self.preparing;
        finish_generation(scope, id, Some(*generation))
    }
}

impl Drop for ObservedJob {
    fn drop(&mut self) {
        self.finished();
    }
}

impl Drop for Preparing {
    fn drop(&mut self) {
        with(&self.scope, |window| window.end(&self.id, self.generation));
    }
}

/// Starts preparing `id` for `scope`; None while the window is full.
pub(super) fn begin(scope: &str, id: &str) -> Option<Preparing> {
    with(scope, |window| window.begin(id, Instant::now())).map(|generation| Preparing {
        scope: scope.to_owned(),
        id: id.to_owned(),
        generation,
    })
}

/// The sandbox admitted `id`: it no longer counts, and the window widens.
pub(super) fn admitted(scope: &str, id: &str) {
    with(scope, |window| window.admitted(id, Instant::now()));
}

/// The sandbox refused `id` before anything started: new work in its lane waits.
pub(super) fn refused(scope: &str, id: &str) {
    with(scope, |window| window.refused(id, Instant::now()));
}

/// `id` stopped preparing without the sandbox's answer.
pub(super) fn ended(scope: &str, id: &str) {
    with(scope, |window| {
        window.preparing.remove(id);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Window {
        fn begin_ok(&mut self, id: &str, now: Instant) -> bool {
            self.begin(id, now).is_some()
        }
    }

    #[test]
    fn an_earlier_place_of_the_same_attempt_never_ends_a_later_one() {
        let scope = "invented-store-for-generations";
        let first = begin(scope, "attempt").expect("an empty window has room");
        // The sandbox answered the first place, and the attempt begins again
        // before the first guard is dropped.
        admitted(scope, "attempt");
        let second = begin(scope, "attempt").expect("the answer made room");
        drop(first);
        assert!(with(scope, |window| window
            .preparing
            .contains_key("attempt")));
        drop(second);
        assert!(!with(scope, |window| window
            .preparing
            .contains_key("attempt")));
    }

    #[test]
    fn a_wave_start_doubles_while_the_sandbox_admits_and_one_refusal_closes_it() {
        let mut window = Window::default();
        let at = Instant::now();
        // One attempt asks first; nothing else prepares beside it.
        assert!(window.begin_ok("a", at));
        assert!(!window.begin_ok("b", at));
        // Each admission lets one more prepare: 1, 2, 4 at once.
        window.admitted("a", at);
        assert!(window.begin_ok("b", at) && window.begin_ok("c", at));
        assert!(!window.begin_ok("d", at));
        window.admitted("b", at);
        window.admitted("c", at);
        for id in ["d", "e", "f", "g"] {
            assert!(window.begin_ok(id, at), "{id}");
        }
        assert!(!window.begin_ok("h", at));
        // The first refusal: back to one attempt at a time.
        window.refused("d", at);
        assert!(!window.begin_ok("h", at));
        for id in ["e", "f", "g"] {
            window.refused(id, at);
        }
        assert!(!window.begin_ok("h", at + RETRY - Duration::from_millis(1)));
        let retry = at + RETRY;
        assert!(window.begin_ok("h", retry));
        assert!(!window.begin_ok("i", retry));
        // Asking again for one already preparing is no second place.
        assert!(window.begin_ok("h", retry));
    }

    #[test]
    fn a_refusal_parks_every_cell_and_only_one_probes_after_the_retry() {
        let mut window = Window::default();
        let at = Instant::now();
        window.refused("refused", at);
        for second in 0..RETRY.as_secs() {
            assert!(!window.begin_ok("next", at + Duration::from_secs(second)));
        }
        assert!(!window.finished("never-started"));
        assert!(!window.has_room(at + RETRY - Duration::from_millis(1)));
        assert!(window.begin_ok("probe", at + RETRY));
        assert!(!window.begin_ok("another", at + RETRY));
        window.refused("probe", at + RETRY);
        assert!(!window.has_room(at + RETRY + RETRY - Duration::from_millis(1)));
        assert!(window.has_room(at + RETRY + RETRY));
    }

    #[test]
    fn completion_wakes_a_parked_queue_and_successes_fill_available_capacity() {
        let mut window = Window::default();
        let at = Instant::now();
        assert!(window.begin_ok("running", at));
        window.admitted("running", at);
        assert!(window.begin_ok("refused", at));
        window.refused("refused", at);
        assert!(!window.has_room(at));
        assert!(window.finished("running"));
        assert!(window.begin_ok("probe", at));
        assert!(!window.begin_ok("second", at));
        window.admitted("probe", at);
        assert!(window.begin_ok("second", at));
        assert!(window.begin_ok("third", at));
        window.admitted("second", at);
        assert!(window.begin_ok("fourth", at));
        window.refused("third", at);
        assert!(!window.begin_ok("fifth", at));
    }

    #[test]
    fn a_preparation_that_hangs_stops_counting_and_a_dropped_place_ends() {
        let mut window = Window::default();
        let at = Instant::now();
        assert!(window.begin_ok("hung", at));
        assert!(!window.has_room(at + STALE - Duration::from_secs(1)));
        assert!(window.has_room(at + STALE));
        // A place dropped by its flight, however it ended, frees the window.
        let scope = "invented-store-for-the-guard";
        let place = begin(scope, "flight").expect("an empty window has room");
        assert!(begin(scope, "next").is_none());
        drop(place);
        assert!(begin(scope, "next").is_some());
    }

    #[test]
    fn admissions_older_than_a_minute_no_longer_widen_it() {
        let mut window = Window::default();
        let at = Instant::now();
        for id in ["a", "b", "c"] {
            window.preparing.insert(id.to_owned(), (at, 0));
            window.admitted(id, at);
        }
        assert_eq!(window.size(at), 4);
        assert_eq!(window.size(at + FRESH + Duration::from_secs(1)), 1);
        // An attempt the window never counted widens nothing.
        window.admitted("never-prepared", at);
        assert_eq!(window.size(at), 1);
    }

    #[test]
    fn queued_checks_do_not_occupy_the_light_lane_after_recent_admissions_expire() {
        let at = Instant::now();
        let later = at + FRESH + Duration::from_secs(1);
        let mut evaluations = Window::default();
        let mut light = Window::default();
        assert!(evaluations.begin_ok("timed-check", at));
        evaluations.admitted("timed-check", at);
        assert!(evaluations.begin_ok("queued-check", at));
        // The native broker may keep the second timing-sensitive check queued.
        // No invented admission expands either lane while it waits.
        assert!(!evaluations.has_room(later));
        assert!(!evaluations.begin_ok("third-check", later));
        assert_eq!(evaluations.running.len(), 1);
        assert!(light.begin_ok("remote-candidate", later));
        light.admitted("remote-candidate", later);
        assert!(light.begin_ok("remote-judge", later));
        evaluations.refused("queued-check", later);
        assert!(!evaluations.has_room(later));
        assert!(
            light.has_room(later),
            "check queue expiry does not park light work"
        );
    }

    #[test]
    fn native_job_completion_wakes_both_fixed_lanes_and_restore_cannot_repark_them() {
        for finishing_evaluator in [false, true] {
            let scope = format!("invented-two-lane-restore-{finishing_evaluator}");
            let evaluation = evaluation_scope(&scope);
            let finishing = if finishing_evaluator {
                &evaluation
            } else {
                &scope
            };
            let job = begin(finishing, "running").unwrap().observe();
            job.admitted();
            restore(&scope, RETRY);
            restore(&evaluation, RETRY);
            assert!(!remaining(&scope).is_zero());
            assert!(!remaining(&evaluation).is_zero());
            assert!(!finished(finishing, "unknown"));
            assert!(
                !remaining(&scope).is_zero(),
                "unknown completion cannot wake the queue"
            );
            drop(job);
            assert!(remaining(&scope).is_zero());
            assert!(remaining(&evaluation).is_zero());
            restore(&scope, RETRY);
            restore(&evaluation, RETRY);
            assert!(has_room(&scope));
            assert!(has_room(&evaluation));
        }
        let scope = "invented-evaluator-only-restore";
        let evaluation = evaluation_scope(scope);
        restore(&evaluation, RETRY);
        restore(scope, Duration::ZERO);
        assert!(!has_room(&evaluation));
        assert!(
            has_room(scope),
            "persisted evaluator pressure stays in its lane"
        );
    }

    #[test]
    fn duplicate_and_old_observers_never_admit_or_finish_a_later_generation() {
        let scope = "invented-observer-generations";
        let other = evaluation_scope(scope);
        let first = begin(scope, "same-id").unwrap().observe();
        first.admitted();
        first.admitted();
        assert_eq!(with(scope, |window| window.admissions.len()), 1);
        let second = begin(scope, "same-id").unwrap().observe();
        first.admitted();
        assert_eq!(with(scope, |window| window.preparing.len()), 1);
        second.admitted();
        restore(&other, RETRY);
        drop(first);
        assert!(
            !remaining(&other).is_zero(),
            "old drop cannot wake another lane"
        );
        assert_eq!(with(scope, |window| window.running.len()), 1);
        assert!(second.finished());
        assert!(remaining(&other).is_zero());
        assert_eq!(with(scope, |window| window.running.len()), 0);
        drop(second);
    }

    #[tokio::test]
    async fn evaluator_drop_error_abort_and_panic_release_matching_bookkeeping() {
        for (label, admit) in [("before-admission", false), ("after-admission", true)] {
            let scope = format!("invented-observer-drop-{label}");
            let job = begin(&scope, "evaluation").unwrap().observe();
            if admit {
                job.admitted();
            }
            let result: Result<(), ()> = (|| {
                let _job = job;
                Err(())
            })();
            assert!(result.is_err());
            assert!(with(&scope, |window| window.preparing.is_empty()
                && window.running.is_empty()));
        }
        for panic in [false, true] {
            let scope = format!("invented-observer-task-{panic}");
            let other = evaluation_scope(&scope);
            let job = begin(&scope, "evaluation").unwrap().observe();
            job.admitted();
            restore(&other, RETRY);
            let task = tokio::spawn(async move {
                let _job = job;
                if panic {
                    panic!("invented evaluator panic");
                }
                std::future::pending::<()>().await;
            });
            if !panic {
                task.abort();
            }
            assert!(task.await.is_err());
            assert!(with(&scope, |window| window.preparing.is_empty()
                && window.running.is_empty()));
            assert!(
                remaining(&other).is_zero(),
                "cleanup wakes the other lane too"
            );
        }
    }
}
