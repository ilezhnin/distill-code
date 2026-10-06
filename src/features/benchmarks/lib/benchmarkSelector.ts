import {
  isModelPreferenceClassId,
  MODEL_PREFERENCE_CLASSES,
  pickCandidateMatch,
} from "@/features/agents/lib/modelRanking";
import type { Configuration } from "../types";

/**
 * A class's persona ranking as the measured configurations that answer it,
 * best first: each ranked candidate's model on its platform at its effort.
 * The selector falls back to it while evidence is short, and the harness
 * scores it as the persona policy.
 */
export function personaPrior(
  workClassId: string,
  configurations: readonly Configuration[],
): Configuration[] {
  if (!isModelPreferenceClassId(workClassId)) return [];
  const prior: Configuration[] = [];
  for (const candidate of MODEL_PREFERENCE_CLASSES[workClassId].ranking) {
    const pool = configurations.filter(
      (configuration) =>
        (!candidate.platform ||
          configuration.providerId === candidate.platform) &&
        (!candidate.effort || configuration.effort === candidate.effort),
    );
    const match = pickCandidateMatch(candidate, pool, (configuration) => ({
      id: configuration.modelId,
      displayName: configuration.modelName ?? undefined,
      providerId: configuration.providerId,
    }));
    if (match && !prior.includes(match)) prior.push(match);
  }
  return prior;
}

/** A mean reward, 0 to 1, as points out of 1000. */
export function rewardPoints(reward: number): number {
  return Math.round(reward * 1000);
}
