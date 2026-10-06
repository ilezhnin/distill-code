// What a run plan owes, counted the way `preview_run` counts it before the
// service admits the plan.
import type { BenchmarkVersion, Configuration } from "../types";
import { authoredByCandidate } from "./benchmarkEligibility";

/** Judge calls reserved per judged case (runner::MAX_JUDGES). */
export const JUDGE_CALLS = 3;

/**
 * Repetitions a measurement needs before a case counts, and a case counts
 * only when every one of them passed (analysis::REQUIRED_REPETITIONS). A run
 * of fewer is a quick check that never enters a board.
 */
export const REQUIRED_REPETITIONS = 3;

/**
 * How long a run stays open after it started (analysis::RUN_WINDOW_MS): the
 * window in which its unfinished cases may still be measured. Once it closes
 * the run is final, complete cells kept and the rest dropped.
 */
export const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** When a run's window closes. */
export function runWindowCloses(run: { createdAt: number }): number {
  return run.createdAt + RUN_WINDOW_MS;
}

/** Whether a run may still be finished: its window is open and it is not baked. */
export function runWindowOpen(
  run: { createdAt: number; bakedAt?: number | null },
  now: number,
): boolean {
  return run.bakedAt == null && now < runWindowCloses(run);
}

/**
 * Every turn one repetition of `versions` takes on `configuration`: each
 * workflow step plus the judge reservation of a judged case. A candidate owes
 * nothing on a case it wrote.
 */
export function plannedTurns(
  versions: readonly BenchmarkVersion[],
  configuration: Pick<Configuration, "modelId" | "providerId">,
): number {
  return versions.reduce(
    (total, version) =>
      authoredByCandidate(version.manifest.environment, configuration)
        ? total
        : total +
          (version.manifest.workflow?.steps.length ?? 1) +
          (version.manifest.evaluator.kind === "rubric" ? JUDGE_CALLS : 0),
    0,
  );
}
