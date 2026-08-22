import { formatLocalDay } from "./usageFormatters";
import { providerDisplayName } from "./usageProvider";
import type {
  UsageIntensity,
  UsageLedger,
  UsageOverviewDailyPoint,
  UsageOverviewModel,
  UsageProviderOverview,
} from "./usageTypes";

const RECENT_DAY_COUNT = 42;

function getIntensity(totalTokens: number, maxTokens: number): UsageIntensity {
  if (totalTokens <= 0 || maxTokens <= 0) {
    return 0;
  }
  const ratio = totalTokens / maxTokens;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export function getRecentUsageDays(
  daily: UsageOverviewDailyPoint[],
  dayCount = RECENT_DAY_COUNT,
  anchorDate = new Date(),
): UsageOverviewDailyPoint[] {
  const byDay = new Map(daily.map((entry) => [entry.day, entry]));
  const count = Math.max(1, Math.floor(dayCount));
  const end = new Date(anchorDate);
  end.setHours(0, 0, 0, 0);

  const result: UsageOverviewDailyPoint[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    const day = formatLocalDay(date);
    result.push(
      byDay.get(day) ?? {
        day,
        totalTokens: 0,
        activity: 0,
        intensity: 0,
      },
    );
  }
  return result;
}

function dailyTotalForFilter(
  record: UsageLedger["daily"][string],
  providerFilter: string | null,
): number {
  if (!providerFilter) return record.totalTokens;
  return record.byProvider[providerFilter] ?? 0;
}

function buildDailyPoints(
  ledger: UsageLedger,
  sessions: UsageLedger["sessions"][string][],
  providerFilter: string | null,
): UsageOverviewDailyPoint[] {
  const byDay = new Map<string, { totalTokens: number; activity: number }>();
  const ensureDay = (day: string) => {
    const existing = byDay.get(day);
    if (existing) return existing;
    const created = { totalTokens: 0, activity: 0 };
    byDay.set(day, created);
    return created;
  };

  for (const [day, record] of Object.entries(ledger.daily)) {
    ensureDay(day).totalTokens += dailyTotalForFilter(record, providerFilter);
  }
  for (const session of sessions) {
    if (session.lastActivityAt <= 0 && session.createdAt <= 0) continue;
    const timestamp = session.lastActivityAt || session.createdAt;
    const day = formatLocalDay(new Date(timestamp));
    ensureDay(day).activity += Math.max(
      session.messageCount,
      session.started ? 1 : 0,
    );
  }

  let maxTokens = 0;
  let maxActivity = 0;
  for (const entry of byDay.values()) {
    maxTokens = Math.max(maxTokens, entry.totalTokens);
    maxActivity = Math.max(maxActivity, entry.activity);
  }
  const intensityBasis = maxTokens > 0 ? "tokens" : "activity";
  return [...byDay.entries()]
    .map(([day, entry]) => ({
      day,
      totalTokens: entry.totalTokens,
      activity: entry.activity,
      intensity: getIntensity(
        intensityBasis === "tokens" ? entry.totalTokens : entry.activity,
        intensityBasis === "tokens" ? maxTokens : maxActivity,
      ),
    }))
    .sort((left, right) => left.day.localeCompare(right.day));
}

export function buildUsageOverview({
  ledger,
  enabledProviderIds = [],
  providerFilter = null,
}: {
  ledger: UsageLedger;
  enabledProviderIds?: readonly string[];
  providerFilter?: string | null;
}): UsageOverviewModel {
  const enabled = new Set(enabledProviderIds);
  const sessions = Object.values(ledger.sessions).filter((session) =>
    providerFilter ? session.providerId === providerFilter : true,
  );

  const byProvider = new Map<
    string,
    {
      sessions: number;
      activityCount: number;
      turns: number;
      events: number;
      totalTokens: number;
      newInputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      estimatedCostUsd: number | null;
      hasKnownCost: boolean;
      hasMissingCost: boolean;
      modelCounts: Map<string, number>;
      activeDays: Set<string>;
    }
  >();

  const ensureProvider = (id: string) => {
    const existing = byProvider.get(id);
    if (existing) return existing;
    const created = {
      sessions: 0,
      activityCount: 0,
      turns: 0,
      events: 0,
      totalTokens: 0,
      newInputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      estimatedCostUsd: null as number | null,
      hasKnownCost: false,
      hasMissingCost: false,
      modelCounts: new Map<string, number>(),
      activeDays: new Set<string>(),
    };
    byProvider.set(id, created);
    return created;
  };

  for (const id of enabled) {
    ensureProvider(id);
  }

  for (const session of sessions) {
    const provider = ensureProvider(session.providerId);
    provider.sessions += 1;
    provider.totalTokens += session.totalTokens;
    provider.newInputTokens += session.inputTokens;
    provider.outputTokens += session.outputTokens;
    provider.cacheTokens += session.cacheTokens;
    provider.turns += session.turns;
    provider.events += session.messageCount;
    if (session.costUsd != null) {
      provider.estimatedCostUsd =
        (provider.estimatedCostUsd ?? 0) + session.costUsd;
      provider.hasKnownCost = true;
    } else if (session.totalTokens > 0) {
      provider.hasMissingCost = true;
    }
    const modelLabel = session.modelName ?? session.modelId;
    if (modelLabel) {
      provider.modelCounts.set(
        modelLabel,
        (provider.modelCounts.get(modelLabel) ?? 0) + 1,
      );
    }
    if (session.lastActivityAt > 0) {
      provider.activeDays.add(formatLocalDay(new Date(session.lastActivityAt)));
    }
  }

  const providers: UsageProviderOverview[] = [...byProvider.entries()]
    .map(([id, provider]) => {
      const topModel =
        [...provider.modelCounts.entries()].sort(
          (left, right) => right[1] - left[1],
        )[0]?.[0] ?? null;
      const activityLabel = provider.turns > 0 ? "turns" : "events";
      const activityCount =
        activityLabel === "turns" ? provider.turns : provider.events;
      const hasData = provider.totalTokens > 0 || provider.sessions > 0;
      return {
        id,
        label: providerDisplayName(id),
        enabled: enabled.has(id) || hasData,
        hasData,
        sessions: provider.sessions,
        activityLabel,
        activityCount,
        totalTokens: provider.totalTokens,
        newInputTokens: provider.newInputTokens,
        outputTokens: provider.outputTokens,
        cacheTokens: provider.cacheTokens,
        estimatedCostUsd: provider.hasKnownCost
          ? provider.estimatedCostUsd
          : null,
        topModel,
        activeDays: provider.activeDays.size,
      } satisfies UsageProviderOverview;
    })
    .sort((left, right) => {
      if (right.totalTokens !== left.totalTokens) {
        return right.totalTokens - left.totalTokens;
      }
      return left.label.localeCompare(right.label);
    });

  const daily = buildDailyPoints(ledger, sessions, providerFilter);
  const bestDay =
    daily.reduce<UsageOverviewDailyPoint | null>((best, entry) => {
      if (!best) return entry;
      if (entry.totalTokens !== best.totalTokens) {
        return entry.totalTokens > best.totalTokens ? entry : best;
      }
      return entry.activity > best.activity ? entry : best;
    }, null) ?? null;

  const totalTokens = providers.reduce(
    (sum, provider) => sum + provider.totalTokens,
    0,
  );
  const newInputTokens = providers.reduce(
    (sum, provider) => sum + provider.newInputTokens,
    0,
  );
  const outputTokens = providers.reduce(
    (sum, provider) => sum + provider.outputTokens,
    0,
  );
  const cacheTokens = providers.reduce(
    (sum, provider) => sum + provider.cacheTokens,
    0,
  );
  const sessionCount = providers.reduce(
    (sum, provider) => sum + provider.sessions,
    0,
  );
  const activityCount = providers.reduce(
    (sum, provider) => sum + provider.activityCount,
    0,
  );
  const hasKnownCost = providers.some(
    (provider) => provider.estimatedCostUsd !== null,
  );
  const hasPartialCost = providers.some(
    (provider) => provider.hasData && provider.estimatedCostUsd === null,
  );
  const estimatedCostUsd = hasKnownCost
    ? providers.reduce(
        (sum, provider) => sum + (provider.estimatedCostUsd ?? 0),
        0,
      )
    : null;

  return {
    providers,
    enabledProviderCount: providers.filter((provider) => provider.enabled)
      .length,
    dataProviderCount: providers.filter((provider) => provider.hasData).length,
    hasAnyEnabledProvider: providers.some((provider) => provider.enabled),
    hasAnyData: providers.some((provider) => provider.hasData),
    totalTokens,
    newInputTokens,
    outputTokens,
    cacheTokens,
    sessions: sessionCount,
    activityCount,
    activeDays: new Set(
      daily
        .filter((entry) => entry.totalTokens > 0 || entry.activity > 0)
        .map((entry) => entry.day),
    ).size,
    estimatedCostUsd,
    hasPartialCost,
    cacheShare:
      newInputTokens + cacheTokens > 0
        ? cacheTokens / (newInputTokens + cacheTokens)
        : null,
    daily,
    bestDay:
      bestDay && (bestDay.totalTokens > 0 || bestDay.activity > 0)
        ? bestDay
        : null,
    lastUpdatedAt: ledger.lastUpdatedAt,
  };
}
