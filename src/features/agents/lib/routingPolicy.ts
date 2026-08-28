/**
 * How aggressively the app moves work off a platform that is running out, and
 * which models each complexity class prefers (P36-P38).
 *
 * Two settings that were constants in the source. Both are policy: what counts
 * as "running out" depends on how the operator pays for these platforms, and
 * the class rankings were transcribed from one conversation on one day. A
 * constant is the right shape for a fact and the wrong one for a preference —
 * and this preference is the difference between a weekly allowance that lasts
 * the week and one that is gone by Tuesday on work that did not need it.
 *
 * Nothing here decides anything. It holds the numbers and the lists;
 * `resolveRankedCandidates` still does the choosing, and D5 still applies —
 * a step that ends up somewhere other than its first choice says so.
 */

import type { ModelPreferenceClassId } from "./modelRanking";

/**
 * Percent of a window that has to be spent before new work goes elsewhere.
 *
 * Separate numbers for waves and for ordinary chats because they are not the
 * same risk. A wave spawns several sessions at once against the same meter
 * and its steps run unattended, so a step cut off mid-flight is work lost
 * with nobody watching; the operator's own chat is one session with a person
 * in front of it who can react. The wave number is therefore the cautious one
 * by default.
 */
export interface RoutingPolicy {
  /** Window fullness at which a wave step should prefer another platform. */
  waveNearLimitPercent: number;
  /** The same for an ordinary chat's own model resolution. */
  chatNearLimitPercent: number;
  /**
   * The operator's own ranking per class, as candidate labels in order.
   *
   * Labels rather than model ids: the built-in candidates are matched fuzzily
   * against a live inventory whose ids change with every provider update, and
   * a stored id would rot. A class with no entry here uses the built-in list.
   */
  classOverrides: Partial<Record<ModelPreferenceClassId, string[]>>;
}

/**
 * Defaults, matching what the constants said before they were settings.
 *
 * 85 for waves rather than 90: the point of the wave number being separate is
 * that it can be more cautious, and a five-step wave against one weekly
 * allowance is exactly the case that finishes the window.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  waveNearLimitPercent: 85,
  chatNearLimitPercent: 90,
  classOverrides: {},
};

/** Where the policy lives under the Distill root. */
export const ROUTING_POLICY_DOCUMENT = "routing.json";

function clampPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  // Below 50 the setting stops being "prefer another platform" and becomes
  // "never use this one"; above 100 it can never fire. Both are almost
  // certainly a typo rather than an intent.
  return Math.min(100, Math.max(50, Math.round(value)));
}

/**
 * Reads a stored policy, keeping what is usable and defaulting the rest.
 *
 * Salvaging rather than validating, for the reason every document in this app
 * salvages: one bad field must not cost the operator the other three.
 */
export function parseRoutingPolicy(raw: unknown): RoutingPolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ROUTING_POLICY };
  const stored = raw as Partial<RoutingPolicy>;
  const classOverrides: Partial<Record<ModelPreferenceClassId, string[]>> = {};
  const overrides = stored.classOverrides;
  if (overrides && typeof overrides === "object") {
    for (const [classId, labels] of Object.entries(overrides)) {
      if (!Array.isArray(labels)) continue;
      const kept = labels.filter(
        (label): label is string => typeof label === "string" && !!label.trim(),
      );
      if (kept.length > 0) {
        classOverrides[classId as ModelPreferenceClassId] = kept;
      }
    }
  }
  return {
    waveNearLimitPercent: clampPercent(
      stored.waveNearLimitPercent,
      DEFAULT_ROUTING_POLICY.waveNearLimitPercent,
    ),
    chatNearLimitPercent: clampPercent(
      stored.chatNearLimitPercent,
      DEFAULT_ROUTING_POLICY.chatNearLimitPercent,
    ),
    classOverrides,
  };
}

/** True when the policy is still the shipped one. */
export function isDefaultRoutingPolicy(policy: RoutingPolicy): boolean {
  return (
    policy.waveNearLimitPercent ===
      DEFAULT_ROUTING_POLICY.waveNearLimitPercent &&
    policy.chatNearLimitPercent ===
      DEFAULT_ROUTING_POLICY.chatNearLimitPercent &&
    Object.keys(policy.classOverrides).length === 0
  );
}
