// Every status string the Rust service emits is labelled here. Unknown
// values fall back to a readable form instead of a raw key.
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

/** Everything but the model: provider, effort, fast mode and runtime revision. */
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
    configuration.providerId,
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
