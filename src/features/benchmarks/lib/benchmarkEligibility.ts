// What the service admits for a case and an attempt, mirrored so the UI never
// offers an action it refuses: routing::authored_by_candidate for a
// candidate's own cases, the stored outcomes Service::rescore and
// Service::review accept, and the panel verdict analysis::judge_panel settles.
import type { Configuration, Evaluation } from "../types";

/**
 * Whether a candidate helped write a case. Authors in `environment.authoredBy`
 * name a provider, model and effort; all three must match. The case still runs
 * for its author, tagged: boards count its speed and cost, never its quality.
 * Legacy string needles cannot identify an author.
 */
// Declared harness aliases (`alias_of` in agent_host/harness.rs): an alias is
// the author of whatever the model it stands for wrote.
const MODEL_ALIASES: Record<string, Record<string, string>> = {
  "claude-acp": { default: "opus[1m]" },
};

// The model an id names whatever context window it asks for
// (runner::model_identity): Claude Code's `opus[1m]` is `opus`.
function modelIdentity(provider: string, modelId: string): string {
  const concrete = MODEL_ALIASES[provider]?.[modelId] ?? modelId;
  if (provider !== "claude-acp") return concrete;
  const variant = /^(.+)\[[^[]*\]$/.exec(concrete);
  return variant ? variant[1] : concrete;
}

export function authoredByCandidate(
  environment: unknown,
  configuration: Pick<Configuration, "modelId" | "providerId" | "effort">,
): boolean {
  if (!environment || typeof environment !== "object") return false;
  const authors = (environment as { authoredBy?: unknown }).authoredBy;
  if (!Array.isArray(authors)) return false;
  const normalize = (value: string) => value.trim().toLowerCase();
  const provider = normalize(configuration.providerId);
  const model = modelIdentity(provider, normalize(configuration.modelId));
  return authors.some((author) => {
    if (!author || typeof author !== "object" || Array.isArray(author))
      return false;
    const { providerId, modelId, effort } = author;
    if (
      typeof providerId !== "string" ||
      typeof modelId !== "string" ||
      !(effort === null || typeof effort === "string")
    )
      return false;
    const authorProvider = normalize(providerId);
    const authorModel = modelIdentity(authorProvider, normalize(modelId));
    return (
      authorProvider.length > 0 &&
      authorModel.length > 0 &&
      authorProvider === provider &&
      authorModel === model &&
      (effort === null ? null : normalize(effort)) ===
        (configuration.effort === null ? null : normalize(configuration.effort))
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
