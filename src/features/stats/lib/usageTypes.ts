export const USAGE_LEDGER_STORAGE_KEY = "goose:stats-usage-ledger";
export const USAGE_LEDGER_CHANGED_EVENT = "goose:stats-usage-ledger-changed";
export const USAGE_LEDGER_VERSION = 1;

export type UsageIntensity = 0 | 1 | 2 | 3 | 4;

export interface UsageSessionRecord {
  providerId: string;
  modelId: string | null;
  modelName: string | null;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  started: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number | null;
  turns: number;
  workedMs: number;
}

export interface UsageDailyRecord {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  byProvider: Record<string, number>;
}

export interface UsageLedger {
  version: typeof USAGE_LEDGER_VERSION;
  firstEventAt: number | null;
  lastUpdatedAt: number | null;
  sessions: Record<string, UsageSessionRecord>;
  daily: Record<string, UsageDailyRecord>;
}

export interface UsageSessionSource {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  messageCount: number;
  started?: boolean;
  providerId?: string | null;
  modelId?: string | null;
  modelName?: string | null;
}

export interface UsageTokenSnapshot {
  mode?: "replace" | "add" | "auto";
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  turnsDelta?: number;
}

export interface UsageProviderOverview {
  id: string;
  label: string;
  enabled: boolean;
  hasData: boolean;
  sessions: number;
  activityLabel: "turns" | "events";
  activityCount: number;
  totalTokens: number;
  newInputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  estimatedCostUsd: number | null;
  topModel: string | null;
  activeDays: number;
}

export interface UsageOverviewDailyPoint {
  day: string;
  totalTokens: number;
  activity: number;
  intensity: UsageIntensity;
}

export interface UsageOverviewModel {
  providers: UsageProviderOverview[];
  enabledProviderCount: number;
  dataProviderCount: number;
  hasAnyEnabledProvider: boolean;
  hasAnyData: boolean;
  totalTokens: number;
  newInputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  sessions: number;
  activityCount: number;
  activeDays: number;
  estimatedCostUsd: number | null;
  hasPartialCost: boolean;
  cacheShare: number | null;
  daily: UsageOverviewDailyPoint[];
  bestDay: UsageOverviewDailyPoint | null;
  lastUpdatedAt: number | null;
}

export interface UsageSummary {
  agentsSpawned: number;
  chatsStarted: number;
  workedMs: number;
  firstEventAt: number | null;
}
