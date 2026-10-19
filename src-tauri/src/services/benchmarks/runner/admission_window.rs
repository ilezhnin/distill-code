//! How many attempts the app prepares at once that the sandbox has not
//! admitted yet. No number bounds the attempts in flight: an admitted attempt
//! holds what the sandbox gave it, and the next one is prepared. The window is
//! one plus the admissions since the sandbox last refused one, counted over
//! the last minute, so a wave start ramps up as fast as the sandbox keeps
//! admitting (it doubles each round) and a full sandbox is asked by one
//! attempt at a time instead of by every ready one. An attempt preparing for
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
        if self.preparing.remove(id).is_some() {
            self.admissions.push_back(now);
        }
    }

    fn refused(&mut self, id: &str) {
        self.preparing.remove(id);
        if !self.admissions.is_empty() {
            log::info!(
                "[benchmarks] preparation window closes to one: the sandbox refused an attempt after {} admissions",
                self.admissions.len()
            );
        }
        self.admissions.clear();
    }
}

/// Windows by the store they prepare for (each test service has its own).
static WINDOWS: LazyLock<Mutex<HashMap<String, Window>>> = LazyLock::new(Default::default);

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

/// An attempt's place in the window: it ends when dropped, however its
/// flight ends (returned, failed or panicked), unless the sandbox answered
/// first.
pub(super) struct Preparing {
    scope: String,
    id: String,
    generation: u64,
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

/// The sandbox refused `id` before anything started: the window closes to
/// one attempt until the sandbox admits again.
pub(super) fn refused(scope: &str, id: &str) {
    with(scope, |window| window.refused(id));
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
        window.refused("d");
        assert!(!window.begin_ok("h", at));
        for id in ["e", "f", "g"] {
            window.refused(id);
        }
        assert!(window.begin_ok("h", at));
        assert!(!window.begin_ok("i", at));
        // Asking again for one already preparing is no second place.
        assert!(window.begin_ok("h", at));
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
}
