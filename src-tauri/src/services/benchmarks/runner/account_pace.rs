//! How many turns one provider account takes at once. An account with no
//! history starts at [`ACCOUNT_SLOTS`](super::ACCOUNT_SLOTS) in slow start:
//! the level doubles after each clean round, as many clean turns as the
//! level that were admitted with every slot taken (an account its demand
//! keeps below its level never grows). The first sign the provider limits
//! the account ends slow start: a rate-limit answer to a sent prompt halves
//! the level, and a level whose turns together stream clearly less than a
//! lower level's do sends it below that level. From then on it grows by one
//! after a stretch of clean turns, with no fixed most, never sooner than ten
//! minutes after it last changed, so it probes up slowly. The level the
//! provider last refused a model's turns at stands as that model's ceiling on
//! the account for an hour, since providers limit by model: its turns fly no
//! more at once than that while the account's other models grow on. A
//! slowdown sets no ceiling: streams that slow down as more fly at once say
//! nothing a refusal would, and our own load slows them too.
//!
//! The account's level, its last stable level (the one it last finished a
//! clean round at, or a refusal sent it to), when it last flew turns, whether
//! it is still in slow start and its standing model ceilings are kept beside
//! the store, so an app restart resumes there: an account that flew turns
//! within a ceiling's hour goes on at its level, and so does one idle for up
//! to six hours whose last word from the provider was no refusal or slowdown
//! (a drain or a deploy changes nothing on the provider's side); one idle for
//! longer, or over the hour right after a refusal or slowdown, resumes at
//! half its stable level, in slow start again. Every move is logged. Every attempt records how many
//! turns its account had in flight when it was admitted, so speed results
//! stay comparable across levels.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// How long the level the provider last refused turns at stands as the
/// model's ceiling before the pace may probe it again.
const CEILING_MS: i64 = 60 * 60 * 1000;
/// How long an account may sit idle and still resume at the level it was
/// flying, when the provider did not push back last (10-18: every gap's
/// restart, an hour or more of drain and deploy, halved every account).
const RESUME_MS: i64 = 6 * 60 * 60 * 1000;
/// How long the pace holds after it changed (or was first used) before it
/// may grow again.
const HOLD_MS: i64 = 10 * 60 * 1000;
/// When an account last flew turns is kept at this step, so its saving stays
/// rare.
const ACTIVE_STEP_MS: i64 = 60 * 1000;
/// Speeds kept per concurrency level, and how many make a level comparable.
const SPEEDS: usize = 20;
const COMPARABLE: usize = 5;
/// A level whose turns together stream less than this share of what a lower
/// level's turns together stream gains nothing from flying more at once.
const SLOWER: f64 = 0.75;
/// Below these a turn's speed says more about its task than its provider.
const MIN_TOKENS: u64 = 200;
const MIN_SECONDS: f64 = 5.0;

#[derive(Clone, Debug)]
pub(super) struct Pace {
    limit: usize,
    clean: usize,
    hold_until: i64,
    /// Whether the level still doubles after each full clean round: until
    /// the provider first refuses or slows a turn on the account.
    slow_start: bool,
    /// Clean turns finished since the level last moved that were admitted
    /// with every slot of the current level taken.
    full: usize,
    /// The level the account last finished a clean round at, or a refusal
    /// sent it to, and when: what a restart after a long stop halves.
    stable: (usize, i64),
    /// When the account last flew a turn (finished or refused), to the
    /// minute: what a restart measures staleness from.
    active: i64,
    /// Whether a turn flew since this process made the pace: a new or a
    /// resumed pace dates `active` without any flight, which judge seating
    /// must not read as the account flying (see [`last_flight`]).
    flown: bool,
    /// When the provider last pushed back (a refusal or a slowdown), if ever.
    pushed_back: Option<i64>,
    /// By model, the level the provider last refused its turns at and since
    /// when: for CEILING_MS that model's turns fly no more at once.
    ceilings: BTreeMap<String, (usize, i64)>,
    /// Tokens per second of finished turns, by turns in flight at admission.
    speeds: BTreeMap<u32, Vec<f64>>,
}

/// What a restart resumes an account's pace from (see [`Pace::resume`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Saved {
    level: usize,
    at: i64,
    slow_start: bool,
    #[serde(default)]
    ceilings: BTreeMap<String, (usize, i64)>,
    /// The level the account was flying at; a file from before it was kept
    /// resumes the stable level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current: Option<usize>,
    /// When the account last flew turns; a file from before it was kept dates
    /// the stable level instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_at: Option<i64>,
    /// When the provider last pushed back. Files from before it was kept
    /// carry no such time; their ceilings may come from slowdowns, which no
    /// longer set any, so a restart drops them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pushed_back_at: Option<i64>,
}

impl Pace {
    pub(super) fn new(start: usize, now: i64) -> Self {
        let start = start.max(1);
        Self {
            limit: start,
            clean: 0,
            hold_until: now + HOLD_MS,
            slow_start: true,
            full: 0,
            stable: (start, now),
            active: now,
            flown: false,
            pushed_back: None,
            ceilings: BTreeMap::new(),
            speeds: BTreeMap::new(),
        }
    }

    /// Whether a restart at `now` resumes `saved` where it was: it flew
    /// within the hour, or within [`RESUME_MS`] when its stable level was
    /// last set by a clean round, not by the provider's refusal or slowdown
    /// (which sets the stable level at the moment it pushes back). A file
    /// from before push-backs were kept infers one from its ceilings.
    fn resumes_where_it_was(saved: &Saved, now: i64) -> bool {
        let idle = now - saved.active_at.unwrap_or(saved.at);
        let pushed_back_last = Self::pushed_back_at(saved).is_some_and(|at| at >= saved.at);
        idle < CEILING_MS || (idle < RESUME_MS && !pushed_back_last)
    }

    /// When `saved`'s provider last pushed back: as kept, or, in a file from
    /// before it was kept, when the stable level was set if a ceiling dates
    /// from then.
    fn pushed_back_at(saved: &Saved) -> Option<i64> {
        saved.pushed_back_at.or_else(|| {
            saved
                .ceilings
                .values()
                .any(|(_, since)| *since >= saved.at)
                .then_some(saved.at)
        })
    }

    /// The pace a restart resumes from `saved`. Staleness runs from the last
    /// time the account flew turns: a stop (a restart, a gap's drain and
    /// deploy) says nothing new about its provider, so the account goes on
    /// at the level it was flying, in the same slow start, while
    /// [`Self::resumes_where_it_was`]. Otherwise it resumes at half its
    /// stable level, in slow start again, since the evidence that ended it
    /// has lapsed too. The model ceilings still standing hold either way.
    pub(super) fn resume(saved: &Saved, now: i64) -> Self {
        let active = saved.active_at.unwrap_or(saved.at);
        let fresh = Self::resumes_where_it_was(saved, now);
        let level = if fresh {
            saved.current.unwrap_or(saved.level)
        } else {
            saved.level / 2
        }
        .max(1);
        let mut pace = Self::new(level, now);
        pace.slow_start = saved.slow_start || !fresh;
        pace.stable = if fresh {
            (saved.level.max(1), saved.at)
        } else {
            (level, now)
        };
        pace.active = if fresh { active } else { now };
        // A fresh resume dates the account's last real flight; a stale one
        // dates the restart, which is none.
        pace.flown = fresh;
        // A push-back inferred from an old file is kept, so the next save
        // carries it although the ceilings it came from are dropped.
        pace.pushed_back = Self::pushed_back_at(saved);
        // Only a file that keeps push-backs keeps ceilings from refusals
        // alone (see `Saved::pushed_back_at`).
        pace.ceilings = saved
            .ceilings
            .iter()
            .filter(|(_, (_, since))| saved.pushed_back_at.is_some() && now - since < CEILING_MS)
            .map(|(model, ceiling)| (model.clone(), *ceiling))
            .collect();
        pace
    }

    /// What a restart would resume from now.
    pub(super) fn saved(&self) -> Saved {
        Saved {
            level: self.stable.0,
            at: self.stable.1,
            slow_start: self.slow_start,
            ceilings: self.ceilings.clone(),
            current: Some(self.limit),
            active_at: Some(self.active),
            pushed_back_at: self.pushed_back,
        }
    }

    /// The account flew a turn at `now`, kept to the minute.
    fn flew(&mut self, now: i64) {
        self.flown = true;
        if now - self.active >= ACTIVE_STEP_MS {
            self.active = now;
        }
    }

    /// The account finished a clean round at `level`: it is the stable one,
    /// its time refreshed at most once a hold so saving stays rare.
    fn confirm(&mut self, level: usize, now: i64) {
        if self.stable.0 != level || now - self.stable.1 >= HOLD_MS {
            self.stable = (level, now);
        }
    }

    /// The level moved to `limit` because the provider pushed back (a
    /// refusal or a slowdown): slow start ends, the new level is the stable
    /// one, and a restart soon after resumes at half (see
    /// [`Self::resumes_where_it_was`]).
    fn limited(&mut self, limit: usize, now: i64) {
        self.limit = limit;
        self.clean = 0;
        self.full = 0;
        self.slow_start = false;
        self.hold_until = now + HOLD_MS;
        self.stable = (limit, now);
        self.pushed_back = Some(now);
    }

    /// The provider refused `model`'s turns at `level`: for CEILING_MS they
    /// fly no more at once than that, nor than a lower ceiling still
    /// standing. A lone turn refused says the rate ran out, not how many
    /// turns it takes at once, and sets none.
    fn observed(&mut self, model: &str, level: usize, now: i64) {
        if level < 2 {
            return;
        }
        let level = self
            .ceiling(model, now)
            .map_or(level, |standing| standing.min(level));
        self.ceilings.insert(model.to_owned(), (level, now));
    }

    /// `model`'s standing ceiling, if any.
    fn ceiling(&self, model: &str, now: i64) -> Option<usize> {
        self.ceilings
            .get(model)
            .filter(|(_, since)| now - since < CEILING_MS)
            .map(|(level, _)| *level)
    }

    /// Turns of `model` the account takes at once: its pace, below the
    /// model's standing ceiling.
    pub(super) fn limit_for(&self, model: &str, now: i64) -> usize {
        self.ceiling(model, now)
            .map_or(self.limit, |ceiling| self.limit.min(ceiling))
    }

    pub(super) fn limit(&self) -> usize {
        self.limit
    }

    /// The provider refused or cut a sent prompt for its rate. A turn sent
    /// under a higher limit than the pace holds now belongs to a burst the
    /// pace already answered, so concurrent refusals halve it once; one sent
    /// under the current limit (or not known) halves it again.
    pub(super) fn throttled(&mut self, model: &str, admitted_limit: Option<usize>, now: i64) {
        self.flew(now);
        if admitted_limit.is_some_and(|limit| limit > self.limit) {
            return;
        }
        self.observed(model, admitted_limit.unwrap_or(self.limit), now);
        self.limited((self.limit / 2).max(1), now);
    }

    /// A turn admitted beside `turns - 1` others on its account finished
    /// cleanly, streaming at `speed` tokens per second where that is known.
    /// In slow start the level doubles once as many turns as the level
    /// finished cleanly that were admitted with all its slots taken; after
    /// it, the level grows by one per hold and stretch of clean turns.
    pub(super) fn finished(&mut self, turns: u32, speed: Option<f64>, now: i64) {
        self.flew(now);
        if let Some(speed) = speed.filter(|speed| speed.is_finite() && *speed > 0.0) {
            let ring = self.speeds.entry(turns.max(1)).or_default();
            ring.push(speed);
            if ring.len() > SPEEDS {
                ring.remove(0);
            }
        }
        if let Some(slower) = self.slowed() {
            // Back to the level below the first one that streams less in all,
            // with no ceiling: the pace may probe it again after a hold.
            self.limited(
                self.limit.min((slower as usize).saturating_sub(1).max(1)),
                now,
            );
            // That level's evidence is spent; it is measured afresh if the
            // pace grows back to it.
            self.speeds.retain(|level, _| *level < slower);
            return;
        }
        self.clean += 1;
        if self.slow_start {
            if turns as usize >= self.limit {
                self.full += 1;
            }
            if self.full >= self.limit {
                self.confirm(self.limit, now);
                self.limit = self.limit.saturating_mul(2);
                self.clean = 0;
                self.full = 0;
            }
            return;
        }
        if self.clean >= self.limit {
            self.confirm(self.limit, now);
        }
        if now >= self.hold_until && self.clean >= 2 * self.limit {
            self.limit += 1;
            self.clean = 0;
            self.hold_until = now + HOLD_MS;
        }
    }

    /// The lowest concurrency level whose turns together stream clearly less
    /// than a lower measured level's do, if any: a level's whole stream is
    /// its median speed times its turns. Each stream slowing as more fly at
    /// once is no slowdown while the account still streams more in all (eleven
    /// turns at three quarters of the speed of seven stream more than seven).
    fn slowed(&self) -> Option<u32> {
        let mut best_below: Option<f64> = None;
        for (level, ring) in self
            .speeds
            .iter()
            .filter(|(_, ring)| ring.len() >= COMPARABLE)
        {
            let whole = median(ring) * f64::from(*level);
            if best_below.is_some_and(|best| whole < SLOWER * best) {
                return Some(*level);
            }
            best_below = Some(best_below.map_or(whole, |best| best.max(whole)));
        }
        None
    }
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[sorted.len() / 2]
}

static PACES: LazyLock<Mutex<HashMap<String, Pace>>> = LazyLock::new(Default::default);

/// The file beside a store that keeps its accounts' paces across restarts.
const SAVED_FILE: &str = "account-pace.json";

/// The store root and the account a pace key names (see `pace_key`); none
/// for a key without a store, whose pace lives in memory only.
fn split_key(key: &str) -> Option<(&str, &str)> {
    key.split_once(char::from(0x1e))
        .filter(|(root, account)| !root.is_empty() && !account.is_empty())
}

fn read_saved(root: &Path) -> BTreeMap<String, Saved> {
    std::fs::read(root.join(SAVED_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Writes every pace of the store at `root` to its file over what it holds,
/// so accounts this process has not used yet keep their saved levels,
/// through a temporary file so a crash never leaves half of one.
fn write_saved(root: &str, paces: &HashMap<String, Pace>) {
    let mut saved = read_saved(Path::new(root));
    for (key, pace) in paces {
        if let Some((store, account)) = split_key(key) {
            if store == root {
                saved.insert(account.to_owned(), pace.saved());
            }
        }
    }
    let path = PathBuf::from(root).join(SAVED_FILE);
    let temporary = path.with_extension("json.tmp");
    let written = serde_json::to_vec(&saved)
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(&temporary, bytes))
        .and_then(|()| std::fs::rename(&temporary, &path));
    if let Err(error) = written {
        log::warn!(
            "[benchmarks] account pace could not be saved to {}: {error}",
            path.display()
        );
    }
}

fn with_pace<T>(key: &str, apply: impl FnOnce(&mut Pace) -> T) -> T {
    let mut paces = PACES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let pace = paces.entry(key.to_owned()).or_insert_with(|| {
        let now = super::now();
        let saved = split_key(key)
            .and_then(|(root, account)| read_saved(Path::new(root)).remove(account));
        match saved {
            Some(saved) => {
                let pace = Pace::resume(&saved, now);
                let idle = (now - saved.active_at.unwrap_or(saved.at)).max(0) / 1000;
                log::info!(
                    "[benchmarks] account pace {} resumed at {} turns at once: it last flew turns {idle} s ago ({}), stable level {}, slow start {}",
                    shown(key),
                    pace.limit(),
                    if Pace::resumes_where_it_was(&saved, now) {
                        "within the hour, or within six hours with no refusal or slowdown last, so it goes on where it was"
                    } else {
                        "six hours or more ago, or over an hour after a refusal or slowdown, so at half its stable level"
                    },
                    saved.level,
                    pace.slow_start
                );
                pace
            }
            None => Pace::new(super::ACCOUNT_SLOTS, now),
        }
    });
    let before = pace.saved();
    let result = apply(pace);
    if pace.saved() != before {
        if let Some((root, _)) = split_key(key) {
            write_saved(root, &paces);
        }
    }
    result
}

/// The account a pace key names, for the log.
fn shown(key: &str) -> String {
    key.rsplit(char::from(0x1e))
        .next()
        .unwrap_or(key)
        .replace(char::from(0x1f), "/")
}

/// When `account` (its provider and id, as a seat names it) last flew a
/// turn under any store this process paces, to the minute; none when it has
/// no pace here.
pub(super) fn last_flight(account: &str) -> Option<i64> {
    PACES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .filter(|(key, pace)| pace.flown && key.rsplit(char::from(0x1e)).next() == Some(account))
        .map(|(_, pace)| pace.active)
        .max()
}

/// `account` starts a turn at `now`: it is flying, which a restart measures
/// its pace's staleness from even before the turn ends.
pub(super) fn record_flight(account: &str, now: i64) {
    with_pace(account, |pace| pace.flew(now));
}

/// Turns `account` (its provider and id, as a seat names it) takes at once.
pub(super) fn limit(account: &str) -> usize {
    with_pace(account, |pace| pace.limit())
}

/// Turns of `model` `account` takes at once (see [`Pace::limit_for`]).
pub(super) fn limit_for(account: &str, model: &str) -> usize {
    with_pace(account, |pace| pace.limit_for(model, super::now()))
}

pub(super) fn record_throttle(account: &str, model: &str, admitted_limit: Option<usize>, now: i64) {
    with_pace(account, |pace| {
        let before = (pace.limit(), pace.ceiling(model, now));
        pace.throttled(model, admitted_limit, now);
        log_move(
            account,
            model,
            "throttled",
            before,
            (pace.limit(), pace.ceiling(model, now)),
        );
    });
}

pub(super) fn record_turn(account: &str, model: &str, turns: u32, speed: Option<f64>, now: i64) {
    with_pace(account, |pace| {
        let before = (pace.limit(), pace.ceiling(model, now));
        pace.finished(turns, speed, now);
        log_move(
            account,
            model,
            "clean turn",
            before,
            (pace.limit(), pace.ceiling(model, now)),
        );
    });
}

/// Logs a move of an account's pace or of a model's ceiling on it, so a
/// wave's log shows how far each climbed and where each provider pushed back.
fn log_move(
    account: &str,
    model: &str,
    cause: &str,
    before: (usize, Option<usize>),
    after: (usize, Option<usize>),
) {
    if before == after {
        return;
    }
    // The key names the store it measures for first; the account is enough.
    let account = shown(account);
    log::info!(
        "[benchmarks] account pace {account} ({model}): {cause}: {} -> {} turns at once, model ceiling {:?} -> {:?}",
        before.0,
        after.0,
        before.1,
        after.1
    );
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

/// Forgets every pace in memory, as a restart does.
#[cfg(test)]
fn forget(key: &str) {
    PACES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(key);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As many clean turns as the level, each admitted with every slot taken.
    fn round(pace: &mut Pace, clock: i64) {
        for _ in 0..pace.limit() {
            pace.finished(pace.limit() as u32, None, clock);
        }
    }

    #[test]
    fn slow_start_doubles_each_full_clean_round_until_the_first_throttle() {
        let mut pace = Pace::new(4, 0);
        round(&mut pace, 0);
        assert_eq!(pace.limit(), 8);
        round(&mut pace, 1);
        assert_eq!(pace.limit(), 16);
        // The level a round finished at is the stable one a restart resumes.
        assert_eq!(pace.saved().level, 8);
        // One turn short of a round does not double it, holds or not.
        for _ in 0..15 {
            pace.finished(16, None, 2 * HOLD_MS);
        }
        assert_eq!(pace.limit(), 16);
        // The first throttle halves it and ends slow start for good: full
        // rounds no longer double it, and after a hold a stretch of clean
        // turns adds one.
        pace.throttled("m", Some(16), 3 * HOLD_MS);
        assert_eq!(pace.limit(), 8);
        assert_eq!(
            pace.saved(),
            Saved {
                level: 8,
                at: 3 * HOLD_MS,
                slow_start: false,
                ceilings: BTreeMap::from([("m".to_owned(), (16, 3 * HOLD_MS))]),
                current: Some(8),
                active_at: Some(3 * HOLD_MS),
                pushed_back_at: Some(3 * HOLD_MS),
            }
        );
        for _ in 0..3 {
            round(&mut pace, 3 * HOLD_MS + 1);
        }
        assert_eq!(pace.limit(), 8);
        pace.finished(8, None, 4 * HOLD_MS);
        assert_eq!(pace.limit(), 9);
    }

    #[test]
    fn an_account_its_demand_keeps_below_its_level_never_grows_in_slow_start() {
        let mut pace = Pace::new(4, 0);
        // Three of four slots taken, round after round, hold after hold.
        for clock in 0..100 {
            pace.finished(3, None, clock * HOLD_MS);
        }
        assert_eq!(pace.limit(), 4);
        // A round counts the turns that found every slot taken: three of them
        // and any number below are none.
        for _ in 0..3 {
            pace.finished(4, None, 0);
        }
        for _ in 0..20 {
            pace.finished(2, None, 0);
        }
        assert_eq!(pace.limit(), 4);
        pace.finished(4, None, 0);
        assert_eq!(pace.limit(), 8);
        // Turns admitted with four in flight do not fill eight.
        for _ in 0..20 {
            pace.finished(4, None, 0);
        }
        assert_eq!(pace.limit(), 8);
    }

    #[test]
    fn a_restart_resumes_the_saved_level_and_a_stale_one_at_half() {
        // A file that keeps push-backs: the provider refused "m" at eight
        // when the stable level was set.
        let saved = Saved {
            level: 16,
            at: 0,
            slow_start: false,
            ceilings: BTreeMap::from([
                ("m".to_owned(), (8, 0)),
                ("lapsed".to_owned(), (4, -CEILING_MS)),
            ]),
            current: None,
            active_at: None,
            pushed_back_at: Some(0),
        };
        let pace = Pace::resume(&saved, CEILING_MS - 1);
        assert_eq!(pace.limit(), 16);
        assert!(!pace.slow_start);
        assert_eq!(pace.saved().at, 0);
        assert_eq!(pace.limit_for("m", CEILING_MS - 1), 8);
        assert_eq!(pace.limit_for("lapsed", CEILING_MS - 1), 16);
        // Idle for an hour right after the provider pushed back, it resumes
        // at half, in slow start again, its ceilings lapsed.
        let stale = Pace::resume(&saved, CEILING_MS);
        assert_eq!(stale.limit(), 8);
        assert!(stale.slow_start);
        assert!(stale.ceilings.is_empty());
        let single = Saved {
            level: 1,
            ..saved.clone()
        };
        assert_eq!(Pace::resume(&single, CEILING_MS).limit(), 1);
        // A file from before push-backs were kept infers one from a ceiling
        // set when the stable level was, but drops its ceilings: they may
        // come from slowdowns, which set none now.
        let old = Saved {
            pushed_back_at: None,
            ..saved
        };
        let resumed = Pace::resume(&old, CEILING_MS - 1);
        assert_eq!(resumed.limit_for("m", CEILING_MS - 1), 16);
        // The inferred push-back is kept, so a second restart halves too.
        assert_eq!(resumed.saved().pushed_back_at, Some(0));
        assert_eq!(Pace::resume(&old, CEILING_MS).limit(), 8);
    }

    #[test]
    fn a_clean_round_after_a_push_back_lets_a_restart_resume_where_it_was() {
        let mut pace = Pace::new(4, 0);
        round(&mut pace, 0);
        assert_eq!(pace.limit(), 8);
        // A refusal of a lone turn (the pace at one during quota recovery)
        // sets no ceiling, yet a restart within six hours of it resumes at
        // half.
        pace.throttled("m", Some(1), HOLD_MS);
        assert_eq!(pace.limit(), 4);
        assert!(pace.ceilings.is_empty());
        let refused = pace.saved();
        assert_eq!(refused.pushed_back_at, Some(HOLD_MS));
        assert_eq!(Pace::resume(&refused, HOLD_MS + 2 * CEILING_MS).limit(), 2);
        // A clean round after the hold confirms the level: a restart two
        // hours later goes on where it was.
        let clock = 3 * HOLD_MS;
        round(&mut pace, clock);
        let confirmed = pace.saved();
        assert_eq!(confirmed.at, clock);
        assert_eq!(Pace::resume(&confirmed, clock + 2 * CEILING_MS).limit(), 4);
        // A slowdown counts as a push-back too.
        let mut slowed = Pace::new(4, 0);
        for _ in 0..COMPARABLE {
            slowed.finished(1, Some(100.0), 0);
            slowed.finished(2, Some(100.0), 0);
        }
        for _ in 0..COMPARABLE {
            slowed.finished(4, Some(20.0), HOLD_MS);
        }
        let saved = slowed.saved();
        assert_eq!(saved.pushed_back_at, Some(HOLD_MS));
        assert!(saved.ceilings.is_empty());
        assert_eq!(
            Pace::resume(&saved, HOLD_MS + 2 * CEILING_MS).limit(),
            (saved.level / 2).max(1)
        );
    }

    #[test]
    fn a_short_stop_resumes_at_the_level_the_account_was_flying() {
        // Slow start at 16 with demand below a full round, for two hours: the
        // stable level (8) was confirmed at the start, the account flew turns
        // until a minute before the stop (10-18: a 25-minute gap sent b55a
        // from 16 to 6, Codex from 19 to 9, Grok from 21 to 5).
        let mut pace = Pace::new(4, 0);
        round(&mut pace, 0);
        round(&mut pace, 0);
        assert_eq!(pace.limit(), 16);
        for minute in 0..120 {
            pace.finished(3, None, minute * ACTIVE_STEP_MS);
        }
        let saved = pace.saved();
        let last = 119 * ACTIVE_STEP_MS;
        assert_eq!(
            (saved.level, saved.at, saved.current, saved.active_at),
            (8, 0, Some(16), Some(last))
        );
        // A 25-minute stop goes on at 16, in the same slow start.
        let resumed = Pace::resume(&saved, last + 25 * ACTIVE_STEP_MS);
        assert_eq!(resumed.limit(), 16);
        assert!(resumed.slow_start);
        assert_eq!(resumed.saved().active_at, Some(last));
        // A drain and deploy of an hour or more with no refusal last goes on
        // at 16 too (10-18: every gap's restart halved every account).
        let drained = Pace::resume(&saved, last + 2 * CEILING_MS);
        assert_eq!(drained.limit(), 16);
        assert!(drained.slow_start);
        // An account idle for longer than that resumes at half its stable
        // level.
        let idle = Pace::resume(&saved, last + RESUME_MS);
        assert_eq!(idle.limit(), 4);
        assert!(idle.slow_start);
        // Over the hour right after a refusal, it resumes at half as well.
        let mut refused = pace.clone();
        refused.throttled("m", Some(16), last);
        let saved = refused.saved();
        assert_eq!(Pace::resume(&saved, last + CEILING_MS - 1).limit(), 8);
        assert_eq!(Pace::resume(&saved, last + CEILING_MS).limit(), 4);
        // Only a real flight counts as the account flying for judge seating:
        // a resume within the hour dates one, a new or stale pace none.
        assert!(resumed.flown);
        assert!(!idle.flown && !Pace::new(4, 0).flown);
        // Activity is kept to the minute, so a burst of turns saves once.
        let mut steady = Pace::new(4, 0);
        steady.finished(1, None, ACTIVE_STEP_MS);
        let before = steady.saved();
        steady.finished(1, None, ACTIVE_STEP_MS + 30_000);
        assert_eq!(steady.saved(), before);
    }

    #[test]
    fn paces_kept_beside_their_store_resume_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let key =
            |account: &str| format!("{}\u{1e}invented-acp\u{1f}{account}", dir.path().display());
        let (saved, fresh, stale) = (key("pace-saved"), key("pace-new"), key("pace-stale"));
        let now = super::super::now();
        for _ in 0..2 {
            let level = limit(&saved);
            for _ in 0..level {
                record_turn(&saved, "m", level as u32, None, now);
            }
        }
        assert_eq!(limit(&saved), 4 * super::super::ACCOUNT_SLOTS);
        record_throttle(&saved, "m", None, now);
        assert_eq!(limit(&saved), 2 * super::super::ACCOUNT_SLOTS);
        // A restart forgets the pace in memory and resumes from the file.
        forget(&saved);
        assert_eq!(limit(&saved), 2 * super::super::ACCOUNT_SLOTS);
        assert!(!with_pace(&saved, |pace| pace.slow_start));
        let file = read_saved(dir.path());
        assert_eq!(
            file["invented-acp\u{1f}pace-saved"].level,
            2 * super::super::ACCOUNT_SLOTS
        );
        // An account with no history in the same store seeds its start.
        assert_eq!(limit(&fresh), super::super::ACCOUNT_SLOTS);
        // A level saved longer ago than the idle window resumes at half.
        let mut file = file;
        file.insert(
            "invented-acp\u{1f}pace-stale".into(),
            Saved {
                level: 12,
                at: now - RESUME_MS - 1,
                slow_start: false,
                ceilings: BTreeMap::new(),
                current: None,
                active_at: None,
                pushed_back_at: None,
            },
        );
        std::fs::write(
            dir.path().join(SAVED_FILE),
            serde_json::to_vec(&file).unwrap(),
        )
        .unwrap();
        // Another account's move rewrites the file over what it holds, so a
        // saved account this process has not used yet keeps its level.
        record_throttle(&fresh, "m", None, now);
        assert!(read_saved(dir.path()).contains_key("invented-acp\u{1f}pace-stale"));
        assert_eq!(limit(&stale), 6);
        assert!(with_pace(&stale, |pace| pace.slow_start));
        // A pace with no store keeps nothing on disk.
        assert!(split_key("invented-acp\u{1f}pace-memory").is_none());
    }

    #[test]
    fn a_throttled_account_halves_holds_and_then_probes_up_one_turn_at_a_time() {
        let mut pace = Pace::new(4, 0);
        // A new account its demand keeps below its level does not grow,
        // however many clean turns finish.
        for clock in 0..50 {
            pace.finished(1, None, clock * HOLD_MS);
        }
        assert_eq!(pace.limit(), 4);
        pace.throttled("m", Some(4), 0);
        assert_eq!(pace.limit(), 2);
        // The rest of the burst sent at four answers nothing new.
        pace.throttled("m", Some(4), 1);
        pace.throttled("m", Some(4), 1);
        assert_eq!(pace.limit(), 2);
        // A turn sent at two that is refused too halves it again.
        pace.throttled("m", Some(2), 2);
        assert_eq!(pace.limit(), 1);
        pace.throttled("m", None, 2);
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
        // With no signal it keeps growing: no fixed most bounds an account.
        for _ in 0..20 {
            clock += HOLD_MS;
            for _ in 0..2 * pace.limit() {
                pace.finished(3, None, clock);
            }
        }
        assert!(pace.limit() > 8, "{}", pace.limit());
        // The lowest level the provider refused the model at (two; a lone
        // turn refused sets none) stood as its ceiling for an hour, and has
        // lapsed by now.
        assert_eq!(pace.limit_for("m", clock), pace.limit());
    }

    #[test]
    fn a_models_refused_level_stands_as_its_ceiling_for_an_hour() {
        let mut pace = Pace::new(4, 0);
        let mut clock = HOLD_MS;
        // A full clean round doubles the account to eight at once.
        round(&mut pace, clock);
        assert_eq!(pace.limit(), 8);
        // The provider refuses one model at eight: the account halves, and
        // that model's turns fly no more than eight at once for an hour.
        pace.throttled("slow", Some(8), clock);
        assert_eq!(pace.limit(), 4);
        assert_eq!(pace.limit_for("slow", clock), 4);
        for _ in 0..5 {
            clock += HOLD_MS;
            for _ in 0..2 * pace.limit() {
                pace.finished(1, None, clock);
            }
        }
        // The account grows on for its other models; the refused one stays
        // at the level it was refused at.
        assert!(pace.limit() > 8, "{}", pace.limit());
        assert_eq!(pace.limit_for("slow", clock), 8);
        assert_eq!(pace.limit_for("fast", clock), pace.limit());
        // A second refusal below the standing ceiling lowers it.
        pace.throttled("slow", Some(pace.limit()), clock);
        assert_eq!(pace.limit_for("slow", clock), 8.min(pace.limit()));
        pace.throttled("slow", Some(pace.limit()), clock + 1);
        assert!(pace.limit_for("slow", clock + 1) <= pace.limit());
        // An hour after the last refusal the ceiling lapses.
        let later = clock + 1 + CEILING_MS;
        assert_eq!(pace.limit_for("slow", later), pace.limit());
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
        // Four turns at 30 tokens per second stream 120 in all, less than
        // three quarters of two turns' 190.
        for _ in 0..COMPARABLE - 1 {
            pace.finished(4, Some(30.0), 0);
        }
        // Four slow samples are not yet comparable (their full round doubled
        // the level meanwhile); the fifth is.
        assert!(pace.limit() >= before);
        pace.finished(4, Some(30.0), 0);
        assert_eq!(pace.limit(), 3);
        assert!(!pace.speeds.contains_key(&4));
        // A slowdown sets no model ceiling: only a refusal does.
        assert!(pace.ceilings.is_empty());
        assert_eq!(pace.limit_for("m", 0), 3);
        // A slowdown ends slow start as a refusal does: full rounds no longer
        // double the level.
        assert!(!pace.slow_start);
        round(&mut pace, 0);
        assert_eq!(pace.limit(), 3);
        // With no lower level measured there is nothing to compare with: only
        // the full round at four doubled it.
        let mut alone = Pace::new(4, 0);
        for _ in 0..3 * COMPARABLE {
            alone.finished(4, Some(10.0), 0);
        }
        assert!(alone.slowed().is_none());
        assert_eq!(alone.limit(), 8);
        // Each stream slower at a higher level is no slowdown while the level
        // streams more in all (10-19: eleven Luna turns at three quarters of
        // seven turns' speed taught a ceiling of seven).
        let mut busier = Pace::new(4, 0);
        for _ in 0..COMPARABLE {
            busier.speeds.entry(7).or_default().push(100.0);
            busier.speeds.entry(11).or_default().push(75.0);
        }
        assert!(busier.slowed().is_none());
        // A level is held against the best lower level, not the nearest: four
        // turns streaming 140 in all are slower than two's 200, though not
        // than three's 160.
        let mut uneven = Pace::new(4, 0);
        for _ in 0..COMPARABLE {
            uneven.speeds.entry(2).or_default().push(100.0);
            uneven.speeds.entry(3).or_default().push(160.0 / 3.0);
            uneven.speeds.entry(4).or_default().push(35.0);
        }
        assert_eq!(uneven.slowed(), Some(4));
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
        record_throttle(first, "m", None, 0);
        assert_eq!(limit(first), super::super::ACCOUNT_SLOTS / 2);
        assert_eq!(limit(second), super::super::ACCOUNT_SLOTS);
        record_turn(second, "m", 1, Some(50.0), 0);
        assert_eq!(limit(second), super::super::ACCOUNT_SLOTS);
    }
}
