import type { Attempt } from "../types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

// Only the runner's bounded vocabulary is displayable. Never echo the tail of
// an inventory error: it may contain account IDs, paths or provider output.
function discoveryLabels(
  t: Translate,
  suffix: string,
  historical: boolean,
): string[] | null {
  if (suffix.length > 800) return null;
  const rejection =
    ". A judge rejected this request; recovery needs another calibrated judge from the pool";
  const rejected = suffix.startsWith(rejection);
  if (rejected) suffix = suffix.slice(rejection.length);
  const prefix = ". Judge availability: ";
  if (!suffix.startsWith(prefix) || !suffix.endsWith(".")) return null;
  const entries = suffix.slice(prefix.length, -1).split("; ");
  if (entries.length < 1 || entries.length > 5) return null;
  const providers = new Set<string>();
  const labels: string[] = [];
  for (const entry of entries) {
    const match =
      /^(Claude|Codex|Grok|Kimi|Z\.ai): (local text policy verification required|benchmark runtime unavailable|model inventory unavailable)$/.exec(
        entry,
      );
    if (!match || match[0] !== entry || providers.has(match[1])) return null;
    providers.add(match[1]);
    const key =
      match[2] === "local text policy verification required"
        ? historical
          ? "runIssues.discoveryPolicyRecorded"
          : "runIssues.discoveryPolicy"
        : match[2] === "benchmark runtime unavailable"
          ? historical
            ? "runIssues.discoveryRuntimeRecorded"
            : "runIssues.discoveryRuntime"
          : historical
            ? "runIssues.discoveryInventoryRecorded"
            : "runIssues.discoveryInventory";
    labels.push(t(key, { provider: match[1] }));
  }
  return rejected
    ? [
        t(
          historical
            ? "runIssues.discoveryRecoveryRecorded"
            : "runIssues.discoveryRecovery",
        ),
        ...labels,
      ]
    : labels;
}

/** Evidence preserves legacy details unless the complete owned grammar matches. */
export function judgePanelEvidenceLabel(t: Translate, reason: string): string {
  const count =
    /^No judge panel: (\d+) eligible judge\(s\), at least (\d+) are required/.exec(
      reason,
    );
  if (!count) return reason;
  const suffix = reason.slice(count[0].length);
  if (suffix && discoveryLabels(t, suffix, false) === null) return reason;
  return judgingFailureLabel(t, reason);
}

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
  if (missing) {
    const label = t(
      historical ? "runIssues.noPanelRecorded" : "runIssues.noPanel",
      {
        available: missing[1],
        required: missing[2],
      },
    );
    const details =
      missing.index === 0
        ? (discoveryLabels(t, reason.slice(missing[0].length), historical) ??
          [])
        : [];
    return [label, ...details].join(" ");
  }
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
