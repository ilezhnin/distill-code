import type { ModelOption } from "../types";

/**
 * Family + generation parsed from a model id or display name, used to fold
 * superseded generations into an "Older models" subgroup. Parsing is
 * heuristic on purpose: anything we cannot confidently place stays in the
 * current group, so unknown ids are never hidden behind the disclosure.
 */
export interface ModelGeneration {
  family: string;
  /** [major, minor] — compared lexicographically. */
  generation: [number, number];
}

export interface ModelGenerationGroups {
  current: ModelOption[];
  legacy: ModelOption[];
}

/**
 * Versionless aliases always resolve to the newest generation server-side,
 * so they are never legacy.
 */
const VERSIONLESS_ALIASES = new Set([
  "default",
  "auto",
  "opus",
  "sonnet",
  "haiku",
  "current",
  "current model",
  "current-model",
]);

const CLAUDE_FAMILIES = "opus|sonnet|haiku";

interface GenerationPattern {
  pattern: RegExp;
  family: (match: RegExpMatchArray) => string;
  major: number;
  minor?: number;
}

const GENERATION_PATTERNS: GenerationPattern[] = [
  // claude-opus-4-6, claude-sonnet-4.5, claude-haiku-4-5
  {
    pattern: new RegExp(`^claude-(${CLAUDE_FAMILIES})-(\\d+)(?:[-.](\\d+))?`),
    family: (match) => `claude-${match[1]}`,
    major: 2,
    minor: 3,
  },
  // Legacy ordering: claude-3-5-sonnet, claude-3-haiku
  {
    pattern: new RegExp(`^claude-(\\d+)(?:[-.](\\d+))?-(${CLAUDE_FAMILIES})`),
    family: (match) => `claude-${match[3]}`,
    major: 1,
    minor: 2,
  },
  // Display names: "Claude Opus 4.6", "Claude Sonnet 4"
  {
    pattern: new RegExp(`^claude\\s+(${CLAUDE_FAMILIES})\\s+(\\d+)(?:\\.(\\d+))?`),
    family: (match) => `claude-${match[1]}`,
    major: 2,
    minor: 3,
  },
  // Legacy display names: "Claude 3.5 Sonnet"
  {
    pattern: new RegExp(`^claude\\s+(\\d+)(?:\\.(\\d+))?\\s+(${CLAUDE_FAMILIES})`),
    family: (match) => `claude-${match[3]}`,
    major: 1,
    minor: 2,
  },
  // gpt-5.1, gpt-5-codex, gpt-4.1-mini — codex and o-series share the gpt
  // lineage, so an o3 row reads as older than a gpt-5.x row.
  {
    pattern: /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/,
    family: () => "gpt",
    major: 1,
    minor: 2,
  },
  // o3, o4-mini
  {
    pattern: /^o(\d+)(?:-|$)/,
    family: () => "gpt",
    major: 1,
  },
  // grok-4, grok-3.5
  {
    pattern: /^grok-(\d+)(?:\.(\d+))?(?:-|$)/,
    family: () => "grok",
    major: 1,
    minor: 2,
  },
  // gemini-2.5-pro, gemini-3-flash
  {
    pattern: /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/,
    family: () => "gemini",
    major: 1,
    minor: 2,
  },
];

/** Strips bracket suffixes ("[1m]", "[high]") that don't change generation. */
function normalizeForParsing(value: string): string {
  let normalized = value.trim().toLowerCase();
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized.replace(/\[[^\]]*\]$/, "").trim();
  } while (normalized !== previous);
  return normalized;
}

function parseGenerationFromText(value: string): ModelGeneration | null {
  const normalized = normalizeForParsing(value);
  if (!normalized || VERSIONLESS_ALIASES.has(normalized)) {
    return null;
  }

  for (const candidate of GENERATION_PATTERNS) {
    const match = normalized.match(candidate.pattern);
    if (!match) {
      continue;
    }
    const major = Number.parseInt(match[candidate.major] ?? "", 10);
    if (!Number.isFinite(major)) {
      continue;
    }
    const minorText =
      candidate.minor !== undefined ? match[candidate.minor] : undefined;
    const minor = minorText ? Number.parseInt(minorText, 10) : 0;
    return {
      family: candidate.family(match),
      generation: [major, Number.isFinite(minor) ? minor : 0],
    };
  }

  return null;
}

/**
 * Parses a model's family and generation from its id, falling back to its
 * display name. Returns null for versionless aliases and unrecognized ids —
 * both are treated as current.
 */
export function parseModelGeneration(
  model: Pick<ModelOption, "id" | "name" | "displayName">,
): ModelGeneration | null {
  return (
    parseGenerationFromText(model.id) ??
    parseGenerationFromText(model.displayName ?? model.name)
  );
}

function compareGenerations(
  left: [number, number],
  right: [number, number],
): number {
  return left[0] !== right[0] ? left[0] - right[0] : left[1] - right[1];
}

/**
 * Splits a model list into current-generation models and legacy models —
 * those whose family has a strictly newer generation present in the same
 * list. Input order is preserved within each group.
 */
export function groupModelsByGeneration(
  models: ModelOption[],
): ModelGenerationGroups {
  const parsed = models.map((model) => parseModelGeneration(model));
  const newestByFamily = new Map<string, [number, number]>();
  for (const generation of parsed) {
    if (!generation) {
      continue;
    }
    const newest = newestByFamily.get(generation.family);
    if (!newest || compareGenerations(generation.generation, newest) > 0) {
      newestByFamily.set(generation.family, generation.generation);
    }
  }

  const current: ModelOption[] = [];
  const legacy: ModelOption[] = [];
  models.forEach((model, index) => {
    const generation = parsed[index];
    const newest = generation
      ? newestByFamily.get(generation.family)
      : undefined;
    if (
      generation &&
      newest &&
      compareGenerations(generation.generation, newest) < 0
    ) {
      legacy.push(model);
    } else {
      current.push(model);
    }
  });

  return { current, legacy };
}
