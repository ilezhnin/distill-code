// What a run plan owes, counted the way `preview_run` counts it before the
// service admits the plan.
import type { BenchmarkVersion, Configuration } from "../types";
import { authoredByCandidate } from "./benchmarkEligibility";

/** Judge calls reserved per judged case (runner::MAX_JUDGES). */
export const JUDGE_CALLS = 3;

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
