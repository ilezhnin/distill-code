export const STATUS_BAR_USAGE_MODE_KEY = "distill:status-bar-usage-mode";
export const STATUS_BAR_EMPTY_CTA_DISMISSED_KEY =
  "distill:status-bar-empty-cta-dismissed";

// Provider membership belongs to the shared catalog, not to quota adapters.
export type AgentPlatformId = string;

export type ProviderRateLimitStatus =
  | "idle"
  | "fetching"
  | "ok"
  | "error"
  | "unavailable";

export type StatusBarUsageMode = "verbose" | "compact";

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
  resetDescription: string | null;
}

export interface ProviderRateLimits {
  provider: AgentPlatformId;
  session: RateLimitWindow | null;
  weekly: RateLimitWindow | null;
  fableWeekly?: RateLimitWindow | null;
  monthly?: RateLimitWindow | null;
  codingMonthly?: RateLimitWindow | null;
  planType?: string | null;
  accountLabel?: string | null;
  updatedAt: number;
  error: string | null;
  status: ProviderRateLimitStatus;
  configured: boolean;
}

export interface ProviderRateLimitSnapshot {
  providers: ProviderRateLimits[];
  updatedAt: number;
}

export interface UsageSection {
  key: "session" | "weekly" | "fableWeekly" | "monthly" | "codingMonthly";
  label: string;
  shortLabel: string;
  window: RateLimitWindow;
}
