export const USAGE_LEDGER_STORAGE_KEY = "distill:stats-usage-ledger";
export const USAGE_LEDGER_CHANGED_EVENT = "distill:stats-usage-ledger-changed";
export const USAGE_LEDGER_VERSION = 1;

export type UsageIntensity = 0 | 1 | 2 | 3 | 4;

export interface UsageSessionRecord {
  providerId: string;
  /**
   * The model as the session last named it. Rows written while an effort was
   * folded into the id (`gpt-5.6-sol[low]`) keep that spelling; the stats page
   * reads it through `baseModelId`, so it is never rewritten here.
   */
  modelId: string | null;
  modelName: string | null;
  /**
   * The reasoning effort the session last ran at, in the harness's own
   * vocabulary. Absent on rows written before effort was its own selection.
   */
  effort?: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  started: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number | null;
  /**
   * Currency of `costUsd` as the bridge reported it (`usage_update.cost`).
   * `null` means it did not say, which is read as USD.
   */
  costCurrency: string | null;
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

/**
 * Totals of session records that aged out of the ledger, kept per provider so
 * the stats page still reports them after the detailed records are pruned.
 */
export interface UsageArchivedRecord {
  sessions: number;
  chatsStarted: number;
  messageCount: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costCurrency: string | null;
  /**
   * True once a fold dropped a session's cost because it was in another
   * currency. `costUsd` is then real but incomplete, which is the one thing a
   * single figure cannot say about itself — without this the stats page shows a
   * confident total that silently omits the dropped amounts.
   */
  hasMissingCost?: boolean;
  workedMs: number;
  activeDays: number;
}

export interface UsageLedger {
  version: typeof USAGE_LEDGER_VERSION;
  firstEventAt: number | null;
  lastUpdatedAt: number | null;
  sessions: Record<string, UsageSessionRecord>;
  daily: Record<string, UsageDailyRecord>;
  archived?: Record<string, UsageArchivedRecord>;
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
  effort?: string | null;
}

export interface UsageTokenSnapshot {
  mode?: "replace" | "add" | "auto";
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  /** Omit when the source does not say; `null` also means unknown (USD). */
  costCurrency?: string | null;
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
  /** Currency the cost is in; `null` when unknown (read as USD). */
  costCurrency: string | null;
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
  costCurrency: string | null;
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
