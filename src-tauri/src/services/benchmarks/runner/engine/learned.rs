//! What a run learned while it runs, kept in memory by one owner: when its
//! accounts first refused for quota, which of them are exhausted or held and
//! until when, how many turns the infrastructure ended in a row, and what
//! waits for the operator. A restart forgets it, and the operator's resume
//! drops it whole ([`forget`]), so everything of the run asks again.
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, PoisonError};

/// One run's entries, each keyed by what it speaks for: a provider, an
/// account (its quota scope) or a cell.
#[derive(Default)]
pub(super) struct Learned {
    /// When an account first refused for quota, while the run waits on it.
    pub(super) quota_since: HashMap<String, i64>,
    /// Accounts whose usage limit ran out, until their reset.
    pub(super) exhausted: HashMap<String, i64>,
    /// Providers and accounts whose cells are held until a time.
    pub(super) holds: HashMap<String, i64>,
    /// Turns of an account an infrastructure failure ended in a row.
    pub(super) streaks: HashMap<String, u32>,
    /// Accounts and cells left for the operator.
    pub(super) left: HashSet<String>,
}

static RUNS: LazyLock<Mutex<HashMap<String, Learned>>> = LazyLock::new(Default::default);

/// Reads or changes what `run_id` learned, as one step.
pub(super) fn of<R>(run_id: &str, with: impl FnOnce(&mut Learned) -> R) -> R {
    let mut runs = RUNS.lock().unwrap_or_else(PoisonError::into_inner);
    // Read on every dispatch: a run already known costs no allocation.
    if !runs.contains_key(run_id) {
        runs.insert(run_id.to_owned(), Learned::default());
    }
    with(runs.get_mut(run_id).expect("the run's entry"))
}

/// Drops everything `run_id` learned.
pub(super) fn forget(run_id: &str) {
    RUNS.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(run_id);
}

/// Until when `key` is in `until`, while that time is ahead of `now`; an
/// entry whose time passed is dropped.
pub(super) fn ahead(until: &mut HashMap<String, i64>, key: &str, now: i64) -> Option<i64> {
    match until.get(key) {
        Some(time) if *time > now => Some(*time),
        Some(_) => {
            until.remove(key);
            None
        }
        None => None,
    }
}
