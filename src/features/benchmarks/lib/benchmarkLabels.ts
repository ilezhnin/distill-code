// Every status string the Rust service emits is labelled here. Unknown
// values fall back to a readable form instead of a raw key.
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
export type StateTone = "positive" | "negative" | "neutral";

const POSITIVE = new Set([
  "pass",
  "completed",
  "comparable",
  "controlled_batch",
  "measured",
]);
const NEGATIVE = new Set([
  "fail",
  "budget_timeout",
  "budget_reached",
  "selection_changed",
  "quota_blocked",
  "dispatch_uncertain",
  "infrastructure_failure",
  "evaluation_error",
  "needs_attention",
  "confirmed_change",
  "storage_unavailable",
  "capability_missing",
  "unsupported",
  "validation",
  "evidence_missing",
]);

export function stateTone(state: string | null | undefined): StateTone {
  if (!state) return "neutral";
  if (POSITIVE.has(state)) return "positive";
  if (NEGATIVE.has(state)) return "negative";
  return "neutral";
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function stateLabel(
  t: Translate,
  state: string | null | undefined,
): string {
  if (!state) return t("unknown");
  const readable = state.replace(/_/g, " ");
  return t(`states.${state}`, {
    defaultValue: readable.charAt(0).toUpperCase() + readable.slice(1),
  });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatQuality(
  t: Translate,
  quality: number | null | undefined,
): string {
  return quality == null
    ? t("unknown")
    : t("percent", { value: (quality * 100).toFixed(1) });
}

export function formatSeconds(
  t: Translate,
  milliseconds: number | null | undefined,
): string {
  return milliseconds == null
    ? t("unknown")
    : t("seconds", { value: (milliseconds / 1000).toFixed(2) });
}

export function formatCost(
  t: Translate,
  cost: number | null | undefined,
  digits = 4,
): string {
  return cost == null ? t("unknown") : cost.toFixed(digits);
}

export function formatTokens(
  t: Translate,
  tokens: number | null | undefined,
): string {
  return tokens == null
    ? t("unknown")
    : t("tokens", { value: Math.round(tokens).toLocaleString("en-US") });
}

/** Measured USD with three significant digits: $0.386, $0.0078, $12.3. */
export function formatUsd(
  t: Translate,
  cost: number | null | undefined,
): string {
  if (cost == null) return t("unknown");
  return `$${Number(cost.toPrecision(3)).toString()}`;
}

/** Signed percent change, for example +12.3% or −4.0%. */
export function formatChange(
  t: Translate,
  percent: number | null | undefined,
): string {
  if (percent == null) return t("unknown");
  const sign = percent > 0 ? "+" : percent < 0 ? "−" : "";
  return t("percent", { value: `${sign}${Math.abs(percent).toFixed(1)}` });
}

/** A board's name: the work class, or the shared measurement. */
export function boardTitle(
  t: Translate,
  board: { id: string; workClass: string | null },
): string {
  return board.workClass
    ? workClassLabel(t, board.workClass)
    : t(`leaderboard.boards.${board.id}`);
}

export function boardDescription(
  t: Translate,
  board: { id: string; workClass: string | null },
): string {
  return board.workClass
    ? t("leaderboard.boardDescriptions.class", {
        label: workClassLabel(t, board.workClass),
      })
    : t(`leaderboard.boardDescriptions.${board.id}`);
}

export function workClassLabel(t: Translate, workClass: string): string {
  return t(`settings:routing.classes.${workClass}`, {
    defaultValue: workClass,
  });
}

export function quotaWindowLabel(t: Translate, windowId: string): string {
  if (windowId === "five_hour") return t("usage.windows.fiveHour");
  if (windowId === "seven_day") return t("usage.windows.weekly");
  if (windowId.startsWith("seven_day_"))
    return t("usage.windows.weeklyModel", {
      model: windowId.slice("seven_day_".length),
    });
  if (windowId === "unreported") return t("unknown");
  return windowId;
}

const VENDORS: [RegExp, string][] = [
  [/claude|anthropic/, "Anthropic"],
  [/codex|openai|chatgpt/, "OpenAI"],
  [/grok|xai/, "xAI"],
  [/kimi|moonshot/, "Moonshot AI"],
  [/gemini|google/, "Google"],
  [/copilot/, "GitHub"],
  [/cursor/, "Cursor"],
  [/amp/, "Sourcegraph"],
];

/** The lab behind a provider id, the way the reference labels a row. */
export function providerVendor(providerId: string): string {
  const id = providerId.toLowerCase();
  return (
    VENDORS.find(([pattern]) => pattern.test(id))?.[1] ??
    formatProviderLabel(providerId)
  );
}

/**
 * The bridge's display name with the vendor in front where the bridge omits
 * it (Claude Code lists "Opus 5.5"); the raw id when nothing names it.
 */
export function modelDisplayName(
  configuration: {
    providerId: string;
    modelId: string;
    modelName?: string | null;
  },
  fallback?: string | null,
): string {
  const raw =
    (configuration.modelName ?? fallback ?? "").trim() || configuration.modelId;
  if (
    providerVendor(configuration.providerId) === "Anthropic" &&
    /^(opus|sonnet|haiku|fable)\b/i.test(raw)
  )
    return `Claude ${raw}`;
  return raw;
}

/** Vendor and provider: the quiet line under a model name. */
export function configurationOrigin(configuration: {
  providerId: string;
}): string {
  return `${providerVendor(configuration.providerId)} · ${configuration.providerId}`;
}

/** Origin plus effort, fast mode and runtime revision, for dialog subtitles. */
export function configurationDetails(
  t: Translate,
  configuration: {
    providerId: string;
    effort: string | null;
    fastMode: boolean | null;
    inventoryRevision: string | null;
  },
): string {
  return [
    configurationOrigin(configuration),
    configuration.effort,
    configuration.fastMode === true ? t("fastMode") : null,
    configuration.inventoryRevision
      ? t("leaderboard.runtime", {
          id: shortId(configuration.inventoryRevision),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
