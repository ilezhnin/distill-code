//! What a job was admitted under, kept with the attempt, and the class a job asks as.
use super::*;

/// The policy and the competing load the Linux broker admitted a
/// candidate session under. The attempt keeps it, so a speed comparison can
/// tell a run that had the sandbox to itself from one that shared it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    /// The admission policy (`measured-load-v1`: CPU-heavy jobs by the host's
    /// measured load under 70 %; `dynamic-v2`: repository sessions by measured
    /// use; `dynamic-v1`: every CPU-heavy job by its ceiling), or absent for
    /// the fixed heavy lanes before them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<String>,
    /// Heavy jobs (repository, browser, check, pair) the fixed policy ran at
    /// once; absent under the dynamic one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heavy_lanes: Option<u32>,
    /// The operator's cap on CPU-heavy jobs, where one was set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heavy_cap: Option<u32>,
    /// This job's lane: heavy, light or prep.
    pub lane: String,
    /// Jobs already admitted, by resource class, and how many were heavy.
    pub competing: BTreeMap<String, u32>,
    pub competing_heavy: u32,
    /// Memory (bytes) those jobs claimed (their reservations under the fixed
    /// policy), and the CPU ceilings of the CPU-heavy ones.
    pub reserved_memory: u64,
    pub reserved_cpu: u32,
    /// What this job was expected to need, the cores the CPU-heavy jobs could
    /// have, the CPUs the benchmark jobs used over the last sampled seconds,
    /// the guest's CPU pressure and how long recent checks waited for CPUs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_memory: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_pressure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_stall: Option<f64>,
    /// Logical CPUs the host left the benchmark jobs, the burst allowance
    /// counted per repository session, the repository sessions running, and
    /// which rule admitted a CPU-heavy job: `ceilings` (every CPU-heavy job
    /// by its ceiling, as before) or `measured` (by the sandbox's measured
    /// use).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_capacity: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_burst: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_sessions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted_by: Option<String>,
    /// Set on a later workflow step's session, admitted ahead of new attempts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuing: Option<bool>,
    /// Set on a timing-sensitive check: it started with its whole ceiling
    /// free and kept that ceiling while it ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<bool>,
    /// CPUs the whole guest worked and the host ran outside the VM over the
    /// last sampled seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outside_cpu: Option<f64>,
    /// Memory the benchmark cgroup actually used at admission.
    pub memory_current: u64,
    /// The WSL guest's 1, 5 and 15 minute load averages, CPUs and free memory.
    pub guest_load: [f64; 3],
    pub guest_cpus: u32,
    pub guest_mem_available: u64,
    /// Windows available RAM and commit headroom from the admission gate.
    pub host_available_ram: u64,
    pub host_available_commit: u64,
    /// Busy share of all Windows CPUs over the second before admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_cpu_busy: Option<f64>,
    /// Mean busy share of all Windows CPUs over the 30 seconds before
    /// admission, the window bench-budget's load line compares; the app
    /// records it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_cpu_mean: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_cpus: Option<u32>,
    /// What the memory guard counted (anonymous, shared and kernel memory)
    /// and the page cache beside it, in bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_in_use: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_file: Option<u64>,
    /// The sandbox clock minus the gate evidence's Windows time, transport
    /// included: a WSL clock drifted from Windows shows here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_gate_age_ms: Option<i64>,
}

pub(super) type PendingAdmissions = BTreeMap<String, (std::time::Instant, Admission)>;

pub(super) static SESSION_ADMISSIONS: OnceLock<std::sync::Mutex<PendingAdmissions>> =
    OnceLock::new();

pub(super) fn session_admissions() -> std::sync::MutexGuard<'static, PendingAdmissions> {
    SESSION_ADMISSIONS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn record_session_admission(id: &str, admission: Admission) {
    let mut admissions = session_admissions();
    // An attempt that ends before sealing evidence leaves its record behind;
    // none outlives the longest deadline the broker admits (24 h + 8 min).
    admissions.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(26 * 3600));
    admissions.insert(id.to_owned(), (std::time::Instant::now(), admission));
}

/// The admission of the candidate session in sandbox `id`, handed out once.
/// Absent after an app restart: the record lives only in this process.
pub(crate) fn take_session_admission(id: &str) -> Option<Admission> {
    session_admissions()
        .remove(id)
        .map(|(_, admission)| admission)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ResourceClass {
    Text,
    Repository,
    Browser,
    Preparation,
    PairedCheck,
    Check,
}

impl ResourceClass {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Repository => "repository",
            Self::Browser => "browser",
            Self::Preparation => "prep",
            Self::PairedCheck => "pair",
            Self::Check => "check",
        }
    }
}
