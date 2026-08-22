import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/ui/badge";
import {
  formatUsageCost,
  formatUsageTokens,
} from "@/features/stats/lib/usageFormatters";
import type {
  UsageOverviewDailyPoint,
  UsageOverviewModel,
  UsageProviderOverview,
} from "@/features/stats/lib/usageTypes";

const INTENSITY_CLASS: Record<UsageOverviewDailyPoint["intensity"], string> = {
  0: "border-border/60 bg-muted/40",
  1: "border-border/60 bg-muted-foreground/20",
  2: "border-border/60 bg-muted-foreground/35",
  3: "border-border/60 bg-muted-foreground/55",
  4: "border-border/60 bg-foreground/75",
};

function formatDayLabel(day: string): string {
  const parsed = new Date(`${day}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return day;
  }
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function TokenMixBar({ overview }: { overview: UsageOverviewModel }) {
  const { t } = useTranslation("settings");
  const segments = [
    {
      key: "new-input",
      label: t("stats.newInput"),
      value: overview.newInputTokens,
      className: "bg-foreground",
    },
    {
      key: "output",
      label: t("stats.output"),
      value: overview.outputTokens,
      className: "bg-muted-foreground",
    },
    {
      key: "cache",
      label: t("stats.cache"),
      value: overview.cacheTokens,
      className: "bg-border",
    },
  ];
  const mixTotal = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {t("stats.tokenMix")}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t("stats.tokenMixDescription")}
        </p>
      </div>

      {mixTotal > 0 ? (
        <div
          role="img"
          className="flex h-3 overflow-hidden rounded-full border border-border/60 bg-muted"
          aria-label={t("stats.tokenMixAria")}
        >
          {segments.map((segment) =>
            segment.value > 0 ? (
              <div
                key={segment.key}
                aria-hidden
                className={segment.className}
                style={{ width: `${(segment.value / mixTotal) * 100}%` }}
              />
            ) : null,
          )}
        </div>
      ) : (
        <div className="h-3 rounded-full border border-dashed border-border/60 bg-muted/40" />
      )}

      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        {segments.map((segment) => (
          <div key={segment.key} className="flex min-w-0 items-center gap-2">
            <span
              className={`size-2 shrink-0 rounded-full ${segment.className}`}
            />
            <span className="min-w-0 truncate">
              {segment.label}: {formatUsageTokens(segment.value)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DailyIntensityGrid({
  days,
  bestDay,
}: {
  days: UsageOverviewDailyPoint[];
  bestDay: UsageOverviewDailyPoint | null;
}) {
  const { t } = useTranslation("settings");

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {t("stats.dailyIntensity")}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t("stats.dailyIntensityDescription")}
          </p>
        </div>
        {bestDay && bestDay.totalTokens > 0 ? (
          <Badge variant="outline" className="shrink-0">
            {t("stats.bestDay", { date: formatDayLabel(bestDay.day) })}
          </Badge>
        ) : null}
      </div>

      <div
        role="img"
        className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(21,minmax(0,1fr))]"
        aria-label={t("stats.heatmapAria")}
      >
        {days.map((day) => (
          <div
            key={day.day}
            aria-hidden
            className={`aspect-square min-h-3 rounded-[2px] border ${INTENSITY_CLASS[day.intensity]}`}
            title={t("stats.segmentAria", {
              label: day.day,
              tokens: formatUsageTokens(day.totalTokens),
            })}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{formatDayLabel(days[0]?.day ?? "")}</span>
        <span>{t("stats.less")}</span>
        <div className="flex items-center gap-1" aria-hidden>
          {([0, 1, 2, 3, 4] as const).map((intensity) => (
            <span
              key={intensity}
              className={`size-2 rounded-[2px] border ${INTENSITY_CLASS[intensity]}`}
            />
          ))}
        </div>
        <span>{t("stats.more")}</span>
        <span>{formatDayLabel(days.at(-1)?.day ?? "")}</span>
      </div>
    </section>
  );
}

export function ProviderUsageRow({
  provider,
  totalTokens,
}: {
  provider: UsageProviderOverview;
  totalTokens: number;
}) {
  const { t } = useTranslation("settings");
  const share = totalTokens > 0 ? provider.totalTokens / totalTokens : 0;
  const status = provider.enabled
    ? t("stats.statusEnabled")
    : t("stats.statusOff");
  const activityLabel =
    provider.activityLabel === "turns" ? t("stats.turns") : t("stats.events");

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h5 className="truncate text-sm font-semibold text-foreground">
              {provider.label}
            </h5>
            <Badge variant={provider.enabled ? "secondary" : "outline"}>
              {status}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {provider.topModel ?? t("stats.noModelYet")}
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <span>
          {formatUsageTokens(provider.totalTokens)} {t("stats.tokens")}
        </span>
        <span>
          {t("stats.sessionsActivity", {
            sessions: provider.sessions.toLocaleString(),
            activity: provider.activityCount.toLocaleString(),
            activityLabel,
          })}
        </span>
        <span>
          {formatUsageCost(
            provider.estimatedCostUsd,
            t("stats.costUnavailable"),
          )}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/75"
          style={{
            width: `${Math.max(share * 100, provider.totalTokens > 0 ? 2 : 0)}%`,
          }}
        />
      </div>
    </div>
  );
}
