import type { Attempt } from "../types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Operational judging failures, separate from a candidate's failed test. */
export function judgingFailureLabel(
  t: Translate,
  reason: string,
  historical = false,
): string {
  const missing =
    /No judge panel: (\d+) eligible judge\(s\), at least (\d+) are required/.exec(
      reason,
    );
  if (missing)
    return t(historical ? "runIssues.noPanelRecorded" : "runIssues.noPanel", {
      available: missing[1],
      required: missing[2],
    });
  if (reason.startsWith("Critical checks unresolved"))
    return t("runIssues.criticalChecks");
  if (/Frozen judge/.test(reason))
    return t(
      historical ? "runIssues.judgeChangedRecorded" : "runIssues.judgeChanged",
    );
  if (/no valid score sheet/i.test(reason)) {
    const detail = reason.split("score sheet: ")[1];
    return `${t("runIssues.invalidSheet")}${detail ? ` ${detail}` : ""}`;
  }
  if (/judge panel is incomplete/i.test(reason))
    return t("runIssues.incompletePanel");
  return reason;
}

/** One cause per unscored repetition; partial panel votes are not a score. */
export function runJudgingIssues(
  attempts: readonly Attempt[],
  scores: ReadonlyMap<string, number | null>,
): { reason: string; count: number }[] {
  const causes = new Map<string, number>();
  for (const attempt of attempts) {
    if (
      attempt.phase !== "terminal" ||
      attempt.outcome !== "pending_review" ||
      !attempt.reason ||
      scores.get(attempt.id) != null
    )
      continue;
    const failure = attempt.evaluations
      .filter(
        (evaluation) =>
          evaluation.provenance === "judge_failure" &&
          !attempt.evaluations.some(
            (vote) =>
              vote.provenance === "judge" &&
              vote.score != null &&
              evaluation.judge != null &&
              vote.createdAt >= evaluation.createdAt &&
              vote.judge?.id === evaluation.judge?.id &&
              vote.details?.judgeBatchId === evaluation.details?.judgeBatchId,
          ),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.reason;
    const reason = failure?.startsWith("Critical checks unresolved")
      ? "Critical checks unresolved"
      : (failure ?? attempt.reason);
    causes.set(reason, (causes.get(reason) ?? 0) + 1);
  }
  return [...causes].map(([reason, count]) => ({ reason, count }));
}
