//! How many turns one provider account takes at once. It starts at
//! [`ACCOUNT_SLOTS`](super::ACCOUNT_SLOTS) and adapts to what the provider
//! shows: a rate-limit answer to a sent prompt halves it, and so does a
//! level of concurrency at which turns stream clearly slower than they do
//! with fewer beside them. It grows by one after a stretch of clean turns,
//! up to [`MOST`], and never sooner than ten minutes after it last changed
//! (or was first used), so it probes up slowly. Every attempt
//! records how many turns its account had in flight when it was admitted, so
//! speed results stay comparable across levels.
use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};

/// The most turns one account takes at once.
pub(super) const MOST: usize = 8;
/// How long the pace holds after it changed (or was first used) before it
/// may grow again.
const HOLD_MS: i64 = 10 * 60 * 1000;
/// Speeds kept per concurrency level, and how many make a level comparable.
const SPEEDS: usize = 20;
const COMPARABLE: usize = 5;
/// A level streaming slower than this share of a lower level's speed is a
/// slowdown the provider imposes, not the tasks'.
const SLOWER: f64 = 0.75;
/// Below these a turn's speed says more about its task than its provider.
const MIN_TOKENS: u64 = 200;
const MIN_SECONDS: f64 = 5.0;

#[derive(Clone, Debug)]
pub(super) struct Pace {
    limit: usize,
    clean: usize,
    hold_until: i64,
    /// Tokens per second of finished turns, by turns in flight at admission.
    speeds: BTreeMap<u32, Vec<f64>>,
}

impl Pace {
    pub(super) fn new(start: usize, now: i64) -> Self {
        Self {
            limit: start.clamp(1, MOST),
            clean: 0,
            hold_until: now + HOLD_MS,
            speeds: BTreeMap::new(),
        }
    }

    pub(super) fn limit(&self) -> usize {
        self.limit
    }

    /// The provider refused or cut a sent prompt for its rate. A turn sent
    /// under a higher limit than the pace holds now belongs to a burst the
    /// pace already answered, so concurrent refusals halve it once; one sent
    /// under the current limit (or not known) halves it again.
    pub(super) fn throttled(&mut self, admitted_limit: Option<usize>, now: i64) {
        if admitted_limit.is_some_and(|limit| limit > self.limit) {
            return;
        }
        self.limit = (self.limit / 2).max(1);
        self.clean = 0;
        self.hold_until = now + HOLD_MS;
    }

    /// A turn admitted beside `turns - 1` others on its account finished
    /// cleanly, streaming at `speed` tokens per second where that is known.
    pub(super) fn finished(&mut self, turns: u32, speed: Option<f64>, now: i64) {
        if let Some(speed) = speed.filter(|speed| speed.is_finite() && *speed > 0.0) {
            let ring = self.speeds.entry(turns.max(1)).or_default();
            ring.push(speed);
            if ring.len() > SPEEDS {
                ring.remove(0);
            }
        }
        if let Some(slower) = self.slowed() {
            // Back to the level below the first one that streams slower.
            self.limit = self.limit.min((slower as usize).saturating_sub(1).max(1));
            self.clean = 0;
            self.hold_until = now + HOLD_MS;
            // That level's evidence is spent; it is measured afresh if the
            // pace grows back to it.
            self.speeds.retain(|level, _| *level < slower);
            return;
        }
        self.clean += 1;
        if now >= self.hold_until && self.clean >= 2 * self.limit && self.limit < MOST {
            self.limit += 1;
            self.clean = 0;
            self.hold_until = now + HOLD_MS;
        }
    }

    /// The lowest concurrency level that streams clearly slower than the
    /// lowest level measured below it, if any.
    fn slowed(&self) -> Option<u32> {
        let comparable: Vec<(u32, f64)> = self
            .speeds
            .iter()
            .filter(|(_, ring)| ring.len() >= COMPARABLE)
            .map(|(level, ring)| (*level, median(ring)))
            .collect();
        let (base_level, base) = *comparable.first()?;
        comparable
            .iter()
            .find(|(level, speed)| *level > base_level && *speed < SLOWER * base)
            .map(|(level, _)| *level)
    }
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[sorted.len() / 2]
}

static PACES: LazyLock<Mutex<HashMap<String, Pace>>> = LazyLock::new(Default::default);

fn with_pace<T>(account: &str, apply: impl FnOnce(&mut Pace) -> T) -> T {
    let mut paces = PACES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    apply(
        paces
            .entry(account.to_owned())
            .or_insert_with(|| Pace::new(super::ACCOUNT_SLOTS, super::now())),
    )
}

/// Turns `account` (its provider and id, as a seat names it) takes at once.
pub(super) fn limit(account: &str) -> usize {
    with_pace(account, |pace| pace.limit())
}

pub(super) fn record_throttle(account: &str, admitted_limit: Option<usize>, now: i64) {
    with_pace(account, |pace| pace.throttled(admitted_limit, now));
}

pub(super) fn record_turn(account: &str, turns: u32, speed: Option<f64>, now: i64) {
    with_pace(account, |pace| pace.finished(turns, speed, now));
}

/// Whether a provider's answer to a sent prompt says it is limiting rate:
/// an HTTP 429 named as a status, and the usual rate-limit and overload
/// wordings of provider errors. A bare 429 among other digits (an execution
/// time, a port, a hash) and words a model might write ("overloaded" alone,
/// "slow down") are not. Usage limits that ran out are quota waits, handled
/// apart.
pub(super) fn throttle_signal(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "rate limit",
        "rate_limit",
        "ratelimit",
        "rate-limit",
        "too many requests",
        "overloaded_error",
        "model is overloaded",
        "server is overloaded",
        "currently overloaded",
    ]
    .iter()
    .any(|signal| text.contains(signal))
        || status_429(&text)
}

/// A 429 that stands alone, not inside a longer number or word, and that a
/// status word names shortly before it: "HTTP 429", "status: 429",
/// `"status":429`, "error code 429".
fn status_429(text: &str) -> bool {
    let bytes = text.as_bytes();
    text.match_indices("429").any(|(at, _)| {
        let alone = |index: Option<usize>| {
            index
                .and_then(|index| bytes.get(index))
                .is_none_or(|byte| !byte.is_ascii_alphanumeric())
        };
        // Bytes, not a str slice: 16 bytes back may fall inside a character.
        let before = &bytes[at.saturating_sub(16)..at];
        alone(at.checked_sub(1))
            && alone(Some(at + 3))
            && ["http", "status", "code", "error"].iter().any(|word| {
                before
                    .windows(word.len())
                    .any(|window| window == word.as_bytes())
            })
    })
}

/// Tokens per second a finished turn streamed, from its own usage and native
/// execution time; None where either is too small to say.
pub(super) fn speed(
    output_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    native_ms: Option<u64>,
) -> Option<f64> {
    let tokens = output_tokens.unwrap_or(0) + reasoning_tokens.unwrap_or(0);
    let seconds = native_ms? as f64 / 1000.0;
    (tokens >= MIN_TOKENS && seconds >= MIN_SECONDS).then(|| tokens as f64 / seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_throttled_account_halves_holds_and_then_probes_up_one_turn_at_a_time() {
        let mut pace = Pace::new(4, 0);
        // A new account keeps its start for the first hold, however clean.
        for _ in 0..50 {
            pace.finished(1, None, HOLD_MS - 1);
        }
        assert_eq!(pace.limit(), 4);
        pace.throttled(Some(4), 0);
        assert_eq!(pace.limit(), 2);
        // The rest of the burst sent at four answers nothing new.
        pace.throttled(Some(4), 1);
        pace.throttled(Some(4), 1);
        assert_eq!(pace.limit(), 2);
        // A turn sent at two that is refused too halves it again.
        pace.throttled(Some(2), 2);
        assert_eq!(pace.limit(), 1);
        pace.throttled(None, 2);
        assert_eq!(pace.limit(), 1);
        // Clean turns inside the hold do not grow it.
        for _ in 0..10 {
            pace.finished(1, None, 1_000);
        }
        assert_eq!(pace.limit(), 1);
        // After the hold, two clean turns per slot add one, and the next step
        // waits for another hold.
        let mut clock = 2 + HOLD_MS;
        pace.finished(1, None, clock);
        assert_eq!(pace.limit(), 2);
        for _ in 0..10 {
            pace.finished(2, None, clock);
        }
        assert_eq!(pace.limit(), 2);
        clock += HOLD_MS;
        pace.finished(2, None, clock);
        assert_eq!(pace.limit(), 3);
        // Never past the most an account takes.
        for _ in 0..200 {
            clock += HOLD_MS;
            for _ in 0..2 * MOST {
                pace.finished(3, None, clock);
            }
        }
        assert_eq!(pace.limit(), MOST);
    }

    #[test]
    fn a_level_that_streams_slower_than_fewer_turns_sends_the_pace_below_it() {
        let mut pace = Pace::new(4, 0);
        for _ in 0..COMPARABLE {
            pace.finished(1, Some(100.0), 0);
            pace.finished(2, Some(95.0), 0);
        }
        assert!(pace.slowed().is_none());
        let before = pace.limit();
        assert_eq!(before, 4);
        for _ in 0..COMPARABLE - 1 {
            pace.finished(4, Some(60.0), 0);
        }
        // Four slow samples are not yet comparable; the fifth is.
        assert!(pace.limit() >= before);
        pace.finished(4, Some(60.0), 0);
        assert_eq!(pace.limit(), 3);
        assert!(!pace.speeds.contains_key(&4));
        // With no lower level measured there is nothing to compare with.
        let mut alone = Pace::new(4, 0);
        for _ in 0..3 * COMPARABLE {
            alone.finished(4, Some(10.0), 0);
        }
        assert!(alone.slowed().is_none());
        assert_eq!(alone.limit(), 4);
        // Unknown speeds teach nothing either way.
        let mut quiet = Pace::new(4, 0);
        for _ in 0..50 {
            quiet.finished(8, None, 0);
        }
        assert!(quiet.speeds.is_empty());
    }

    #[test]
    fn throttling_wordings_and_speeds_are_read_conservatively() {
        for text in [
            "HTTP 429 Too Many Requests",
            "Rate limit reached for requests",
            "{\"error\":{\"type\":\"rate_limit_error\"}}",
            "The model is overloaded, please retry",
            "Erreur « HTTP 429 » : trop de requêtes",
        ] {
            assert!(throttle_signal(text), "{text}");
        }
        for text in [
            "Provider error: HTTP/1.1 429",
            "{\"status\":429,\"message\":\"slow\"}",
            "error code 429",
        ] {
            assert!(throttle_signal(text), "{text}");
        }
        for text in [
            "resource_busy: benchmark resource capacity is queued",
            "You've reached your monthly usage limit",
            "stream disconnected",
            // A budget timeout's reason carries the execution time.
            "{\"nativeExecutionMs\":429810}",
            "{\"nativeExecutionMs\":723429}",
            "port 54290 refused",
            "commit 4290a1b",
            "The queue in the answer was overloaded, so I slowed down",
            "Please slow down",
        ] {
            assert!(!throttle_signal(text), "{text}");
        }
        assert_eq!(speed(Some(1500), Some(500), Some(20_000)), Some(100.0));
        assert_eq!(speed(Some(100), None, Some(20_000)), None);
        assert_eq!(speed(Some(5000), None, Some(4_000)), None);
        assert_eq!(speed(Some(5000), None, None), None);
    }

    #[test]
    fn each_account_keeps_its_own_pace_from_the_shared_start() {
        let (first, second) = (
            "invented-acp\u{1f}pace-first",
            "invented-acp\u{1f}pace-second",
        );
        assert_eq!(limit(first), super::super::ACCOUNT_SLOTS);
        record_throttle(first, None, 0);
        assert_eq!(limit(first), super::super::ACCOUNT_SLOTS / 2);
        assert_eq!(limit(second), super::super::ACCOUNT_SLOTS);
        record_turn(second, 1, Some(50.0), 0);
        assert_eq!(limit(second), super::super::ACCOUNT_SLOTS);
    }
}
