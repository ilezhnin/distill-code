import type { ChatSessionReasoningEffortConfig } from "../stores/chatSessionStore";
import type { ModelOption } from "../types";
import {
  collapseEmbeddedReasoningModels,
  composeEmbeddedReasoningModelId,
  grokReasoningEffortConfig,
  splitEmbeddedReasoning,
  type CollapsedReasoningModels,
} from "./modelReasoningVariants";

export interface EffectiveReasoningEffortInput {
  availableModels: ModelOption[];
  currentModelId?: string | null;
  currentModelProviderId?: string | null;
  selectedAgentId: string;
  /** Session-advertised reasoning config and its ACP change channel. */
  sessionReasoningEffort?: {
    config?: ChatSessionReasoningEffortConfig;
    onChange?: (value: string) => void;
    /** Client-held Ultracode arm state (Claude Code sessions only). */
    ultracode?: {
      armed: boolean;
      setArmed: (armed: boolean) => void;
    };
  };
  /** Model change channel used when effort is embedded in the model id. */
  onModelChange?: (modelId: string, model?: ModelOption) => void;
}

export interface EffectiveReasoningEffort {
  /** Selectable config powering the effort control and wire-id composition. */
  config: ChatSessionReasoningEffortConfig | undefined;
  /** Applies an effort selection through the correct channel. */
  onSelect: (value: string) => void;
  /** True when effort is encoded in the model id (`model[effort]` variants). */
  usesModelEmbeddedReasoning: boolean;
  /** Embedded-variant collapse result, shared with the model picker. */
  collapsedModels: CollapsedReasoningModels;
}

/**
 * Derives the reasoning-effort control for a composer surface from whatever
 * the session and model list advertise:
 *
 * - a selectable session config (native goose `thinking_effort`, agent-bridge
 *   `thought_level` options) is used as-is and applied over the session config
 *   channel;
 * - model lists that embed effort in the model id (`grok-4[high]`) collapse
 *   into a synthesized config, and selections re-compose the wire model id via
 *   the model change channel;
 * - Grok sessions that only advertise a dummy non-selectable value fall back
 *   to the static Grok effort set.
 */
export function resolveEffectiveReasoningEffort(
  input: EffectiveReasoningEffortInput,
): EffectiveReasoningEffort {
  const collapsedModels = collapseEmbeddedReasoningModels(
    input.availableModels,
    input.currentModelId,
  );
  const sessionConfig = input.sessionReasoningEffort?.config;
  const sessionHasSelectableReasoning =
    (sessionConfig?.options.length ?? 0) > 1;
  // The static Grok ladder stands in for an agent that advertises a value but
  // no choices. It requires a session config all the same: the write path
  // addresses that config's id, so without one the ladder would be a control
  // whose selections have nowhere to go — stops that move nothing when clicked.
  const grokConfig =
    input.selectedAgentId === "grok-acp" &&
    sessionConfig != null &&
    !sessionHasSelectableReasoning &&
    collapsedModels.reasoning == null
      ? grokReasoningEffortConfig(sessionConfig.currentValue)
      : null;
  // Effort embedded in the model id wins over a session-advertised config.
  // The id is what goes on the wire, so `gpt-5.6-sol[ultra]` *is* the effective
  // effort; a provider that also advertises a parallel knob of its own (codex's
  // `reasoning_effort`, on its own scale) cannot override what the id already
  // encodes. Letting the session config win left the control reading "xhigh"
  // for a model pinned to [ultra], and flipping between the two scales as
  // snapshots arrived — the top stop appearing and vanishing between renders.
  const baseConfig =
    collapsedModels.reasoning ??
    (sessionHasSelectableReasoning
      ? sessionConfig
      : (grokConfig ?? sessionConfig));
  const usesModelEmbeddedReasoning = collapsedModels.reasoning != null;

  const ultracode = input.sessionReasoningEffort?.ultracode;
  const ultracodeCapable =
    ultracode != null &&
    !usesModelEmbeddedReasoning &&
    baseConfig === sessionConfig &&
    supportsUltracode(sessionConfig);
  const config =
    ultracodeCapable && baseConfig
      ? {
          ...baseConfig,
          currentValue: ultracode.armed
            ? ULTRACODE_OPTION_ID
            : baseConfig.currentValue,
          options: [
            ...baseConfig.options,
            { id: ULTRACODE_OPTION_ID, name: "Ultracode" },
          ],
        }
      : baseConfig;

  const onSelect = (value: string) => {
    if (ultracodeCapable && sessionConfig) {
      if (value === ULTRACODE_OPTION_ID) {
        // Ultracode rides on the model's top real effort; the per-send
        // keyword opt-in (see appendUltracodeKeyword) arms the standing
        // workflow orchestration the SDK couples to it.
        const top = topUltracodeEffortId(sessionConfig);
        if (top && sessionConfig.currentValue !== top) {
          input.sessionReasoningEffort?.onChange?.(top);
        }
        ultracode.setArmed(true);
        return;
      }
      if (ultracode.armed) {
        ultracode.setArmed(false);
      }
    }
    if (usesModelEmbeddedReasoning) {
      const baseId =
        splitEmbeddedReasoning(input.currentModelId)?.base ??
        input.currentModelId ??
        collapsedModels.models[0]?.id;
      if (!baseId) {
        return;
      }
      const wireId = composeEmbeddedReasoningModelId(
        baseId,
        value,
        collapsedModels,
      );
      const baseModel = collapsedModels.models.find(
        (model) => model.id === baseId,
      );
      input.onModelChange?.(
        wireId,
        baseModel ? { ...baseModel, id: wireId } : { id: wireId, name: wireId },
      );
      return;
    }
    input.sessionReasoningEffort?.onChange?.(value);
  };

  return { config, onSelect, usesModelEmbeddedReasoning, collapsedModels };
}

/**
 * Synthetic top slider stop for Claude Code sessions. Selecting it pins the
 * model's highest real effort level and arms the per-send `ultracode` keyword
 * — the SDK's official per-turn opt-in that upgrades the turn to standing
 * multi-agent workflow orchestration. The claude-agent-acp bridge exposes no
 * session-scoped ultracode setting over ACP, so the keyword is the only
 * channel a client can drive it through.
 */
export const ULTRACODE_OPTION_ID = "ultracode";
export const ULTRACODE_KEYWORD = "ultracode";

/**
 * Stops that sit past the top of an ordinary effort scale and earn the accented
 * treatment on the track. Claude Code's synthetic Ultracode is one; a model list
 * whose top variant is an `[ultra]` id is the same tier by another name, and
 * looked oddly plain next to it.
 */
const TOP_TIER_EFFORT_IDS: ReadonlySet<string> = new Set([
  ULTRACODE_OPTION_ID,
  "ultra",
]);

export function isTopTierEffortId(id: string | undefined | null): boolean {
  return id != null && TOP_TIER_EFFORT_IDS.has(id.trim().toLowerCase());
}

/**
 * Only the Claude Code bridge's own effort option qualifies: its config id is
 * "effort" and ultracode requires a model that can run the top effort tiers.
 */
export function supportsUltracode(
  config: ChatSessionReasoningEffortConfig | undefined,
): config is ChatSessionReasoningEffortConfig {
  return (
    config?.configId === "effort" &&
    config.options.some(
      (option) => option.id === "max" || option.id === "xhigh",
    ) &&
    !config.options.some((option) => option.id === ULTRACODE_OPTION_ID)
  );
}

function topUltracodeEffortId(
  config: ChatSessionReasoningEffortConfig,
): string | null {
  return (
    config.options.find((option) => option.id === "max")?.id ??
    config.options.find((option) => option.id === "xhigh")?.id ??
    null
  );
}

/** Appends the SDK's per-turn ultracode keyword to an outgoing prompt. */
export function appendUltracodeKeyword(text: string): string {
  if (!text.trim()) {
    return text;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1]?.trim().toLowerCase() === ULTRACODE_KEYWORD) {
    return text;
  }
  return `${text}\n\n${ULTRACODE_KEYWORD}`;
}

/** True when the config offers a real choice worth showing a control for. */
export function hasSelectableReasoningEffort(
  config: ChatSessionReasoningEffortConfig | undefined,
): config is ChatSessionReasoningEffortConfig {
  return Boolean(config?.configId) && (config?.options.length ?? 0) > 1;
}

export function toSentenceCaseLabel(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = /^[a-z0-9_-]+$/.test(trimmed)
    ? trimmed.replace(/[_-]+/g, " ")
    : trimmed;

  if (/[A-Z]{2,}/.test(normalized)) {
    return normalized;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

/** Display label for the currently selected effort, sentence-cased. */
export function selectedReasoningEffortLabel(
  config: ChatSessionReasoningEffortConfig,
): string {
  const selected = config.options.find(
    (option) => option.id === config.currentValue,
  );
  return toSentenceCaseLabel(selected?.name ?? config.currentValue);
}
