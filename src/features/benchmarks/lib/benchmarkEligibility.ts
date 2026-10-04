// What the service admits for a case and an attempt, mirrored so the UI never
// offers an action it refuses: routing::authored_by_candidate for planning,
// the stored outcomes Service::rescore and Service::review accept, and the
// panel verdict analysis::judge_panel settles.
import type { Configuration, Evaluation } from "../types";

/**
 * A candidate is never planned on, nor scored on, a case it helped write.
 * Authors are lowercase needles in `environment.authoredBy`; one matches when
 * it appears in the model or provider ID.
 */
export function authoredByCandidate(
  environment: unknown,
  configuration: Pick<Configuration, "modelId" | "providerId">,
): boolean {
  if (!environment || typeof environment !== "object") return false;
  const authors = (environment as { authoredBy?: unknown }).authoredBy;
  if (!Array.isArray(authors)) return false;
  const model = configuration.modelId.toLowerCase();
  const provider = configuration.providerId.toLowerCase();
  return authors.some((author) => {
    if (typeof author !== "string") return false;
    const needle = author.trim().toLowerCase();
    return (
      needle.length > 0 && (model.includes(needle) || provider.includes(needle))
    );
  });
}

/**
 * Outcomes that carry a verdict another evaluation can replace. Budget
 * failures score a fixed 0; cancelled, excluded, refused and infrastructure
 * outcomes have no verdict at all.
 */
const EVALUATED_OUTCOMES = new Set([
  "pass",
  "fail",
  "completed",
  "evaluation_error",
  "pending_review",
  "judged",
]);

export function hasEvaluatedOutcome(
  outcome: string | null | undefined,
): boolean {
  return outcome != null && EVALUATED_OUTCOMES.has(outcome);
}

/**
 * Whether a judge panel reached a verdict. A batch runs from its render
 * marker to the next one and settles once its valid votes reach the marker's
 * `expectedJudges`; votes recorded before panels had markers stand alone.
 */
export function hasPanelVerdict(evaluations: Evaluation[]): boolean {
  const vote = (evaluation: Evaluation) =>
    evaluation.provenance === "judge" &&
    evaluation.score !== null &&
    Number.isFinite(evaluation.score) &&
    evaluation.score >= 0 &&
    evaluation.score <= 1;
  const markers = evaluations.flatMap((evaluation, index) =>
    evaluation.provenance === "render" ? [index] : [],
  );
  if (markers.length === 0) return evaluations.some(vote);
  return markers.some((start, position) => {
    const expected = evaluations[start].details?.expectedJudges;
    const votes = evaluations
      .slice(start, markers[position + 1] ?? evaluations.length)
      .filter(vote).length;
    return votes >= (typeof expected === "number" ? expected : 1);
  });
}
