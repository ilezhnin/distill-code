//! One process runs the benchmarks kept in a Flock folder. A second Flock on
//! the same folder starts beside the first whenever its identifier differs (a
//! development build next to the installed app), and single-instance cannot
//! see it. Opening the benchmarks there took the live runs for a crashed
//! process's: its recovery marked their attempts interrupted, ended their
//! sandbox sessions and stopped the runs (10-31). The operating system lets
//! the lock go when its process ends, a crash included, so recovery after a
//! real crash still runs.
use super::types::{BenchmarkError, Result};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

/// The file whose lock makes a process the benchmark folder's owner.
const LOCK: &str = "owner.lock";

/// What a process is told while another one owns the benchmark folder.
pub(super) const ELSEWHERE: &str = "Benchmarks are open in another Flock that uses this data folder, such as a development build next to the installed app. Close it to use benchmarks here; its runs are left as they are.";

/// Claims the benchmark folder `root` for this process: the lock lasts as
/// long as the returned file stays open.
pub(super) fn claim(root: &Path) -> Result<File> {
    std::fs::create_dir_all(root)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(LOCK))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(BenchmarkError::new("storage_unavailable", ELSEWHERE)),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_has_one_owner_until_it_lets_go() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("benchmarks");
        let first = claim(&root).unwrap();
        let refused = claim(&root).unwrap_err();
        assert_eq!(refused.code, "storage_unavailable");
        assert_eq!(refused.message, ELSEWHERE);
        drop(first);
        claim(&root).unwrap();
    }
}
