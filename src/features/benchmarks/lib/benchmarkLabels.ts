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
