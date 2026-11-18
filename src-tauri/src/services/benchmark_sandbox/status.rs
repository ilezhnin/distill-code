//! The sandbox's own report: readiness, runtime identity, drift from this build, and account health.
use super::*;

#[derive(Clone, Debug)]
pub(crate) struct Status {
    pub revision: String,
    pub(super) accounts: Vec<(String, String)>,
    pub(super) account_health: BTreeMap<(String, String), AccountHealth>,
    /// Refreshes bench-auth could not settle, kept for the operator, by
    /// provider and account: how many attempts left one.
    pub(super) conflicts: BTreeMap<(String, String), u32>,
    /// Credential copies bench-clean kept aside after a failed save.
    pub(super) unsaved: u32,
}

#[derive(Clone, Debug)]
pub(super) struct AccountHealth {
    pub(super) mode: String,
    pub(super) state: String,
    pub(super) expires_at_ms: Option<i64>,
}

impl Status {
    pub fn require_account(&self, provider: &str, account: &str) -> io::Result<()> {
        valid_id(account)?;
        if !self
            .accounts
            .iter()
            .any(|(p, a)| p == provider && a == account)
        {
            return Err(io::Error::other(format!(
                "The {provider} account {account} is not signed in inside {DISTRIBUTION}; sign it in from its benchmark run dialog"
            )));
        }
        Ok(())
    }

    /// Local expiry evidence covers the entire admitted attempt plus cleanup.
    /// This is not a claim that a grant has been remotely authenticated.
    pub fn require_account_window(
        &self,
        provider: &str,
        account: &str,
        now_ms: i64,
        timeout_seconds: u32,
    ) -> io::Result<()> {
        self.require_account(provider, account)?;
        // These providers expose expiry metadata in bench-auth. Other
        // providers retain their existing sign-in and usage-policy checks
        // until their actual credential formats have a health adapter.
        if !matches!(provider, "claude" | "grok") {
            return Ok(());
        }
        if now_ms < 0 || timeout_seconds == 0 {
            return Err(io::Error::other("Invalid credential admission window"));
        }
        let health = self
            .account_health
            .get(&(provider.to_owned(), account.to_owned()))
            .ok_or_else(|| {
                io::Error::other(
                    "Sandbox credential health is unknown; inspect the account before admission",
                )
            })?;
        if health.mode == "unbounded" && health.state == "unknown" {
            // This mode makes no expiry claim (for example an API key). Its
            // existing account/usage policy remains responsible for admission.
            return Ok(());
        }
        let deadline = admission_deadline(now_ms, timeout_seconds)?;
        if health.mode != "oauth"
            || health.state != "current"
            || health.expires_at_ms.is_none_or(|expiry| expiry <= deadline)
        {
            return Err(io::Error::other(
                "Sandbox OAuth credentials do not cover the complete attempt and cleanup margin; drain active work and refresh or sign in before admission",
            ));
        }
        Ok(())
    }
}

/// The latest moment an attempt admitted at `now_ms` may still hold its
/// sandbox credentials: its time limit and the five-minute cleanup margin.
pub(crate) fn admission_deadline(now_ms: i64, timeout_seconds: u32) -> io::Result<i64> {
    now_ms
        .checked_add(i64::from(timeout_seconds) * 1000)
        .and_then(|value| value.checked_add(300_000))
        .ok_or_else(|| io::Error::other("Invalid credential admission window"))
}

pub(crate) fn valid_id(id: &str) -> io::Result<()> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(io::Error::other("Invalid sandbox attempt or account id"));
    }
    Ok(())
}

/// How long one sandbox observation answers the readiness checks after it.
/// An attempt checks readiness at each step of its preparation and again
/// for its receipt, and attempts on other lanes check side by side. Each
/// check used to start its own `bench-status`, which reads every pinned
/// executable inside the half-CPU control group: about six seconds, eight
/// times an attempt. Within this window the checks share the last
/// observation. Helper updates refuse while any job runs, and every native
/// receipt observes again after its turn ([`observe_now`]).
pub(crate) const OBSERVATION_REUSE: Duration = Duration::from_secs(10);

/// What the sandbox reported, shared by the checks within a reuse window of
/// the observation. One observation runs at a time per key, and the checks
/// that arrive meanwhile wait for it instead of starting their own. A failed
/// observation is never kept: the next check observes again.
pub(crate) struct Recent<K, T> {
    pub(super) reuse: Duration,
    pub(super) slots: std::sync::Mutex<BTreeMap<K, Observed<T>>>,
}

/// One key's last observation, when it started and when it finished,
/// locked while observing.
pub(super) type Observed<T> = Arc<tokio::sync::Mutex<Option<Observation<T>>>>;

pub(super) struct Observation<T> {
    pub(super) started: std::time::Instant,
    pub(super) finished: std::time::Instant,
    pub(super) value: T,
}

impl<K: Ord + Clone, T: Clone> Recent<K, T> {
    pub(crate) const fn new(reuse: Duration) -> Self {
        Self {
            reuse,
            slots: std::sync::Mutex::new(BTreeMap::new()),
        }
    }

    /// The value observed for `key` within the reuse window, else a new
    /// observation, which later checks then share. A `fresh` check takes
    /// only an observation that started after it asked, so every check that
    /// arrives while one runs shares the next: the state after the event
    /// that asked (a turn's end, a renewal), observed once for all of them.
    pub(crate) async fn get<E, F, O>(&self, key: K, fresh: bool, observe: O) -> Result<T, E>
    where
        O: FnOnce() -> F,
        F: std::future::Future<Output = Result<T, E>>,
    {
        let slot = {
            let mut slots = self
                .slots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Keys are runtime revisions; old ones go once nothing holds them.
            if slots.len() >= 32 {
                slots.retain(|_, slot| Arc::strong_count(slot) > 1);
            }
            Arc::clone(slots.entry(key).or_default())
        };
        let asked = std::time::Instant::now();
        let mut held = slot.lock().await;
        if let Some(last) = held.as_ref() {
            let current = if fresh {
                last.started >= asked
            } else {
                last.finished.elapsed() < self.reuse
            };
            if current {
                return Ok(last.value.clone());
            }
        }
        let started = std::time::Instant::now();
        // Boxed: readiness is awaited deep inside an attempt's preparation.
        let value = Box::pin(observe()).await?;
        *held = Some(Observation {
            started,
            finished: std::time::Instant::now(),
            value: value.clone(),
        });
        Ok(value)
    }

    /// Drops every kept observation, so the next check observes again: for
    /// an action of the app's own that changed what the sandbox reports.
    #[cfg(test)]
    pub(crate) fn forget(&self) {
        self.slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}

pub(super) static STATUS: Recent<(), Status> = Recent::new(OBSERVATION_REUSE);

/// Runtime identity is independent of credentials. Status separately exposes
/// redacted local health and expiry, never tokens or credential contents.
/// A check within [`OBSERVATION_REUSE`] of the last observation shares it.
pub(crate) async fn ready() -> io::Result<Status> {
    host_admission().await?;
    STATUS.get((), false, observe_status).await
}

/// A new observation, never an earlier one: the runtime as it is after a
/// turn, for the receipt sealed with that turn's evidence. Receipts that
/// arrive while one observation runs share the next.
pub(crate) async fn observe_now() -> io::Result<Status> {
    host_admission().await?;
    STATUS.get((), true, observe_status).await
}

pub(super) async fn observe_status() -> io::Result<Status> {
    // The CPU sampler answers only after its first second. Starting it with
    // the first status read means the first admission after an app start
    // already carries the host's load.
    let _ = host_cpu_permille();
    let status = parse_status(&status_report().await?)?;
    report_conflicts(&status);
    Ok(status)
}

/// What `bench-status` prints, unparsed: setup compares it with this build's
/// pins to choose a repair. Readiness reads it through [`ready`].
pub(crate) async fn status_report() -> io::Result<String> {
    let out = invoke(
        "/usr/local/sbin/bench-status",
        &[],
        None,
        128 * 1024,
        CONTROL_TIMEOUT,
    )
    .await?
    .require_success("status")?;
    if out.truncated {
        return Err(io::Error::other("Sandbox status exceeded its limit"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// How a sandbox report differs from what this build pins.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Drift {
    /// Every pinned line is present.
    Current,
    /// Only what the network-free helper update installs differs: helpers,
    /// the admission policy they enforce, or the network they set up.
    Helpers(Vec<String>),
    /// The runtime itself differs (Node, git, a provider tool or the boot
    /// configuration): only full provisioning installs it.
    Runtime(Vec<String>),
}

pub(super) fn valid_heavy_cap(cap: &str) -> bool {
    cap == "off" || cap.parse::<u8>().is_ok_and(|cap| (1..=8).contains(&cap))
}

/// The pinned lines `text` lacks, named by their key (never a digest), and
/// which repair installs them.
pub(crate) fn drift(text: &str) -> Drift {
    let lines: std::collections::BTreeSet<String> = text
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    let mut helpers = Vec::new();
    let mut runtime = Vec::new();
    let caps = text
        .lines()
        .filter_map(|line| line.strip_prefix("budget heavy-cap "))
        .collect::<Vec<_>>();
    if !matches!(caps.as_slice(), [cap] if valid_heavy_cap(cap)) {
        helpers.push("budget heavy-cap".to_owned());
    }
    for line in FIXED_BUDGET {
        if !lines.contains(line) {
            helpers.push(line.to_owned());
        }
    }
    for (name, bytes) in FILES {
        if !lines.contains(&format!("file {name} {}", resource_hash(bytes))) {
            // The boot configuration applies only after the distribution
            // restarts, which full provisioning does.
            let missing = format!("file {name}");
            if *name == "wsl.conf" {
                runtime.push(missing);
            } else {
                helpers.push(missing);
            }
        }
    }
    let pins: BTreeMap<String, String> = serde_json::from_str(include_str!(
        "../../../resources/benchmark-sandbox/runtime-pins.json"
    ))
    .expect("bundled runtime pins");
    for (key, expected) in pins {
        if !lines.contains(&format!("{key} {expected}")) {
            runtime.push(key);
        }
    }
    if !lines.contains("netns up") {
        helpers.push("netns up".to_owned());
    }
    if !runtime.is_empty() {
        runtime.extend(helpers);
        Drift::Runtime(runtime)
    } else if !helpers.is_empty() {
        Drift::Helpers(helpers)
    } else {
        Drift::Current
    }
}

pub(super) fn parse_status(text: &str) -> io::Result<Status> {
    let lines: Vec<Vec<&str>> = text
        .lines()
        .map(|line| line.split_whitespace().collect())
        .collect();
    let mut identity = BTreeMap::new();
    // Admission policy and aggregate are runtime identity (they are pinned
    // below); the operator's cap on CPU-heavy jobs and the jobs running are
    // operator state. Every attempt records what it was admitted under.
    let caps: Vec<&str> = text
        .lines()
        .filter_map(|line| line.strip_prefix("budget heavy-cap "))
        .collect();
    if !matches!(caps.as_slice(), [cap] if valid_heavy_cap(cap)) {
        return Err(io::Error::other(
            "capability_missing: the sandbox reports no valid heavy-job cap",
        ));
    }
    for line in FIXED_BUDGET {
        if !text.lines().any(|observed| observed == line) {
            return Err(io::Error::other(
                "capability_missing: required aggregate benchmark containment is missing",
            ));
        }
    }
    identity.insert("resourcePolicy".to_owned(), RESOURCE_POLICY.to_owned());
    for (name, bytes) in FILES {
        let expected = resource_hash(bytes);
        if !lines
            .iter()
            .any(|parts| parts == &["file", name, &expected])
        {
            return Err(io::Error::other(format!(
                "The sandbox file {name} is missing or changed; provision {DISTRIBUTION} from this build"
            )));
        }
        identity.insert(name.to_string(), expected);
    }
    let pins: BTreeMap<String, String> = serde_json::from_str(include_str!(
        "../../../resources/benchmark-sandbox/runtime-pins.json"
    ))?;
    for (key, expected) in pins {
        let found = lines
            .iter()
            .any(|parts| parts.join(" ") == format!("{key} {expected}"));
        if !found {
            return Err(io::Error::other(format!(
                "Sandbox runtime changed or missing: {key}"
            )));
        }
        identity.insert(key, expected);
    }
    if !lines.iter().any(|parts| parts == &["netns", "up"]) {
        return Err(io::Error::other(
            "Sandbox network is not ready; provision distill-bench",
        ));
    }
    let accounts = lines
        .iter()
        .filter_map(|parts| match parts.as_slice() {
            ["account", provider, account, "yes"] => {
                Some((provider.to_string(), account.to_string()))
            }
            _ => None,
        })
        .collect();
    let mut account_health = BTreeMap::new();
    for parts in &lines {
        if parts.first() != Some(&"account-health") {
            continue;
        }
        let [_, provider, account, mode, state, expiry] = parts.as_slice() else {
            return Err(io::Error::other("Malformed sandbox credential health"));
        };
        valid_id(provider)?;
        valid_id(account)?;
        if !matches!(*mode, "oauth" | "unbounded" | "unknown")
            || !matches!(
                *state,
                "current" | "expired" | "missing" | "invalid" | "unknown"
            )
        {
            return Err(io::Error::other("Unknown sandbox credential health"));
        }
        let expires_at_ms = if *expiry == "-" {
            None
        } else {
            Some(
                expiry
                    .parse::<i64>()
                    .map_err(|_| io::Error::other("Invalid sandbox credential expiry"))?,
            )
        };
        if expires_at_ms.is_some_and(|value| value <= 0)
            || account_health
                .insert(
                    (provider.to_string(), account.to_string()),
                    AccountHealth {
                        mode: mode.to_string(),
                        state: state.to_string(),
                        expires_at_ms,
                    },
                )
                .is_some()
        {
            return Err(io::Error::other("Conflicting sandbox credential health"));
        }
    }
    let mut conflicts = BTreeMap::new();
    for parts in &lines {
        if parts.first() != Some(&"account-conflict") {
            continue;
        }
        let [_, provider, account, count] = parts.as_slice() else {
            return Err(io::Error::other("Malformed sandbox credential conflict"));
        };
        valid_id(provider)?;
        valid_id(account)?;
        let count = count
            .parse::<u32>()
            .ok()
            .filter(|count| *count > 0)
            .ok_or_else(|| io::Error::other("Malformed sandbox credential conflict"))?;
        if conflicts
            .insert((provider.to_string(), account.to_string()), count)
            .is_some()
        {
            return Err(io::Error::other("Malformed sandbox credential conflict"));
        }
    }
    // Reported for the operator, never a reason to refuse the status.
    let unsaved = lines
        .iter()
        .find_map(|parts| match parts.as_slice() {
            ["auth-unsaved", count] => count.parse::<u32>().ok(),
            _ => None,
        })
        .unwrap_or(0);
    Ok(Status {
        revision: hex::encode(Sha256::digest(serde_json::to_vec(&identity)?)),
        accounts,
        account_health,
        conflicts,
        unsaved,
    })
}

/// Logs each sandbox account with credential conflicts once per count, and
/// the credential copies bench-clean kept aside after a failed save once per
/// count: the operator inspects what was kept and removes it (see the
/// benchmark operations guide). Admission goes on with the stored grant.
pub(super) fn report_conflicts(status: &Status) {
    static UNSAVED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let unsaved = status.unsaved;
    if UNSAVED.swap(unsaved, std::sync::atomic::Ordering::Relaxed) != unsaved && unsaved > 0 {
        log::warn!(
            "[benchmarks] {unsaved} credential copies of attempts whose save failed are kept in {DISTRIBUTION}:/srv/bench/auth-unsaved; recover them and remove them"
        );
    }
    static REPORTED: OnceLock<std::sync::Mutex<BTreeMap<(String, String), u32>>> = OnceLock::new();
    let mut reported = REPORTED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Records the operator removed are forgotten, so new ones are logged.
    reported.retain(|key, _| status.conflicts.contains_key(key));
    for ((provider, account), count) in &status.conflicts {
        if reported.insert((provider.clone(), account.clone()), *count) != Some(*count) {
            log::warn!(
                "[benchmarks] sandbox {provider} account {account} has {count} credential refresh conflict(s) kept in {DISTRIBUTION}:/var/lib/distill-bench/auth-conflicts/{account}/{provider}; inspect them and remove the records"
            );
        }
    }
}

/// [`ready`] within a native deadline: the shared observation of the last
/// seconds, or a new one the deadline bounds. Only a deadline that passes
/// is a timeout.
pub(crate) async fn ready_until(deadline_ms: u64) -> io::Result<Status> {
    let remaining = remaining_ms(deadline_ms)?;
    tokio::time::timeout(
        Duration::from_millis(remaining),
        STATUS.get((), false, observe_status),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Native sandbox deadline expired"))?
}
