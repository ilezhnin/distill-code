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

import type {
  AgentPlatformId,
  UsageSection,
} from "@/features/status/lib/rateLimitTypes";
import type { PlatformLimitState } from "@/features/status/lib/rateLimitWindows";
import type { EmbeddedReasoningEffort } from "@/features/chat/lib/modelReasoningVariants";

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
  /**
   * Reasoning effort this candidate is worth running at ("Opus 5 at xhigh").
   * The ranking states the intent; composing it onto the session — an embedded
   * `model[effort]` id for some harnesses, the ACP effort channel for others —
   * belongs to the caller.
   */
  effort?: EmbeddedReasoningEffort;
  /**
   * Usage window that meters THIS model rather than the whole account (Fable's
   * own weekly allowance). Windows scoped to other models never gate this one.
   */
  scopedWindow?: UsageSection["key"];
}

export interface ModelPreferenceClass {
  id: ModelPreferenceClassId;
  ranking: RankedModelCandidate[];
}

const OPUS: RankedModelCandidate = {
  label: "Opus 5",
  platform: "claude-acp",
  needles: [["opus"]],
  effort: "xhigh",
};
const FABLE: RankedModelCandidate = {
  label: "Fable 5",
  platform: "claude-acp",
  needles: [["fable"]],
  effort: "xhigh",
  // Fable spends its own weekly allowance on top of the account's windows.
  scopedWindow: "fableWeekly",
};
const CODEX_SOL: RankedModelCandidate = {
  label: "Codex Sol",
  platform: "codex-acp",
  needles: [["sol"]],
  effort: "xhigh",
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

/** Every class id, in the order the settings pane and the prompt list them. */
export function modelPreferenceClassIds(): ModelPreferenceClassId[] {
  return Object.keys(MODEL_PREFERENCE_CLASSES) as ModelPreferenceClassId[];
}

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
  /**
   * How much room the platform has for THIS candidate. The candidate's own
   * scoped window is passed through so a model is never blocked by an
   * allowance it does not spend (Fable's window must not close Opus).
   */
  platformLimitState: (
    platform: AgentPlatformId,
    scopedWindow: UsageSection["key"] | undefined,
  ) => PlatformLimitState;
}

export interface RankedModelChoice {
  harnessId: string;
  model: RankableModel;
  /** Zero-based rank of the picked candidate; >0 means a fallback happened. */
  rankIndex: number;
  label: string;
  /** Effort the ranking asks for, when it names one. */
  effort?: EmbeddedReasoningEffort;
  /** True when only a near-limit candidate was left (see resolveRankedModel). */
  nearLimit?: boolean;
}

export interface RankedModelSkip {
  label: string;
  reason: "at-limit" | "near-limit" | "not-installed";
}

export interface RankedModelResolution {
  choice?: RankedModelChoice;
  /** Every higher-ranked candidate that was passed over, in rank order. */
  skipped: RankedModelSkip[];
}

/**
 * Where a model sits in a ranking, or `-1` when the ranking never names it.
 *
 * The only ordering of models this app is allowed to have. It is the
 * operator's own list for a role, not a judgement about which model is
 * better — reputational priors about models are a refused idea, and this is
 * what makes "ranked lower" sayable without inventing one.
 */
export function rankIndexOfModel(
  ranking: readonly RankedModelCandidate[],
  model: RankableModel,
): number {
  return ranking.findIndex((candidate) => matchesCandidate(candidate, model));
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
  return resolveRankedCandidates(
    MODEL_PREFERENCE_CLASSES[classId].ranking,
    input,
  );
}

/**
 * The same resolution over any ordered list of candidates — a built-in class,
 * or the list an operator wrote for one agent.
 */
export function resolveRankedCandidates(
  ranking: readonly RankedModelCandidate[],
  input: RankedModelResolutionInput,
): RankedModelResolution {
  // Two passes on purpose. The first refuses a platform that is merely close
  // to its limit, because a run started at 97% of a weekly allowance is a run
  // that gets cut off mid-flight. The second accepts one anyway when the whole
  // ranking is that full: a near-limit model the operator ranked is a better
  // answer than the untargeted default the caller would otherwise fall back
  // to, and the choice says it settled so the caller can show that.
  const strict = attemptRanking(ranking, input, false);
  if (strict.choice) return strict;
  const relaxed = attemptRanking(ranking, input, true);
  if (relaxed.choice) {
    return {
      choice: { ...relaxed.choice, nearLimit: true },
      skipped: strict.skipped,
    };
  }
  return strict;
}

function attemptRanking(
  ranking: readonly RankedModelCandidate[],
  input: RankedModelResolutionInput,
  acceptNearLimit: boolean,
): RankedModelResolution {
  const skipped: RankedModelSkip[] = [];

  for (const [rankIndex, candidate] of ranking.entries()) {
    if (candidate.platform) {
      const limit = input.platformLimitState(
        candidate.platform,
        candidate.scopedWindow,
      );
      if (
        limit === "at-limit" ||
        (limit === "near-limit" && !acceptNearLimit)
      ) {
        skipped.push({ label: candidate.label, reason: limit });
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
            ...(candidate.effort ? { effort: candidate.effort } : {}),
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
          ...(candidate.effort ? { effort: candidate.effort } : {}),
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

/**
 * Every candidate the built-in classes know about, unique by label.
 *
 * The pool an operator's own class ranking is written from. Deliberately not
 * "every installed model": a candidate carries the platform whose meter guards
 * it, the reasoning effort it is worth running at, and the needles that find
 * it across provider renames — none of which a bare model id has. An operator
 * who wants a model that appears in no class can still pin it per agent, which
 * is what the per-agent ranking editor is for.
 */
export const KNOWN_MODEL_CANDIDATES: readonly RankedModelCandidate[] =
  Object.values(MODEL_PREFERENCE_CLASSES).reduce<RankedModelCandidate[]>(
    (pool, preferenceClass) => {
      for (const candidate of preferenceClass.ranking) {
        if (!pool.some((known) => known.label === candidate.label)) {
          pool.push(candidate);
        }
      }
      return pool;
    },
    [],
  );

/**
 * A class's ranking with the operator's own order applied, when they set one.
 *
 * Labels that name no known candidate are dropped rather than guessed at, and
 * an override that survives to nothing falls back to the built-in list: a
 * class that resolves to no candidates would silently stop retargeting
 * anything, which looks exactly like the feature being broken.
 */
export function applyClassOverride(
  ranking: readonly RankedModelCandidate[],
  labels: readonly string[] | undefined,
): readonly RankedModelCandidate[] {
  if (!labels || labels.length === 0) return ranking;
  const chosen: RankedModelCandidate[] = [];
  for (const label of labels) {
    const candidate = KNOWN_MODEL_CANDIDATES.find(
      (known) => known.label === label,
    );
    if (candidate && !chosen.includes(candidate)) chosen.push(candidate);
  }
  return chosen.length > 0 ? chosen : ranking;
}
