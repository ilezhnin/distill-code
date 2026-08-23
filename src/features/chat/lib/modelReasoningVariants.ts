import type { ModelOption } from "../types";
import type { ChatSessionReasoningEffortConfig } from "../stores/chatSessionStore";

export const EMBEDDED_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "think",
  "thinking",
  "max",
  "ultra",
  "ultrathink",
  "none",
  "off",
] as const;

export type EmbeddedReasoningEffort =
  (typeof EMBEDDED_REASONING_EFFORTS)[number];

const EFFORT_SET = new Set<string>(EMBEDDED_REASONING_EFFORTS);
const EFFORT_SUFFIX_ALTERNATION = [...EMBEDDED_REASONING_EFFORTS]
  .sort((left, right) => right.length - left.length)
  .join("|");
const EFFORT_SUFFIX = new RegExp(
  `^(.*)\\[(${EFFORT_SUFFIX_ALTERNATION})\\]$`,
  "i",
);

const GROK_REASONING_OPTIONS: ChatSessionReasoningEffortConfig["options"] = [
  { id: "low", name: "low" },
  { id: "medium", name: "medium" },
  { id: "high", name: "high" },
  { id: "xhigh", name: "xhigh" },
];

export function splitEmbeddedReasoning(
  value: string | null | undefined,
): { base: string; effort: EmbeddedReasoningEffort } | null {
  if (!value) {
    return null;
  }
  const match = value.trim().match(EFFORT_SUFFIX);
  if (!match) {
    return null;
  }
  const effort = match[2].toLowerCase();
  if (!EFFORT_SET.has(effort)) {
    return null;
  }
  return {
    base: match[1].trimEnd(),
    effort: effort as EmbeddedReasoningEffort,
  };
}

export function stripEmbeddedReasoningLabel(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  return splitEmbeddedReasoning(value)?.base ?? value;
}

function effortSortRank(effort: string): number {
  const index = EMBEDDED_REASONING_EFFORTS.indexOf(
    effort as EmbeddedReasoningEffort,
  );
  return index === -1 ? EMBEDDED_REASONING_EFFORTS.length : index;
}

export interface CollapsedReasoningModels {
  models: ModelOption[];
  wireIdByBaseAndEffort: Map<string, string>;
  effortsByBaseId: Map<string, string[]>;
  reasoning: ChatSessionReasoningEffortConfig | null;
}

function variantKey(baseId: string, effort: string): string {
  return `${baseId}\0${effort}`;
}

export function collapseEmbeddedReasoningModels(
  models: ModelOption[],
  currentModelId?: string | null,
): CollapsedReasoningModels {
  const wireIdByBaseAndEffort = new Map<string, string>();
  const effortsByBaseId = new Map<string, string[]>();
  const collapsedByBaseId = new Map<string, ModelOption>();
  let variantCount = 0;

  for (const model of models) {
    const parsed = splitEmbeddedReasoning(model.id);
    if (!parsed) {
      if (!collapsedByBaseId.has(model.id)) {
        collapsedByBaseId.set(model.id, model);
      }
      continue;
    }

    variantCount += 1;
    wireIdByBaseAndEffort.set(variantKey(parsed.base, parsed.effort), model.id);
    const efforts = effortsByBaseId.get(parsed.base) ?? [];
    if (!efforts.includes(parsed.effort)) {
      efforts.push(parsed.effort);
      effortsByBaseId.set(parsed.base, efforts);
    }
    if (!collapsedByBaseId.has(parsed.base)) {
      const displayName = stripEmbeddedReasoningLabel(
        model.displayName ?? model.name,
      );
      collapsedByBaseId.set(parsed.base, {
        ...model,
        id: parsed.base,
        name: displayName ?? parsed.base,
        displayName: displayName ?? parsed.base,
      });
    }
  }

  const uniqueEfforts = [...new Set([...effortsByBaseId.values()].flat())].sort(
    (left, right) => effortSortRank(left) - effortSortRank(right),
  );

  if (variantCount < 2 || uniqueEfforts.length < 2) {
    return {
      models,
      wireIdByBaseAndEffort,
      effortsByBaseId,
      reasoning: null,
    };
  }

  const currentEffort =
    splitEmbeddedReasoning(currentModelId)?.effort ??
    uniqueEfforts[uniqueEfforts.length - 1] ??
    "high";

  return {
    models: [...collapsedByBaseId.values()],
    wireIdByBaseAndEffort,
    effortsByBaseId,
    reasoning: {
      configId: "model_reasoning",
      currentValue: currentEffort,
      options: uniqueEfforts.map((effort) => ({ id: effort, name: effort })),
    },
  };
}

export function composeEmbeddedReasoningModelId(
  baseId: string,
  effort: string | null | undefined,
  collapsed: CollapsedReasoningModels,
): string {
  const efforts = collapsed.effortsByBaseId.get(baseId) ?? [];
  const chosenEffort =
    (effort && efforts.includes(effort) ? effort : null) ??
    (collapsed.reasoning?.currentValue &&
    efforts.includes(collapsed.reasoning.currentValue)
      ? collapsed.reasoning.currentValue
      : null) ??
    efforts[0];
  if (!chosenEffort) {
    return baseId;
  }
  return (
    collapsed.wireIdByBaseAndEffort.get(variantKey(baseId, chosenEffort)) ??
    `${baseId}[${chosenEffort}]`
  );
}

export function grokReasoningEffortConfig(
  currentValue?: string | null,
): ChatSessionReasoningEffortConfig {
  const normalized = currentValue?.trim().toLowerCase() ?? "";
  const supported = GROK_REASONING_OPTIONS.some(
    (option) => option.id === normalized,
  );
  return {
    configId: "thinking_effort",
    currentValue: supported ? normalized : "high",
    options: GROK_REASONING_OPTIONS,
  };
}
