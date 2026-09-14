import { baseModelId, sameModelIdentity } from "@/shared/lib/foldedModelId";
import type { ChatSessionReasoningEffortConfig } from "../stores/chatSessionStore";
import type { ModelOption } from "../types";
import type { StoredModelPreference } from "./modelPreferences";
import {
  normalizeSessionRunSettings,
  type SessionRunSettings,
  type SessionRunSettingsNotice,
} from "./sessionRunSettings";

/**
 * Stands in for a bridge config id on the effort menu a composer shows before
 * its session exists. It is display-only: a pre-session choice is recorded as
 * intent and reaches the bridge in `session/new`, never as a config write, so
 * nothing ever sends this id. It is deliberately not "effort", which is what
 * gates Ultracode — that stop needs a live Claude session to arm.
 */
export const PRE_SESSION_EFFORT_CONFIG_ID = "pre-session-effort";

export interface PreSessionRunSettingsInput {
  /** The inventory row of the model the composer has selected. */
  model?: ModelOption | null;
  /**
   * The selected model's id, for when its inventory row is not known yet — a
   * cold model cache. The value remembered for that model still applies; what
   * the model offers is then simply unknown.
   */
  modelId?: string | null;
  /** What the operator chose in this composer before a session existed. */
  desired?: SessionRunSettings;
  /** The agent's remembered preference, if any. */
  preference?: StoredModelPreference | null;
}

export interface PreSessionRunSettings {
  /**
   * The intent a chat created now should carry: only values the operator chose,
   * here or earlier. The model's own default effort is shown but never becomes
   * intent, or it would follow the chat onto the next model as if chosen.
   */
  intent: SessionRunSettings | undefined;
  /** The effort menu to render, or undefined when the model offers none. */
  reasoningEffort: ChatSessionReasoningEffortConfig | undefined;
  /** The fast value to show; false when nothing was chosen. */
  fast: boolean;
  /** Why the selected model will not run at a value the operator chose. */
  notice: SessionRunSettingsNotice | null;
}

/** The inventory row for a selected model id, compared by model identity. */
export function findModelOption(
  models: readonly ModelOption[],
  modelId: string | null | undefined,
  providerId?: string | null,
): ModelOption | undefined {
  if (!modelId) {
    return undefined;
  }
  const matches = models.filter((model) =>
    sameModelIdentity(model.id, modelId),
  );
  return (
    matches.find(
      (model) =>
        !providerId || !model.providerId || model.providerId === providerId,
    ) ?? undefined
  );
}

function modelOffersEffort(
  model: ModelOption | null | undefined,
  effort: string,
): boolean | undefined {
  if (!model?.efforts) {
    return undefined;
  }
  return model.efforts.some((option) => option.id === effort);
}

/**
 * Resolve the effort and fast mode a composer shows, and the intent it hands
 * to a new chat, before any session exists.
 *
 * The menus come from the selected model's inventory row — the reason
 * capabilities had to be in the inventory at all. The value resolves in the
 * order: this composer's own choice → the agent's remembered value for this
 * model → the agent-level value → the model's default (fast: off). A
 * remembered value is only taken where the model can honour it: Opus 4.6 has
 * no xhigh, and Haiku has no effort control at all.
 */
export function resolvePreSessionRunSettings({
  model,
  modelId,
  desired,
  preference,
}: PreSessionRunSettingsInput): PreSessionRunSettings {
  const modelKey = baseModelId(model?.id ?? modelId);
  const remembered = modelKey ? preference?.byModel?.[modelKey] : undefined;

  const rememberedEffort = [
    // A per-model value is that model's own, so it is taken while the menu is
    // still unknown; only a menu that lacks it rules it out.
    remembered?.reasoningEffort &&
    modelOffersEffort(model, remembered.reasoningEffort) !== false
      ? remembered.reasoningEffort
      : undefined,
    preference?.reasoningEffort &&
    modelOffersEffort(model, preference.reasoningEffort) === true
      ? preference.reasoningEffort
      : undefined,
  ].find((value) => value !== undefined);
  const effortIntent = desired?.effort ?? rememberedEffort;

  const rememberedFast =
    remembered?.fastMode !== undefined && model?.supportsFast !== false
      ? remembered.fastMode
      : preference?.fastMode !== undefined && model?.supportsFast === true
        ? preference.fastMode
        : undefined;
  const fastIntent = desired?.fast ?? rememberedFast;

  const intent = normalizeSessionRunSettings({
    effort: effortIntent,
    fast: fastIntent,
  });

  const options = model?.efforts ?? [];
  const offered = (value: string | null | undefined): value is string =>
    Boolean(value) && options.some((option) => option.id === value);
  const currentValue = offered(effortIntent)
    ? effortIntent
    : offered(model?.defaultEffort)
      ? model.defaultEffort
      : options[0]?.id;
  const reasoningEffort =
    options.length > 0 && currentValue
      ? {
          configId: PRE_SESSION_EFFORT_CONFIG_ID,
          currentValue,
          options,
        }
      : undefined;

  const modelName = model ? (model.displayName ?? model.name ?? model.id) : "";
  let notice: SessionRunSettingsNotice | null = null;
  if (
    model &&
    desired?.effort &&
    modelOffersEffort(model, desired.effort) === false
  ) {
    notice = {
      kind: "effort",
      wanted: desired.effort,
      actual: reasoningEffort?.currentValue ?? null,
      modelName,
    };
  } else if (model && desired?.fast === true && model.supportsFast === false) {
    notice = { kind: "fast", wanted: "on", actual: null, modelName };
  }

  return {
    intent,
    reasoningEffort,
    fast: fastIntent ?? false,
    notice,
  };
}
