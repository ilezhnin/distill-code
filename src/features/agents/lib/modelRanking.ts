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
import { isModelAlias } from "@/features/chat/lib/modelAliases";
import { groupModelsByGeneration } from "@/features/chat/lib/modelGenerations";
import type { EffortValue } from "@/features/chat/lib/sessionRunSettings";
import type { ModelOption, ModelPickerGroup } from "@/features/chat/types";

export type ModelPreferenceClassId =
  | "code-implement"
  | "algorithms"
  | "debug"
  | "code-review"
  | "security"
  | "testing"
  | "architecture"
  | "planning"
  | "frontend-ui"
  | "creative"
  | "writing"
  | "research-data"
  | "ops"
  | "general";

/**
 * The classes retired on October 5, 2026, by weight rather than kind, and
 * where each one's work went. A stored override under an old id moves with
 * it; the service moves the benchmark cases (`routing::legacy_work_class`).
 */
export const LEGACY_CLASS_IDS: Record<string, ModelPreferenceClassId> = {
  "coding-simple": "algorithms",
  "coding-complex": "algorithms",
  "one-shot": "general",
  "testing-heavy": "testing",
  "testing-light": "testing",
  "general-medium": "research-data",
  "general-light": "general",
};

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
   * Reasoning effort this candidate is worth running at ("Opus 5 at xhigh"),
   * in the harness's own vocabulary. It is a separate selection from the
   * model: the ranking states the intent and the caller puts it on the
   * session's run settings, the same way on every harness.
   */
  effort?: EffortValue;
  /** Whether this candidate is worth running in fast mode, when stated. */
  fast?: boolean;
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
  effort: EffortValue,
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
  label: "Grok 4.7",
  platform: "grok-acp",
  needles: [["grok"]],
  effort: "xhigh",
};
// Luna and Tera carry an effort like every other candidate: it rides on the
// session's run settings next to the model, so the ranking's "Luna at xhigh"
// is what the session is asked for rather than whatever the harness defaults
// to.
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
 * - heavy engineering: Astra → Fable 5.1 → Opus 5 → Grok 4.7, all at xhigh;
 * - medium engineering: the same order at medium, except Grok, which is worth
 *   running at xhigh or not at all;
 * - design and planning: Fable 5.1 → Astra → Opus 5, all at xhigh;
 * - simpler work: Opus 5 at medium → Grok 4.7 at high → Luna at xhigh.
 *
 * The Grok candidate's label tracks xAI's current generation (4.6 → 4.7,
 * 2026-09-21); the slot and its efforts are the ranking's own, and the
 * generic needle already resolves to the newest Grok the bridge lists.
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
  "code-implement": { id: "code-implement", ranking: [...ENGINEERING_HEAVY] },
  algorithms: { id: "algorithms", ranking: [...ENGINEERING_HEAVY] },
  debug: { id: "debug", ranking: [...ENGINEERING_HEAVY] },
  "code-review": { id: "code-review", ranking: [...ENGINEERING_HEAVY] },
  security: { id: "security", ranking: [...ENGINEERING_HEAVY] },
  testing: { id: "testing", ranking: [...ENGINEERING_MEDIUM] },
  architecture: { id: "architecture", ranking: [...ENGINEERING_HEAVY] },
  planning: { id: "planning", ranking: [...DESIGN_PROFILE] },
  "frontend-ui": { id: "frontend-ui", ranking: [...DESIGN_PROFILE] },
  creative: { id: "creative", ranking: [...DESIGN_PROFILE] },
  writing: { id: "writing", ranking: [...LIGHT_PROFILE] },
  "research-data": { id: "research-data", ranking: [...ENGINEERING_MEDIUM] },
  ops: { id: "ops", ranking: [...ENGINEERING_MEDIUM] },
  // The companions and open-ended conversations: the strongest available
  // model, not a coding specialist.
  general: { id: "general", ranking: [...ENGINEERING_HEAVY] },
};

/** Every class id, in the order the settings pane and the prompt list them. */
export function modelPreferenceClassIds(): ModelPreferenceClassId[] {
  return Object.keys(MODEL_PREFERENCE_CLASSES) as ModelPreferenceClassId[];
}

export function isModelPreferenceClassId(
  value: unknown,
): value is ModelPreferenceClassId {
  // Own keys only: `in` also answers yes for `constructor`, `toString` and
  // the rest of Object.prototype, and a class id that indexes to a function
  // throws in every consumer that reads `.ranking` off it.
  return (
    typeof value === "string" && Object.hasOwn(MODEL_PREFERENCE_CLASSES, value)
  );
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
    // Implementation in a repository: code, tests and documents with proof.
    brigade: "code-implement",
    "unity-worker": "code-implement",
    integrator: "code-implement",
    tinker: "code-implement",
    "agt.-builder": "code-implement",
    "agt-builder": "code-implement",
    // Defects: measure, reproduce, fix.
    perf: "debug",
    adversary: "debug",
    // Read-only review and acceptance.
    acceptor: "code-review",
    "unity-reviewer": "code-review",
    pushback: "code-review",
    oracle: "code-review",
    security: "security",
    // Tests designed, run and played.
    qa: "testing",
    playtester: "testing",
    "unity-test-runner": "testing",
    "test-runner": "testing",
    architect: "architecture",
    // Planning and coordination: these roles decide and sequence work, they
    // do not write it (2026-09-12).
    planner: "planning",
    producer: "planning",
    choosey: "planning",
    ux: "frontend-ui",
    // Visual and game-design concept work.
    artist: "creative",
    designer: "creative",
    audio: "creative",
    // Shipped prose, store copy, translations.
    writer: "writing",
    marketer: "writing",
    copycat: "writing",
    localizer: "writing",
    // Sources, maps and structured facts.
    researcher: "research-data",
    scout: "research-data",
    "unity-explorer": "research-data",
    "context-builder": "research-data",
    "asset-scout": "research-data",
    // Deterministic operations: CI, packaging, git actions, asset import.
    devops: "ops",
    "pr-submitter": "ops",
    submitter: "ops",
    "unity-asset-integrator": "ops",
    "asset-integrator": "ops",
    // Companions and open conversation.
    distill: "general",
    wildcard: "general",
  };

export interface RankableModel {
  id: string;
  name?: string;
  displayName?: string;
  providerId?: string;
  /** The picker page the harness filed this row under, when it says. */
  group?: ModelPickerGroup;
  /**
   * The effort values the model offers. Absent is "nobody has asked", never
   * "none": only a list, even an empty one, is an answer.
   */
  efforts?: ReadonlyArray<{ id: string; name?: string }>;
  /** The effort the harness itself calls this model's default, if it says. */
  defaultEffort?: string | null;
  /** `null` (or absent) is "unknown", never "no". */
  supportsFast?: boolean | null;
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
  /**
   * Effort the ranking asks for, when it names one — spelled the way the
   * model advertises it when the model lists it.
   */
  effort?: EffortValue;
  /**
   * `false` when the model's advertised efforts are known and do not include
   * `effort`. Fail-open on purpose: the model is still the choice, the effort
   * stays the intent, and the caller says what runs instead. Skipping the
   * candidate would disable rankings whenever capabilities are unknown.
   * Absent when no effort was asked for or the model's efforts are unknown.
   */
  effortApplied?: boolean;
  /** Fast mode the ranking asks for, when it states one. */
  fast?: boolean;
  /** `false` when fast mode was asked for and the model says it has none. */
  fastApplied?: boolean;
  /** True when only a near-limit candidate was left (see resolveRankedModel). */
  nearLimit?: boolean;
}

/**
 * How `model` spells `effort`, `null` when its advertised efforts are known
 * and do not include it, `undefined` when nobody has asked the model.
 *
 * Matched by id, then by name, case-insensitively — the same tolerance the
 * session path uses — and never to a neighbouring value: an effort the list
 * does not offer is not offered, however close a stop looks.
 */
export function advertisedEffortId(
  model: Pick<RankableModel, "efforts">,
  effort: EffortValue,
): string | null | undefined {
  if (!model.efforts) return undefined;
  const wanted = effort.trim().toLowerCase();
  const byId = model.efforts.find(
    (option) => option.id.toLowerCase() === wanted,
  );
  if (byId) return byId.id;
  const byName = model.efforts.find(
    (option) => (option.name ?? "").toLowerCase() === wanted,
  );
  return byName ? byName.id : null;
}

function rankedChoice(
  candidate: RankedModelCandidate,
  harnessId: string,
  model: RankableModel,
  rankIndex: number,
): RankedModelChoice {
  const effortId = candidate.effort
    ? advertisedEffortId(model, candidate.effort)
    : undefined;
  return {
    harnessId,
    model,
    rankIndex,
    label: candidate.label,
    ...(candidate.effort ? { effort: effortId ?? candidate.effort } : {}),
    ...(candidate.effort && model.efforts
      ? { effortApplied: effortId != null }
      : {}),
    ...(candidate.fast !== undefined ? { fast: candidate.fast } : {}),
    ...(candidate.fast === true && model.supportsFast === false
      ? { fastApplied: false }
      : {}),
  };
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
 * The candidate's match among `items`: a model, by its base id and names.
 *
 * The effort is not part of the match. Inventories list one row per model and
 * the effort is a separate selection carried beside it, so there is no tier
 * variant to prefer; several matches are narrowed to the family's current
 * model ({@link preferCurrentMatches}) and the first of those wins.
 */
export function pickCandidateMatch<T>(
  candidate: RankedModelCandidate,
  items: readonly T[],
  modelOf: (item: T) => RankableModel,
): T | undefined {
  const matches = items.filter((item) =>
    matchesCandidate(candidate, modelOf(item)),
  );
  return preferCurrentMatches(matches, modelOf)[0];
}

/**
 * The models a request that names a family should choose among: concrete ids
 * over an alias row ("default" is labeled with the model it resolves to
 * today, so it matches that model's words too), and the family's current
 * model over the older ones a harness still serves ("opus" means Opus 5, not
 * Opus 4.8). A request names a model, not whatever the CLI defaults to later.
 * Input order is kept.
 *
 * "Current" comes from the harness's own filing when the inventory carries
 * it: a row on the main page beats a row under More models, which is also what
 * tells Fable 5.1 (main) from Fable 5 (More). Only an inventory with no filing
 * at all falls back to guessing generations from the names.
 */
export function preferCurrentMatches<T>(
  matches: readonly T[],
  modelOf: (item: T) => RankableModel,
): readonly T[] {
  const concrete = matches.filter((item) => !isModelAlias(modelOf(item).id));
  const pool = concrete.length > 0 ? concrete : matches;
  if (pool.some((item) => modelOf(item).group !== undefined)) {
    // A row the harness did not file is shown on the main page, so it counts
    // as main here too.
    const main = pool.filter((item) => modelOf(item).group !== "more");
    return main.length > 0 ? main : pool;
  }
  const options: ModelOption[] = pool.map((item) => {
    const model = modelOf(item);
    return {
      id: model.id,
      name: model.name ?? model.displayName ?? model.id,
      displayName: model.displayName,
    };
  });
  const { current } = groupModelsByGeneration(options);
  return pool.filter((_, index) => current.includes(options[index]));
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
          choice: rankedChoice(candidate, candidate.platform, model, rankIndex),
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
        choice: rankedChoice(
          candidate,
          entry.harnessId,
          entry.model,
          rankIndex,
        ),
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
  // An agent named "Constructor" slugs to a key Object.prototype answers for;
  // only the table's own entries are role defaults.
  return slug && Object.hasOwn(MODEL_CLASS_BY_AGENT_SLUG, slug)
    ? MODEL_CLASS_BY_AGENT_SLUG[slug]
    : undefined;
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
const LEGACY_CANDIDATE_LABELS: ReadonlyMap<string, string> = new Map([
  ["Fable 5", "Fable 5.1"],
  ["Grok 4.6", "Grok 4.7"],
]);

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
    const label = LEGACY_CANDIDATE_LABELS.get(stored) ?? stored;
    const candidate =
      ranking.find((known) => known.label === label) ??
      KNOWN_MODEL_CANDIDATES.find((known) => known.label === label);
    if (candidate && !chosen.includes(candidate)) chosen.push(candidate);
  }
  return chosen.length > 0 ? chosen : ranking;
}
