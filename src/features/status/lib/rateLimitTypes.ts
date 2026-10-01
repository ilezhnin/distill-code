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

export type UsagePeriod = "session" | "weekly" | "monthly";

export interface ProviderRateLimits {
  provider: AgentPlatformId;
  accountId?: string;
  accountLimited?: boolean;
  session: RateLimitWindow | null;
  weekly: RateLimitWindow | null;
  fableWeekly?: RateLimitWindow | null;
  monthly?: RateLimitWindow | null;
  codingMonthly?: RateLimitWindow | null;
  modelWindows?: {
    modelId: string;
    period: UsagePeriod;
    window: RateLimitWindow;
  }[];
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
  key:
    | UsagePeriod
    | "fableWeekly"
    | "codingMonthly"
    | `model:${string}:${UsagePeriod}`;
  modelId?: string;
  label: string;
  shortLabel: string;
  window: RateLimitWindow;
}
