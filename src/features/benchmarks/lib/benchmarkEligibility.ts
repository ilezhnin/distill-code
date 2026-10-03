// What the service admits for a case and an attempt, mirrored so the UI never
// offers an action it refuses: routing::authored_by_candidate for planning,
// and the stored outcomes Service::rescore and Service::review accept.
import type { Configuration } from "../types";

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
