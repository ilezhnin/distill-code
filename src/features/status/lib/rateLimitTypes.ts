export const STATUS_BAR_USAGE_MODE_KEY = "goose:status-bar-usage-mode";
export const STATUS_BAR_EMPTY_CTA_DISMISSED_KEY =
  "goose:status-bar-empty-cta-dismissed";

export const TRACKED_AGENT_PLATFORM_IDS = [
  "claude-acp",
  "grok-acp",
  "codex-acp",
] as const;

export type AgentPlatformId = (typeof TRACKED_AGENT_PLATFORM_IDS)[number];

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
  key: "session" | "weekly" | "fableWeekly" | "monthly";
  label: string;
  shortLabel: string;
  window: RateLimitWindow;
}

export const SESSION_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10_080;
export const MONTHLY_WINDOW_MINUTES = 43_200;
