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
import {
  splitEmbeddedReasoning,
  type EmbeddedReasoningEffort,
} from "@/features/chat/lib/modelReasoningVariants";

export type ModelPreferenceClassId =
  | "frontend-ui"
  | "coding-simple"
  | "coding-complex"
  | "one-shot"
  | "planning"
  | "testing-heavy"
  | "testing-light"
  | "general-medium"
  | "general-light";

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

/**
 * The same model at a different reasoning effort.
 *
 * A profile is the pair (order, effort): the operator ranks the same four
 * models for heavy and for medium engineering and asks for xhigh on one and
 * medium on the other. The label stays the model's, so the settings pane and
 * the pool still speak about one "Astra".
 */
function atEffort(
  candidate: RankedModelCandidate,
  effort: EmbeddedReasoningEffort,
): RankedModelCandidate {
  return { ...candidate, effort };
}

const ASTRA: RankedModelCandidate = {
  label: "Astra",
  platform: "codex-acp",
  needles: [["astra"]],
  effort: "xhigh",
};
const FABLE: RankedModelCandidate = {
  label: "Fable 5.1",
  platform: "claude-acp",
  needles: [["fable"]],
  effort: "xhigh",
  // Fable spends its own weekly allowance on top of the account's windows.
  scopedWindow: "fableWeekly",
};
const OPUS: RankedModelCandidate = {
  label: "Opus 5",
  platform: "claude-acp",
  needles: [["opus"]],
  effort: "xhigh",
};
const GROK: RankedModelCandidate = {
  label: "Grok 4.6",
  platform: "grok-acp",
  needles: [["grok"]],
  effort: "xhigh",
};
// Luna and Tera carry an effort so a harness that serves each tier as its
// own id seeds the tier named here, not the `[low]` the inventory lists
// first (the same trap pickCandidateMatch closes for Sol). On a harness with
// one id per model the effort is ignored and the first match wins as before.
const LUNA: RankedModelCandidate = {
  label: "Luna",
  needles: [["luna"]],
  effort: "xhigh",
};
const TERA: RankedModelCandidate = {
  label: "Tera",
  needles: [["tera"]],
  effort: "high",
};
const CODEX_SOL: RankedModelCandidate = {
  label: "Codex Sol",
  platform: "codex-acp",
  needles: [["sol"]],
  effort: "xhigh",
};

/**
 * The operator's rankings, verbatim (2026-09-12), as four profiles.
 *
 * Anthropic's models take design and planning, OpenAI's take heavy and medium
 * coding, and Grok plus the small models of either provider take the simple
 * plugs where there is nothing much to think about:
 *
 * - heavy engineering: Astra → Fable 5.1 → Opus 5 → Grok 4.6, all at xhigh;
 * - medium engineering: the same order at medium, except Grok, which is worth
 *   running at xhigh or not at all;
 * - design and planning: Fable 5.1 → Astra → Opus 5, all at xhigh;
 * - simpler work: Opus 5 at medium → Grok 4.6 at high → Luna at xhigh.
 *
 * The class ids keep working — persona frontmatter references them — and each
 * carries the profile its kind of work falls under; `planning` splits the
 * coordinating roles (planner, producer, oracle) out of `one-shot` so they get
 * the Anthropic-first order rather than the coding one. Tera and Codex Sol are
 * in no profile but stay in KNOWN_MODEL_CANDIDATES, so they remain pinnable per
 * agent and per class. (Superseded rankings of 2026-08-30 kept in git history.)
 */
const ENGINEERING_HEAVY = [ASTRA, FABLE, OPUS, GROK];
const ENGINEERING_MEDIUM = [
  atEffort(ASTRA, "medium"),
  atEffort(FABLE, "medium"),
  atEffort(OPUS, "medium"),
  GROK,
];
const DESIGN_PROFILE = [FABLE, ASTRA, OPUS];
const LIGHT_PROFILE = [atEffort(OPUS, "medium"), atEffort(GROK, "high"), LUNA];

export const MODEL_PREFERENCE_CLASSES: Record<
  ModelPreferenceClassId,
  ModelPreferenceClass
> = {
  "frontend-ui": { id: "frontend-ui", ranking: [...DESIGN_PROFILE] },
  "coding-simple": { id: "coding-simple", ranking: [...ENGINEERING_MEDIUM] },
  "coding-complex": { id: "coding-complex", ranking: [...ENGINEERING_HEAVY] },
  "one-shot": { id: "one-shot", ranking: [...ENGINEERING_HEAVY] },
  planning: { id: "planning", ranking: [...DESIGN_PROFILE] },
  "testing-heavy": { id: "testing-heavy", ranking: [...ENGINEERING_HEAVY] },
  "testing-light": { id: "testing-light", ranking: [...LIGHT_PROFILE] },
  "general-medium": { id: "general-medium", ranking: [...ENGINEERING_MEDIUM] },
  "general-light": { id: "general-light", ranking: [...LIGHT_PROFILE] },
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
 *
 * Lookup slugs come from the persona's *display name*
 * (`modelPreferenceClassForPersona`), which for a few bundled agents differs
 * from the file stem — those carry both spellings so neither route misses.
 */
export const MODEL_CLASS_BY_AGENT_SLUG: Record<string, ModelPreferenceClassId> =
  {
    // frontend / UI-UX — design work, Anthropic first
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
    submitter: "coding-simple",
    "unity-asset-integrator": "coding-simple",
    "asset-integrator": "coding-simple",
    tinker: "coding-simple",
    // planning and coordination — the same Anthropic-first order as design
    // (2026-09-12): these roles decide and sequence work, they do not write it.
    planner: "planning",
    producer: "planning",
    oracle: "planning",
    // one-shot capability (research, synthesis) — including the companion
    // agents, which are conversations with a strong generalist rather than
    // pipeline steps: the class is the strongest available model, not a coding
    // specialist.
    "agt.-builder": "one-shot",
    "agt-builder": "one-shot",
    distill: "one-shot",
    choosey: "one-shot",
    copycat: "one-shot",
    pushback: "one-shot",
    wildcard: "one-shot",
    researcher: "one-shot",
    // medium weight: careful reading, structured output, no deep design
    // decisions — mapping a project, packaging a handoff, sourcing assets,
    // spec'ing audio (gamedev recalibration 2026-08-30)
    "unity-explorer": "general-medium",
    "context-builder": "general-medium",
    "asset-scout": "general-medium",
    audio: "general-medium",
    // light weight: no serious coding or design — fact checks, prose,
    // translations, store copy
    scout: "general-light",
    writer: "general-light",
    localizer: "general-light",
    marketer: "general-light",
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
    "test-runner": "testing-light",
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
 * The candidate's match among `items`, honouring its stated effort.
 *
 * Some harnesses serve every effort tier as its own model id
 * (`gpt-5.6-sol[low]` … `[ultra]`), and all of them contain the candidate's
 * needles. "First match wins" then silently resolves an xhigh candidate to the
 * `[low]` variant — the inventory lists tiers ascending — which is how a whole
 * wave of executors once ran at low reasoning (L1, 2026-08-28). When the
 * candidate names an effort and several models match, the variant embedding
 * exactly that effort wins; the first match stays the answer everywhere else.
 */
export function pickCandidateMatch<T>(
  candidate: RankedModelCandidate,
  items: readonly T[],
  modelOf: (item: T) => RankableModel,
): T | undefined {
  const matches = items.filter((item) =>
    matchesCandidate(candidate, modelOf(item)),
  );
  if (matches.length <= 1 || !candidate.effort) return matches[0];
  return (
    matches.find(
      (item) =>
        splitEmbeddedReasoning(modelOf(item).id)?.effort === candidate.effort,
    ) ?? matches[0]
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
      const model = pickCandidateMatch(
        candidate,
        input.modelsForPlatform(candidate.platform),
        (entry) => entry,
      );
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

    const entry = pickCandidateMatch(
      candidate,
      input.allModels(),
      ({ model }) => model,
    );
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
 * The pool an operator's own class ranking is written from.
 *
 * Deliberately not "every installed model": a candidate carries the platform
 * whose meter guards it, the reasoning effort it is worth running at, and the
 * needles that find it across provider renames — none of which a bare model id
 * has. Equally deliberately not "every model some profile names": Tera and
 * Codex Sol are in no profile as of 2026-09-12 and are still here, because
 * dropping a model from the default order is not the same as saying the
 * operator may no longer choose it. An operator who wants a model that appears
 * nowhere here can still pin it per agent, which is what the per-agent ranking
 * editor is for.
 */
export const KNOWN_MODEL_CANDIDATES: readonly RankedModelCandidate[] = [
  ASTRA,
  FABLE,
  OPUS,
  GROK,
  LUNA,
  CODEX_SOL,
  TERA,
];

/**
 * Labels a stored override may still spell the old way.
 *
 * A renamed candidate would otherwise drop out of the operator's saved order
 * silently and the class would snap back to the shipped one — a reset nobody
 * asked for, dressed as a default.
 */
const LEGACY_CANDIDATE_LABELS: Record<string, string> = {
  "Fable 5": "Fable 5.1",
};

/**
 * A class's ranking with the operator's own order applied, when they set one.
 *
 * The class's own candidates are consulted before the shared pool, so a
 * reordered class keeps the effort that class asks for — the medium profile
 * ranks the same models as the heavy one and must not silently come back at
 * xhigh. Labels that name no known candidate are dropped rather than guessed
 * at, and an override that survives to nothing falls back to the built-in
 * list: a class that resolves to no candidates would silently stop retargeting
 * anything, which looks exactly like the feature being broken.
 */
export function applyClassOverride(
  ranking: readonly RankedModelCandidate[],
  labels: readonly string[] | undefined,
): readonly RankedModelCandidate[] {
  if (!labels || labels.length === 0) return ranking;
  const chosen: RankedModelCandidate[] = [];
  for (const stored of labels) {
    const label = LEGACY_CANDIDATE_LABELS[stored] ?? stored;
    const candidate =
      ranking.find((known) => known.label === label) ??
      KNOWN_MODEL_CANDIDATES.find((known) => known.label === label);
    if (candidate && !chosen.includes(candidate)) chosen.push(candidate);
  }
  return chosen.length > 0 ? chosen : ranking;
}
