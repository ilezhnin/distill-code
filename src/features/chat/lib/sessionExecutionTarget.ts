import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

interface HarnessExecutionTarget {
  readonly harnessId: string;
  readonly modelProviderId?: never;
  readonly modelId?: never;
  readonly modelName?: never;
}

interface ModelProviderExecutionTarget {
  readonly harnessId: string;
  readonly modelProviderId: string;
  readonly modelId?: never;
  readonly modelName?: never;
}

export interface ModelExecutionTarget {
  readonly harnessId: string;
  readonly modelProviderId: string;
  readonly modelId: string;
  readonly modelName: string;
}

export type SessionExecutionTarget =
  | HarnessExecutionTarget
  | ModelProviderExecutionTarget
  | ModelExecutionTarget;

export type ModelLessSessionExecutionTarget =
  | HarnessExecutionTarget
  | ModelProviderExecutionTarget;

interface SessionExecutionTargetInput {
  harnessId: string;
  modelProviderId?: string | null;
  modelId?: string | null;
  modelName?: string | null;
}

interface AgentModelSelectionInput {
  modelProviderId: string;
  modelId?: string | null;
  modelName?: string | null;
}

interface SessionExecutionModelSnapshot {
  modelId: string;
  modelName: string;
}

/**
 * The one gate every session execution target passes through.
 *
 * PROVENANCE RULE for `modelId`. A concrete model id put on a session is not
 * a preference the runtime is free to interpret — it is forwarded to the
 * harness verbatim (goose sends it as
 * `session/set_config_option("model", <id>)`). A harness that does not know
 * the id answers `Invalid params`, and because that call happens inside
 * `stream()` the failure lands on EVERY send: the chat is unusable and cannot
 * be repaired from inside itself. That is the codex-acp P0.
 *
 * So a caller may only name a `modelId` here when it is one of:
 *   (a) confirmed by the harness' own inventory — a model list the provider
 *       actually reported, checked for authority
 *       (`isCachedModelInventoryAuthoritative`), not the last list the cache
 *       happens to still hold; or
 *   (b) the operator's explicit choice in the composer's model pill (or the
 *       equivalent explicit instruction, e.g. a berdctl `model_id`), which is
 *       theirs to get wrong and theirs to change back; or
 *   (c) the harness' own report of what the session is already running.
 *
 * When neither holds, omit `modelId` — the resulting target runs on the
 * harness' current model, which always works. Substituting some OTHER
 * concrete model instead is the silent substitution D5 forbids.
 *
 * `sessionExecutionTargetProvenance.test.ts` pins the list of modules allowed
 * to mint a target, so a new one has to state which of (a)/(b)/(c) it is.
 * This function cannot check provenance itself — it sees an id, not where the
 * id came from — which is exactly why the rule is written down here.
 */
export function normalizeSessionExecutionTarget(
  target: SessionExecutionTargetInput,
): SessionExecutionTarget {
  const harnessId = target.harnessId.trim();
  if (!harnessId) {
    throw new Error("Session execution target requires a harness id.");
  }

  const modelProviderId = target.modelProviderId?.trim() || undefined;
  const modelId = normalizeConcreteModelId(target.modelId);
  if (modelId && !modelProviderId) {
    throw new Error("Session model selection requires a model provider id.");
  }
  if (modelId && harnessId === "goose" && modelProviderId === harnessId) {
    throw new Error(
      "Goose model selection requires a concrete model provider.",
    );
  }

  if (!modelProviderId) {
    return { harnessId };
  }
  if (!modelId) {
    return { harnessId, modelProviderId };
  }
  return {
    harnessId,
    modelProviderId,
    modelId,
    modelName: target.modelName || modelId,
  };
}

export function targetFromAgentModelSelection(
  harnessId: string,
  model?: AgentModelSelectionInput | null,
): SessionExecutionTarget {
  return normalizeSessionExecutionTarget({
    harnessId,
    modelProviderId: model?.modelProviderId,
    modelId: model?.modelId,
    modelName: model?.modelName,
  });
}

/** Materialize a model snapshot only when its provider identity is known. */
export function materializeSessionExecutionModel(
  target: SessionExecutionTarget | null | undefined,
  model: SessionExecutionModelSnapshot,
): ModelExecutionTarget | null {
  if (!target) {
    return null;
  }
  const modelProviderId =
    target.modelProviderId ??
    (target.harnessId === "goose" ? undefined : target.harnessId);
  if (!modelProviderId) {
    return null;
  }

  const materialized = normalizeSessionExecutionTarget({
    ...target,
    modelProviderId,
    modelId: model.modelId,
    modelName: model.modelName,
  });
  return isModelExecutionTarget(materialized) ? materialized : null;
}

export function sameSessionExecutionTarget(
  left: SessionExecutionTarget | null | undefined,
  right: SessionExecutionTarget | null | undefined,
): boolean {
  return (
    left?.harnessId === right?.harnessId &&
    left?.modelProviderId === right?.modelProviderId &&
    left?.modelId === right?.modelId
  );
}

export function isModelExecutionTarget(
  target: SessionExecutionTarget,
): target is ModelExecutionTarget {
  return target.modelId !== undefined;
}
