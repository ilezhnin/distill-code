/**
 * One agent's own ranked model list — the operator-authored form of a model
 * preference.
 *
 * The built-in classes in `modelRanking.ts` say what a *kind* of work deserves
 * ("frontend work wants Opus, then Fable, then Sol"). This module is the layer
 * above: an agent may carry its own ordered list instead, written against the
 * models actually installed, with the reasoning effort each entry is worth
 * running at. The operator asked for exactly this — "for interface design,
 * first Opus 5 at extra-high, then Fable extra-high, then Sol extra-high, then
 * Grok 4.6" — and for the conductor to walk it against the live rate limits.
 *
 * It rides on the persona's existing `modelRanking` property, which the agent
 * API already carries as a string, so nothing in the backend has to learn a new
 * shape. A value that is one of the built-in class ids still means that class:
 * every agent written before this module keeps working, and the classes remain
 * the sensible starting point the editor offers.
 *
 * Matching is deliberately two-tiered. An entry stores the model id the
 * operator picked, because that is exact; it also stores the label they saw,
 * because provider inventories rename and re-id models between releases, and a
 * ranking that silently stops matching is worse than one that matches loosely.
 */

import type { EmbeddedReasoningEffort } from "@/features/chat/lib/modelReasoningVariants";
import type {
  AgentPlatformId,
  UsageSection,
} from "@/features/status/lib/rateLimitTypes";

import {
  applyClassOverride,
  isModelPreferenceClassId,
  MODEL_PREFERENCE_CLASSES,
  type ModelPreferenceClassId,
  type RankedModelCandidate,
} from "./modelRanking";

/** Current stored shape. Bump only for a change old readers cannot survive. */
export const AGENT_MODEL_RANKING_VERSION = 1;

/** How many entries one agent's list may hold. */
export const MAX_AGENT_RANKING_ENTRIES = 12;

export interface AgentRankingEntry {
  /** Harness the model runs on; also the rate-limit meter that guards it. */
  platform: AgentPlatformId;
  /** Model id exactly as the provider inventory reported it when picked. */
  modelId: string;
  /** What the operator saw when they picked it. Used when the id drifts. */
  label: string;
  /** Effort this entry is worth running at, when the operator set one. */
  effort?: EmbeddedReasoningEffort;
}

export interface AgentModelRanking {
  version: typeof AGENT_MODEL_RANKING_VERSION;
  entries: AgentRankingEntry[];
}

/**
 * What a persona's `modelRanking` property means: an explicit list, one of the
 * built-in classes, or nothing at all.
 */
export type AgentRankingSource =
  | { kind: "list"; ranking: AgentModelRanking }
  | { kind: "class"; classId: ModelPreferenceClassId };

const PLATFORM_IDS: readonly string[] = ["claude-acp", "grok-acp", "codex-acp"];

function isPlatformId(value: unknown): value is AgentPlatformId {
  return typeof value === "string" && PLATFORM_IDS.includes(value);
}

/**
 * Usage window that meters this entry alone rather than the whole account.
 *
 * Derived rather than stored: the operator picks a model, not a billing
 * window, and Anthropic's Fable allowance is the only one of these today. See
 * MODEL_SCOPED_WINDOW_KEYS for why it matters — without it, a spent Fable
 * window would lock Opus out of the same account.
 */
export function scopedWindowForModel(
  platform: AgentPlatformId,
  modelId: string,
  label: string,
): UsageSection["key"] | undefined {
  if (platform !== "claude-acp") return undefined;
  const haystack = `${modelId} ${label}`.toLowerCase();
  return haystack.includes("fable") ? "fableWeekly" : undefined;
}

function parseEntry(value: unknown): AgentRankingEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AgentRankingEntry>;
  if (!isPlatformId(raw.platform)) return null;
  const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  if (!modelId) return null;
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : modelId;
  return {
    platform: raw.platform,
    modelId,
    label,
    ...(typeof raw.effort === "string" && raw.effort
      ? { effort: raw.effort as EmbeddedReasoningEffort }
      : {}),
  };
}

/**
 * Reads a persona's stored preference.
 *
 * Salvaging rather than validating: a list whose entries are half readable
 * loads with the readable ones. The alternative — dropping the whole list on
 * one bad entry — silently retargets every session that agent starts, which is
 * the failure this feature exists to prevent.
 */
export function parseAgentRankingSource(
  raw: string | null | undefined,
): AgentRankingSource | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (isModelPreferenceClassId(value)) {
    return { kind: "class", classId: value };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const entriesValue = Array.isArray(parsed)
    ? parsed
    : ((parsed as { entries?: unknown })?.entries ?? null);
  if (!Array.isArray(entriesValue)) return undefined;
  const entries = entriesValue
    .map(parseEntry)
    .filter((entry): entry is AgentRankingEntry => entry !== null)
    .slice(0, MAX_AGENT_RANKING_ENTRIES);
  if (entries.length === 0) return undefined;
  return {
    kind: "list",
    ranking: { version: AGENT_MODEL_RANKING_VERSION, entries },
  };
}

/** The stored form of an explicit list. */
export function serializeAgentModelRanking(ranking: AgentModelRanking): string {
  return JSON.stringify({
    version: AGENT_MODEL_RANKING_VERSION,
    entries: ranking.entries.slice(0, MAX_AGENT_RANKING_ENTRIES),
  });
}

/**
 * The legacy single provider/model pair as a one-row ranking entry, or null
 * when the pair cannot be represented: no saved model, or a provider that is
 * not a ranked platform (goose-routed providers have no rate-limit meter for
 * the ranking to walk).
 *
 * Used to show an agent saved before rankings existed inside the ranking UI
 * instead of the old separate Provider/Model selects. This is a presentation
 * seed only — nothing is migrated into `model_ranking` until the operator
 * edits the list and saves (D5: no silent substitution of stored data).
 */
export function legacySingleModelRankingEntry(persona: {
  provider?: string | null;
  model?: string | null;
  label?: string | null;
}): AgentRankingEntry | null {
  const modelId = persona.model?.trim();
  if (!modelId || !isPlatformId(persona.provider)) return null;
  return {
    platform: persona.provider,
    modelId,
    label: persona.label?.trim() || modelId,
  };
}

/**
 * An entry as a resolution candidate.
 *
 * Two needle sets, tried in order by the resolver's `some`: the exact id, then
 * the label's own words. The label set is what survives a provider renaming
 * `claude-opus-5` to `claude-opus-5-20261101`.
 */
export function candidateForEntry(
  entry: AgentRankingEntry,
): RankedModelCandidate {
  const labelNeedles = entry.label
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((word) => word.length > 1);
  const scopedWindow = scopedWindowForModel(
    entry.platform,
    entry.modelId,
    entry.label,
  );
  return {
    label: entry.label,
    platform: entry.platform,
    needles: [
      [entry.modelId.toLowerCase()],
      ...(labelNeedles.length > 0 ? [labelNeedles] : []),
    ],
    ...(entry.effort ? { effort: entry.effort } : {}),
    ...(scopedWindow ? { scopedWindow } : {}),
  };
}

/** The ordered candidates a persona's stored preference resolves to. */
export function candidatesForRankingSource(
  source: AgentRankingSource,
  /**
   * The operator's own order per class (P36), when they have set one. Applies
   * only to a class source: a list written for one agent is already theirs.
   */
  classOverrides?: Partial<Record<ModelPreferenceClassId, string[]>>,
): readonly RankedModelCandidate[] {
  return source.kind === "class"
    ? applyClassOverride(
        MODEL_PREFERENCE_CLASSES[source.classId].ranking,
        classOverrides?.[source.classId],
      )
    : source.ranking.entries.map(candidateForEntry);
}

/**
 * The built-in class rendered as an editable list — what the editor offers
 * when an agent has no list of its own yet.
 *
 * Entries are matched against the live inventory so the operator starts from
 * models that actually exist here, and a candidate that resolves to nothing
 * installed is dropped rather than written into their list as a dead row.
 */
export function rankingFromClass(
  classId: ModelPreferenceClassId,
  installed: ReadonlyArray<{
    platform: AgentPlatformId;
    modelId: string;
    label: string;
  }>,
): AgentModelRanking {
  const entries: AgentRankingEntry[] = [];
  for (const candidate of MODEL_PREFERENCE_CLASSES[classId].ranking) {
    const match = installed.find((model) => {
      if (candidate.platform && model.platform !== candidate.platform) {
        return false;
      }
      const haystack = `${model.modelId} ${model.label}`.toLowerCase();
      return candidate.needles.some((set) =>
        set.every((needle) => haystack.includes(needle)),
      );
    });
    if (!match) continue;
    entries.push({
      platform: match.platform,
      modelId: match.modelId,
      label: candidate.label,
      ...(candidate.effort ? { effort: candidate.effort } : {}),
    });
  }
  return { version: AGENT_MODEL_RANKING_VERSION, entries };
}
