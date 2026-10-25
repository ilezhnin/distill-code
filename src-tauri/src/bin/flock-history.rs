//! `flock-history compact <path to agent-host.db>`
//!
//! Rewrites a chat history database Flock is not running on so that every
//! stored turn takes the form its replay reads (the streamed pieces of a
//! message joined, running tool calls without the output their final update
//! repeats), then vacuums the file. The host does the same for each new turn
//! and, once, in the background; this does it now, on a closed database.
use std::path::PathBuf;
use std::time::Instant;

use levocat_flock_lib::history_maintenance::{self, CompactionStats};

const USAGE: &str = "usage: flock-history compact <path to agent-host.db>\n\nClose Flock first: the database must not be open.";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [command, path] = args.as_slice() else {
        eprintln!("{USAGE}");
        std::process::exit(2);
    };
    if command != "compact" {
        eprintln!("{USAGE}");
        std::process::exit(2);
    }
    let path = PathBuf::from(path);
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start: {error}");
            std::process::exit(1);
        }
    };
    let started = Instant::now();
    let mut sessions = 0usize;
    let mut running = CompactionStats::default();
    let result = runtime.block_on(history_maintenance::compact(&path, |_, stats| {
        sessions += 1;
        running.add(stats);
        if sessions % 500 == 0 {
            eprintln!(
                "{sessions} sessions: {} -> {} rows, {} -> {} MB",
                running.rows_before,
                running.rows_after,
                megabytes(running.bytes_before),
                megabytes(running.bytes_after)
            );
        }
    }));
    match result {
        Ok((total, vacuumed)) => {
            println!(
                "compacted {sessions} session(s) in {:.0?}: {} -> {} rows, {} -> {} MB of events{}",
                started.elapsed(),
                total.rows_before,
                total.rows_after,
                megabytes(total.bytes_before),
                megabytes(total.bytes_after),
                if vacuumed {
                    "; file vacuumed"
                } else {
                    "; nothing to vacuum (an earlier pass was already complete)"
                }
            );
        }
        Err(error) => {
            eprintln!("history compaction failed: {error}");
            std::process::exit(1);
        }
    }
}

fn megabytes(bytes: usize) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}
