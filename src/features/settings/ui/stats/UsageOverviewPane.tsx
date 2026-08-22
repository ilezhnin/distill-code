import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  CalendarDays,
  Coins,
  DatabaseZap,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import {
  formatUsageCost,
  formatUsagePercent,
  formatUsageTokens,
} from "@/features/stats/lib/usageFormatters";
import {
  buildUsageOverview,
  getRecentUsageDays,
} from "@/features/stats/lib/usageOverviewModel";
import type { UsageLedger } from "@/features/stats/lib/usageTypes";
import { StatCard } from "./StatCard";
import {
  DailyIntensityGrid,
  ProviderUsageRow,
  TokenMixBar,
} from "./usage-overview-sections";

const RECENT_DAY_COUNT = 42;

export function UsageOverviewPane({
  ledger,
  enabledProviderIds,
  providerFilter,
}: {
  ledger: UsageLedger;
  enabledProviderIds: readonly string[];
  providerFilter: string | null;
}) {
  const { t } = useTranslation("settings");
  const unavailable = t("stats.costUnavailable");
  const overview = useMemo(
    () =>
      buildUsageOverview({
        ledger,
        enabledProviderIds,
        providerFilter,
      }),
    [enabledProviderIds, ledger, providerFilter],
  );
  const recentDays = useMemo(
    () => getRecentUsageDays(overview.daily, RECENT_DAY_COUNT),
    [overview.daily],
  );
  const updatedLabel = overview.lastUpdatedAt
    ? t("stats.updatedAt", {
        date: new Date(overview.lastUpdatedAt).toLocaleString(),
      })
    : t("stats.notUpdated");

  return (
    <div className="space-y-4" data-testid="usage-overview-pane">
      <section className="rounded-lg border border-border/60 bg-card/30 p-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {t("stats.usageOverview")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {updatedLabel}
            {overview.hasPartialCost ? t("stats.partialCost") : ""}
          </p>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <StatCard
            label={t("stats.totalTokens")}
            value={formatUsageTokens(overview.totalTokens)}
            icon={<Sparkles className="size-4" />}
          />
          <StatCard
            label={t("stats.estCost")}
            value={formatUsageCost(overview.estimatedCostUsd, unavailable)}
            icon={<Coins className="size-4" />}
          />
          <StatCard
            label={t("stats.activeDays")}
            value={overview.activeDays.toLocaleString()}
            icon={<CalendarDays className="size-4" />}
          />
          <StatCard
            label={t("stats.cacheShare")}
            value={formatUsagePercent(overview.cacheShare, unavailable)}
            icon={<DatabaseZap className="size-4" />}
          />
        </div>

        {!overview.hasAnyData ? (
          <div className="mt-4 rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
            {t("stats.noUsageYet")}
          </div>
        ) : (
          <div className="mt-4 grid gap-4">
            <DailyIntensityGrid days={recentDays} bestDay={overview.bestDay} />
            <TokenMixBar overview={overview} />
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {t("stats.providers")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t("stats.providersSummary", {
                enabled: overview.enabledProviderCount,
                withData: overview.dataProviderCount,
              })}
            </p>
          </div>
          <Badge variant="outline" className="gap-1">
            <Activity className="size-3" />
            {t("stats.sessionsBadge", {
              count: overview.sessions.toLocaleString(),
            })}
          </Badge>
        </div>
        {overview.providers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
            {t("stats.noUsageYet")}
          </div>
        ) : (
          <div className="grid gap-3">
            {overview.providers.map((provider) => (
              <ProviderUsageRow
                key={provider.id}
                provider={provider}
                totalTokens={overview.totalTokens}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
