/**
 * Ranked model preferences for agents.
 *
 * A persona used to carry exactly one `model`. A ranking names an ordered list
 * of candidates instead, and the app picks the best one that is actually
 * usable right now — installed, and on a platform whose rate-limit window is
 * not exhausted. The pick is returned with its rank and the skipped
 * candidates, so callers can SHOW what happened: a silent substitution is the
 * one thing this module must never enable (decision D5).
 *
 * Candidates are matched fuzzily against the live model list (ids and display
 * names change with provider updates), and each carries the agent platform
 * whose rate-limit meter guards it. A candidate with no platform is searched
 * on every harness and never limit-skipped — used for models the operator
 * named that we cannot attribute to a tracked platform yet.
 */

import type { AgentPlatformId } from "@/features/status/lib/rateLimitTypes";

export type ModelPreferenceClassId =
  | "frontend-ui"
  | "coding-simple"
  | "coding-complex"
  | "one-shot"
  | "testing-heavy"
  | "testing-light";

export interface RankedModelCandidate {
  /** Operator-facing name of the candidate ("Opus 5"). */
  label: string;
  /** Agent platform whose rate-limit meter guards this candidate. */
  platform?: AgentPlatformId;
  /**
   * Alternatives; an alternative matches when ALL its lowercase substrings
   * appear in the model's id or display name.
   */
  needles: string[][];
}

export interface ModelPreferenceClass {
  id: ModelPreferenceClassId;
  ranking: RankedModelCandidate[];
}

const OPUS: RankedModelCandidate = {
  label: "Opus 5",
  platform: "claude-acp",
  needles: [["opus"]],
};
const FABLE: RankedModelCandidate = {
  label: "Fable 5",
  platform: "claude-acp",
  needles: [["fable"]],
};
const CODEX_SOL: RankedModelCandidate = {
  label: "Codex Sol",
  platform: "codex-acp",
  needles: [["sol"]],
};
const GROK_HEAVY: RankedModelCandidate = {
  label: "Grok 4.6 Heavy",
  platform: "grok-acp",
  needles: [["grok", "heavy"], ["grok-4-6-heavy"]],
};
const GROK: RankedModelCandidate = {
  label: "Grok 4.6",
  platform: "grok-acp",
  needles: [["grok"]],
};
const TERA: RankedModelCandidate = { label: "Tera", needles: [["tera"]] };
const LUNA: RankedModelCandidate = { label: "Luna", needles: [["luna"]] };

/**
 * The operator's rankings, verbatim (2026-08-23):
 * frontend/UI-UX Opus → Fable → Sol; simple coding Grok Heavy → Opus;
 * complex coding Fable → Sol; one-shot Fable → Sol → Opus → Grok;
 * heavy testing/audit Fable → Sol → Opus; light testing Grok → Tera → Luna.
 */
export const MODEL_PREFERENCE_CLASSES: Record<
  ModelPreferenceClassId,
  ModelPreferenceClass
> = {
  "frontend-ui": { id: "frontend-ui", ranking: [OPUS, FABLE, CODEX_SOL] },
  "coding-simple": { id: "coding-simple", ranking: [GROK_HEAVY, OPUS] },
  "coding-complex": { id: "coding-complex", ranking: [FABLE, CODEX_SOL] },
  "one-shot": { id: "one-shot", ranking: [FABLE, CODEX_SOL, OPUS, GROK] },
  "testing-heavy": {
    id: "testing-heavy",
    ranking: [FABLE, CODEX_SOL, OPUS],
  },
  "testing-light": { id: "testing-light", ranking: [GROK, TERA, LUNA] },
};

export function isModelPreferenceClassId(
  value: unknown,
): value is ModelPreferenceClassId {
  return typeof value === "string" && value in MODEL_PREFERENCE_CLASSES;
}

/**
 * Default class per bundled agent slug. A persona's own `modelRanking`
 * property overrides this; user agents without either get no ranking.
 */
export const MODEL_CLASS_BY_AGENT_SLUG: Record<string, ModelPreferenceClassId> =
  {
    // frontend / UI-UX
    ux: "frontend-ui",
    designer: "frontend-ui",
    artist: "frontend-ui",
    // coding, complex by default for implementers
    brigade: "coding-complex",
    "unity-worker": "coding-complex",
    architect: "coding-complex",
    integrator: "coding-complex",
    // coding, simple mechanical work
    devops: "coding-simple",
    "pr-submitter": "coding-simple",
    "unity-asset-integrator": "coding-simple",
    tinker: "coding-simple",
    // one-shot capability (research, synthesis, coordination)
    producer: "one-shot",
    planner: "one-shot",
    scout: "one-shot",
    researcher: "one-shot",
    oracle: "one-shot",
    "context-builder": "one-shot",
    "asset-scout": "one-shot",
    "unity-explorer": "one-shot",
    writer: "one-shot",
    localizer: "one-shot",
    marketer: "one-shot",
    audio: "one-shot",
    // heavy testing / audit
    acceptor: "testing-heavy",
    adversary: "testing-heavy",
    "unity-reviewer": "testing-heavy",
    security: "testing-heavy",
    perf: "testing-heavy",
    // light testing
    qa: "testing-light",
    playtester: "testing-light",
    "unity-test-runner": "testing-light",
  };

export interface RankableModel {
  id: string;
  name?: string;
  displayName?: string;
  providerId?: string;
}

export interface RankedModelResolutionInput {
  /** Live models per harness; a platform candidate looks only at its own. */
  modelsForPlatform: (platform: AgentPlatformId) => readonly RankableModel[];
  /** Every model, for platformless candidates. Pairs each with its harness. */
  allModels: () => ReadonlyArray<{
    harnessId: string;
    model: RankableModel;
  }>;
  /** True when the platform's tightest rate-limit window is exhausted. */
  isPlatformAtLimit: (platform: AgentPlatformId) => boolean;
}

export interface RankedModelChoice {
  harnessId: string;
  model: RankableModel;
  /** Zero-based rank of the picked candidate; >0 means a fallback happened. */
  rankIndex: number;
  label: string;
}

export interface RankedModelSkip {
  label: string;
  reason: "at-limit" | "not-installed";
}

export interface RankedModelResolution {
  choice?: RankedModelChoice;
  /** Every higher-ranked candidate that was passed over, in rank order. */
  skipped: RankedModelSkip[];
}

function matchesCandidate(
  candidate: RankedModelCandidate,
  model: RankableModel,
): boolean {
  const haystack =
    `${model.id} ${model.displayName ?? ""} ${model.name ?? ""}`.toLowerCase();
  return candidate.needles.some((needleSet) =>
    needleSet.every((needle) => haystack.includes(needle)),
  );
}

/**
 * Picks the highest-ranked candidate that is installed and not rate-limited.
 *
 * Deterministic and pure: all liveness comes in through the input callbacks.
 * When nothing in the ranking resolves, `choice` is undefined and the caller
 * falls back to the persona's single `model` (or plain inheritance) — the
 * ranking never blocks a session from starting.
 */
export function resolveRankedModel(
  classId: ModelPreferenceClassId,
  input: RankedModelResolutionInput,
): RankedModelResolution {
  const skipped: RankedModelSkip[] = [];
  const ranking = MODEL_PREFERENCE_CLASSES[classId].ranking;

  for (const [rankIndex, candidate] of ranking.entries()) {
    if (candidate.platform) {
      if (input.isPlatformAtLimit(candidate.platform)) {
        skipped.push({ label: candidate.label, reason: "at-limit" });
        continue;
      }
      const model = input
        .modelsForPlatform(candidate.platform)
        .find((entry) => matchesCandidate(candidate, entry));
      if (model) {
        return {
          choice: {
            harnessId: candidate.platform,
            model,
            rankIndex,
            label: candidate.label,
          },
          skipped,
        };
      }
      skipped.push({ label: candidate.label, reason: "not-installed" });
      continue;
    }

    const entry = input
      .allModels()
      .find(({ model }) => matchesCandidate(candidate, model));
    if (entry) {
      return {
        choice: {
          harnessId: entry.harnessId,
          model: entry.model,
          rankIndex,
          label: candidate.label,
        },
        skipped,
      };
    }
    skipped.push({ label: candidate.label, reason: "not-installed" });
  }

  return { skipped };
}

/**
 * The ranking class a persona resolves to: its own explicit `modelRanking`
 * property when valid, else the bundled-slug default, else none.
 */
export function modelPreferenceClassForPersona(persona: {
  modelRanking?: string;
  displayName?: string;
}): ModelPreferenceClassId | undefined {
  if (isModelPreferenceClassId(persona.modelRanking)) {
    return persona.modelRanking;
  }
  const slug = persona.displayName?.trim().toLowerCase().replace(/\s+/g, "-");
  return slug ? MODEL_CLASS_BY_AGENT_SLUG[slug] : undefined;
}
