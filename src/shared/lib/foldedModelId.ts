import { normalizeConcreteModelId } from "./modelIdentity";

/**
 * A folded model id — `gpt-5.6-sol[ultra]` — is Distill's own invention: a
 * model and a reasoning effort glued into one string. They are separate
 * selections, so nothing writes such an id any more. This module is the app's
 * only reader of the ones already written down: stored preferences, persisted
 * sessions, run journals, telemetry, and distillctl clients that memorised them.
 *
 * There is deliberately no compose function. Folding can only come back by
 * someone adding one here, which is a reviewable change.
 *
 * Sunset by condition, not by date: this module can go once no
 * `sessions.legacy_model_id` rows remain and no pre-protocolVersion-6 distillctl
 * clients are in use.
 */

/**
 * Effort words that ever appeared as a folded suffix. `1m` is deliberately
 * absent: it is a context lane, not an effort, so `opus[1m]`,
 * `claude-fable-5[1m]` and `claude-fable-5-1[1m]` are whole model ids that the
 * Claude harness matches exactly and that must never be split.
 */
const LEGACY_EFFORT_SUFFIXES = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "none",
  "off",
  "think",
  "thinking",
  "ultrathink",
] as const;

const LEGACY_EFFORTS = new Set<string>(LEGACY_EFFORT_SUFFIXES);

/** `base[effort]`, with no bracket on either side, so `a[low][high]` is not folded. */
const FOLDED_MODEL_ID = /^([^[\]]+)\[([^[\]]+)\]$/;

export interface LegacyFoldedModelId {
  modelId: string;
  effort: string;
}

/** The two halves of a folded id, or null when the id names only a model. */
export function splitLegacyFoldedModelId(
  id?: string | null,
): LegacyFoldedModelId | null {
  const match = id?.trim().match(FOLDED_MODEL_ID);
  if (!match) {
    return null;
  }
  const effort = match[2].toLowerCase();
  if (!LEGACY_EFFORTS.has(effort)) {
    return null;
  }
  const modelId = match[1].trimEnd();
  return modelId ? { modelId, effort } : null;
}

/** The model half of an id, whichever form it arrived in. */
export function baseModelId(id?: string | null): string | undefined {
  const folded = splitLegacyFoldedModelId(id);
  return folded ? folded.modelId : normalizeConcreteModelId(id);
}

/**
 * Whether two ids name the same model. The effort half is not part of a
 * model's identity, so a folded id and its base are the same model; two blank
 * ids are the same absence of one.
 */
export function sameModelIdentity(
  a?: string | null,
  b?: string | null,
): boolean {
  return baseModelId(a) === baseModelId(b);
}
