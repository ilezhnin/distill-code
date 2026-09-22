import type { ModelOption } from "../../types";

export const CLAUDE_PROVIDER_ID = "claude-acp";
export const CODEX_PROVIDER_ID = "codex-acp";

const CLAUDE_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
  { id: "max", name: "Max" },
];

function claudeRow(
  id: string,
  name: string,
  group: "main" | "more",
  order: number,
  extra: Partial<ModelOption> = {},
): ModelOption {
  return {
    id,
    name,
    providerId: CLAUDE_PROVIDER_ID,
    recommended: true,
    group,
    order,
    sortOrder: order,
    ...extra,
  };
}

/** The ten rows the host serves for Claude Code, as the renderer maps them. */
export const claudeModels: ModelOption[] = [
  claudeRow("claude-fable-5-1[1m]", "Fable 5.1", "main", 10, {
    opensOnModel: true,
    efforts: CLAUDE_EFFORTS,
    supportsFast: false,
    capabilitySource: "declared",
  }),
  claudeRow("opus[1m]", "Opus 5", "main", 20, {
    efforts: CLAUDE_EFFORTS,
    supportsFast: true,
    capabilitySource: "probed",
  }),
  claudeRow("default", "Opus 5", "main", 20, {
    aliasOf: "opus[1m]",
    capabilitySource: "unknown",
  }),
  claudeRow("sonnet", "Sonnet 5", "main", 30, {
    efforts: CLAUDE_EFFORTS,
    supportsFast: false,
    capabilitySource: "probed",
  }),
  claudeRow("haiku", "Haiku 4.5", "main", 40, {
    efforts: [],
    supportsFast: false,
    capabilitySource: "probed",
  }),
  claudeRow("claude-fable-5[1m]", "Fable 5", "more", 50, {
    efforts: CLAUDE_EFFORTS,
    supportsFast: false,
    capabilitySource: "probed",
  }),
  claudeRow("claude-opus-4-8", "Opus 4.8", "more", 60, {
    opensOnModel: true,
    efforts: CLAUDE_EFFORTS,
    supportsFast: true,
    capabilitySource: "declared",
  }),
  claudeRow("claude-opus-4-7", "Opus 4.7", "more", 70, {
    opensOnModel: true,
    efforts: CLAUDE_EFFORTS,
    supportsFast: true,
    capabilitySource: "declared",
  }),
  claudeRow("claude-opus-4-6", "Opus 4.6", "more", 80, {
    opensOnModel: true,
    efforts: CLAUDE_EFFORTS.filter((effort) => effort.id !== "xhigh"),
    supportsFast: false,
    capabilitySource: "declared",
  }),
  claudeRow("claude-sonnet-4-6", "Sonnet 4.6", "more", 90, {
    opensOnModel: true,
    efforts: CLAUDE_EFFORTS.filter((effort) => effort.id !== "xhigh"),
    supportsFast: false,
    capabilitySource: "declared",
  }),
];

/**
 * Codex rows: the newest generation is main, ordered by the bridge's own order
 * (the host gives them a `sortOrder` and no `order`).
 */
export const codexModels: ModelOption[] = [
  ["gpt-6-astra", "GPT-6-Astra", true],
  ["gpt-6-sol", "GPT-6-Sol", true],
  ["gpt-6-luna", "GPT-6-Luna", true],
  ["gpt-5.6-sol", "GPT-5.6-Sol", true],
  ["gpt-5.6-terra", "GPT-5.6-Terra", true],
  ["gpt-5.6-luna", "GPT-5.6-Luna", true],
  ["gpt-5.5", "GPT-5.5", true],
  ["gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", false],
].map(([id, name, supportsFast], index) => ({
  id: id as string,
  name: name as string,
  providerId: CODEX_PROVIDER_ID,
  recommended: true,
  group: (id as string).startsWith("gpt-6-") ? "main" : "more",
  sortOrder: 1000 + index,
  supportsFast: supportsFast as boolean,
  capabilitySource: "probed" as const,
}));

/** Labels of a picker column's model rows, in the order they render. */
export function modelRowLabels(column: "model" | "more"): string[] {
  return modelRows(column).map((row) => row.textContent?.trim() ?? "");
}

/** A picker column's model rows: no Back, More models or fast-mode controls. */
export function modelRows(column: "model" | "more"): HTMLButtonElement[] {
  const element = document.querySelector(`[data-col="${column}"]`);
  if (!element) {
    throw new Error(`No picker column "${column}" is rendered`);
  }
  return Array.from(
    element.querySelectorAll<HTMLButtonElement>(
      "button[data-picker-nav-item]:not([data-picker-back]):not([data-picker-more-trigger]):not([role='switch'])",
    ),
  );
}

export function modelRow(
  column: "model" | "more",
  label: string,
): HTMLButtonElement {
  const row = modelRows(column).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!row) {
    throw new Error(`No "${label}" row in the ${column} column`);
  }
  return row;
}

export function moreModelsRow(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "button[data-picker-more-trigger]",
  );
}
