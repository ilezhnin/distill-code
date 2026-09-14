import type { ChatSessionReasoningEffortConfig } from "../stores/chatSessionStore";

export interface EffectiveReasoningEffortInput {
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
}

export interface EffectiveReasoningEffort {
  /** Selectable config powering the effort control. */
  config: ChatSessionReasoningEffortConfig | undefined;
  /** Applies an effort selection over the session config channel. */
  onSelect: (value: string) => void;
}

/**
 * Derives the reasoning-effort control for a composer surface from the one
 * place a harness states it: the session's own `thought_level` config — `effort`
 * on claude, `reasoning_effort` on codex and grok — applied back over the same
 * config channel under the bridge's own id.
 *
 * Nothing else is a source. The model id no longer carries an effort (the host
 * stopped folding one in), so there is no model list to collapse and no model
 * id to re-compose; and grok advertises a real writable `reasoning_effort`, so
 * the static ladder that used to stand in for it would only address a config id
 * grok rejects. With no session config there is no control at all.
 */
export function resolveEffectiveReasoningEffort(
  input: EffectiveReasoningEffortInput,
): EffectiveReasoningEffort {
  const sessionConfig = input.sessionReasoningEffort?.config;
  const ultracode = input.sessionReasoningEffort?.ultracode;
  // The configId gate inside supportsUltracode is what keeps Ultracode
  // Claude-only: codex also offers xhigh and max, but under its own
  // `reasoning_effort` id, which the host forwards unrenamed.
  const ultracodeCapable =
    ultracode != null && supportsUltracode(sessionConfig);
  const config =
    ultracodeCapable && sessionConfig
      ? {
          ...sessionConfig,
          currentValue: ultracode.armed
            ? ULTRACODE_OPTION_ID
            : sessionConfig.currentValue,
          options: [
            ...sessionConfig.options,
            { id: ULTRACODE_OPTION_ID, name: "Ultracode" },
          ],
        }
      : sessionConfig;

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
    input.sessionReasoningEffort?.onChange?.(value);
  };

  return { config, onSelect };
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
 * treatment on the track. Claude Code's synthetic Ultracode is one; codex's own
 * `ultra` effort value (Astra, Sol, Terra) is the same tier by another name, and
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
