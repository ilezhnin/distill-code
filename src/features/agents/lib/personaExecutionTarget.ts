import {
  normalizeSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import {
  normalizeSessionRunSettings,
  type SessionRunSettings,
} from "@/features/chat/lib/sessionRunSettings";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";
import { resolveAgentProviderCatalogIdStrictFromEntries } from "@/features/providers/providerCatalog";
import { normalizeProviderKey } from "@/features/providers/lib/providerKey";
import { baseModelId } from "@/shared/lib/foldedModelId";
import type { Persona, UpdatePersonaRequest } from "@/shared/types/agents";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

interface AvailableHarness {
  id: string;
  label?: string;
}

interface AvailableModel {
  id: string;
  name?: string;
  displayName?: string;
  providerId?: string;
}

export interface PersonaTargetContext {
  providers: readonly AvailableHarness[];
  models: readonly AvailableModel[];
  getModelsForHarness?: (harnessId: string) => readonly AvailableModel[];
  catalogEntries: ProviderCatalogEntry[];
}

/**
 * Provider ids written by earlier app versions that no longer name a harness:
 * the built-in agent of earlier builds and the model providers it fronted.
 */
const LEGACY_PROVIDER_KEYS = new Set([
  "berd",
  "databricks",
  "databricks_v2",
  "databricks_ai_gateway",
  "anthropic",
  "openai",
  "google",
]);

function harnessIdForPersona(
  providerId: string | undefined,
  providers: readonly AvailableHarness[],
  catalogEntries: ProviderCatalogEntry[],
): string | undefined {
  if (!providerId) return undefined;
  const normalized = normalizeProviderKey(providerId);
  if (LEGACY_PROVIDER_KEYS.has(normalized)) return DEFAULT_HARNESS_ID;

  return (
    resolveAgentProviderCatalogIdStrictFromEntries(
      catalogEntries,
      providerId,
    ) ??
    providers.find(
      (provider) =>
        normalizeProviderKey(provider.id) === normalized ||
        (provider.label && normalizeProviderKey(provider.label) === normalized),
    )?.id
  );
}

export interface PersonaTargetOptions {
  /**
   * Refuse to name a model the harness does not report.
   *
   * Callers that ESTABLISH a session pass this. A model id the harness has
   * never heard of is not a preference the runtime can honour: the harness
   * answers `Invalid params`, and every send in that chat fails — a chat the
   * operator cannot rescue from inside the chat. Dropping to the harness'
   * own current model is the honest fallback.
   *
   * Readers that only INTERPRET stored data (personaTargetMigration) must
   * leave it off: for them an unmatched id means "inventory has not answered
   * yet", and clearing the operator's saved model on that basis would be the
   * silent substitution D5 forbids.
   */
  requireInstalledModel?: boolean;
}

/**
 * Convert saved agent metadata into a runtime target. An incomplete legacy
 * target is no override; callers must leave chat state alone.
 */
export function personaExecutionTarget(
  persona:
    | Pick<Persona, "provider" | "modelProviderId" | "model">
    | null
    | undefined,
  {
    providers,
    models,
    getModelsForHarness,
    catalogEntries,
  }: PersonaTargetContext,
  options: PersonaTargetOptions = {},
): SessionExecutionTarget | undefined {
  const harnessId = harnessIdForPersona(
    persona?.provider,
    providers,
    catalogEntries,
  );
  if (!harnessId) return undefined;

  const availableModels = getModelsForHarness?.(harnessId) ?? models;
  // The model half only: an effort once glued onto the id is a run setting,
  // and inventories list base ids.
  const modelId = baseModelId(persona?.model);
  const matchingModel = availableModels.find(
    (model) =>
      model.id === modelId &&
      (!model.providerId || model.providerId === harnessId),
  );

  // An empty list is "inventory has not answered", never "the model is gone" —
  // so only a harness that reported models can disqualify one of them.
  const inventoryDisownsModel =
    options.requireInstalledModel &&
    modelId != null &&
    availableModels.length > 0 &&
    !matchingModel;

  return normalizeSessionExecutionTarget({
    harnessId,
    modelProviderId: modelId && !inventoryDisownsModel ? harnessId : undefined,
    modelId: inventoryDisownsModel ? undefined : modelId,
    modelName: inventoryDisownsModel
      ? undefined
      : (matchingModel?.displayName ?? matchingModel?.name ?? modelId),
  });
}

/**
 * The run-settings intent a persona's single saved model carries, or
 * `undefined` when it states neither an effort nor fast mode.
 *
 * The single-model counterpart of `RankedPersonaTarget.runSettings`: whoever
 * establishes a session from `personaExecutionTarget` puts this beside it.
 */
export function personaRunSettings(
  persona: Pick<Persona, "effort" | "fastMode"> | null | undefined,
): SessionRunSettings | undefined {
  return normalizeSessionRunSettings({
    effort: persona?.effort,
    fast: persona?.fastMode,
  });
}

/**
 * Produce the durable repair for legacy agent metadata. `null` means the
 * saved target is already canonical.
 */
export function personaTargetMigration(
  persona: Pick<Persona, "provider" | "modelProviderId" | "model">,
  context: PersonaTargetContext,
): Pick<UpdatePersonaRequest, "provider" | "modelProviderId" | "model"> | null {
  const hasSavedTarget = Boolean(
    persona.provider || persona.modelProviderId || persona.model,
  );
  if (!hasSavedTarget) return null;

  const target = personaExecutionTarget(persona, context);
  if (!target) {
    // Clear only when the saved data itself proves it cannot form one target.
    const unknownHarness =
      Boolean(persona.provider) &&
      !harnessIdForPersona(
        persona.provider,
        context.providers,
        context.catalogEntries,
      );
    return unknownHarness
      ? { provider: null, modelProviderId: null, model: null }
      : null;
  }

  const canonicalProvider = target.harnessId;
  const canonicalModelProvider = target.modelProviderId ?? null;
  const canonicalModel = target.modelId ?? null;
  // Compared by base id, so a legacy folded `model` alone is never a reason to
  // repair: that would rewrite an operator's file and drop its effort half.
  if (
    persona.provider === canonicalProvider &&
    (persona.modelProviderId ?? null) === canonicalModelProvider &&
    (baseModelId(persona.model) ?? null) === canonicalModel
  ) {
    return null;
  }

  return {
    provider: canonicalProvider,
    modelProviderId: canonicalModelProvider,
    model: canonicalModel,
  };
}
