//! What this build expects the sandbox to be: its distribution, helper files and fixed budget.
use super::*;

pub(crate) const DISTRIBUTION: &str = "distill-bench";

pub(super) const CONTROL_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) const TAIL_BYTES: usize = 8 * 1024;

macro_rules! resources {
    ($($name:literal),* $(,)?) => { &[$(( $name, include_bytes!(concat!(
        "../../../resources/benchmark-sandbox/", $name
    )).as_slice() )),*] };
}

pub(crate) const FILES: &[(&str, &[u8])] = resources![
    "bench-artifact",
    "bench-auth",
    "bench-browser",
    "bench-budget",
    "bench-check-prep",
    "bench-clean",
    "bench-copy",
    "bench-digest",
    "bench-enter",
    "bench-judge",
    "bench-kill",
    "bench-login",
    "bench-net",
    "bench-network",
    "bench-patch",
    "bench-run",
    "bench-run-inner",
    "bench-status",
    "bench-unpack",
    "browser-runtime.json",
    "wsl.conf",
];

pub(super) fn resource_hash(bytes: &[u8]) -> String {
    // Windows checkouts may use CRLF; Linux deployment canonicalizes source
    // files to LF. Bind runtime identity to the actual canonical bytes.
    let normalized: Vec<u8> = bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| {
            if *byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                None
            } else {
                Some(*byte)
            }
        })
        .collect();
    hex::encode(Sha256::digest(normalized))
}

pub(crate) const RESOURCE_POLICY: &str =
    "measured-load-v1-linux-memory23-cpu14-pids4096-io1024-256-job-read128-write32-light-read32-write8-disk8grow-inodes131072grow-weights10000-300-100-control1";

pub(super) const GIB: u64 = 1024 * 1024 * 1024;

/// Budget lines the broker reports: the aggregate every admitted job shares
/// (memory, CPUs and processes with the supervisors' own share on top) and
/// each job's own scratch IO ceiling (read/write bytes per second). Under the
/// dynamic policy no line depends on how many jobs run; admission measures
/// that instead (see bench-budget).
pub(super) const FIXED_BUDGET: [&str; 9] = [
    "budget admission measured-load-v1",
    "budget memory 25769803776",
    "budget cpu 1500000/100000",
    "budget pids 4224",
    "budget io 1073741824/268435456",
    "budget swap 0",
    "budget disk dynamic 8589934592",
    "budget inodes dynamic 131072",
    "budget job-io heavy 134217728/33554432 prep 134217728/33554432 light 33554432/8388608",
];
