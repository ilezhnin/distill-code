// What the runner is doing now, read from run summaries: the sidebar, the
// Benchmarks pages and a model's rows show it while runs have work left.
import type { Configuration, LeaderboardRow, RunSummary } from "../types";
import { requests } from "./benchmarkCatchUp";

/** Runs that dispatch now. */
export function activeRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter(
    (run) =>
      !run.request.preview &&
      (run.state === "running" || run.state === "pausing"),
  );
}

/** Runs that stopped on their own and wait for the operator. */
export function stalledRuns(runs: RunSummary[]): RunSummary[] {
  return runs.filter(
    (run) => !run.request.preview && run.state === "needs_attention",
  );
}

/** Attempts settled and planned over `runs`, and their cells running now. */
export function runProgress(runs: RunSummary[]): {
  settled: number;
  total: number;
  running: number;
} {
  let settled = 0;
  let total = 0;
  let running = 0;
  for (const run of runs) {
    settled += run.settledCount;
    total += run.attemptCount;
    running += (run.openCells ?? []).filter((cell) => cell.running).length;
  }
  return { settled, total, running };
}

/** The configurations of `run` with a cell running now. */
export function runningConfigurations(run: RunSummary): Configuration[] {
  const ids = new Set(
    (run.openCells ?? [])
      .filter((cell) => cell.running)
      .map((cell) => cell.configurationId),
  );
  return run.request.configurations.filter((entry) => ids.has(entry.id));
}

/**
 * A row's cells still open in active runs, those running now, and the newest
 * such run.
 */
export function rowActivity(
  row: LeaderboardRow,
  runs: RunSummary[],
): { open: number; running: number; runId: string | null } {
  let open = 0;
  let running = 0;
  let newest: RunSummary | null = null;
  for (const run of activeRuns(runs)) {
    const ids = new Set(
      run.request.configurations
        .filter((entry) => requests(entry, row.configuration, run))
        .map((entry) => entry.id),
    );
    for (const cell of run.openCells ?? []) {
      if (!ids.has(cell.configurationId)) continue;
      open += 1;
      if (cell.running) running += 1;
      if (!newest || run.createdAt > newest.createdAt) newest = run;
    }
  }
  return { open, running, runId: newest?.id ?? null };
}
