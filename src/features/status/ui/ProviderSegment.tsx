import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import type {
  ProviderRateLimits,
  StatusBarUsageMode,
} from "../lib/rateLimitTypes";
import {
  clampUsedPercent,
  getTightestUsageSection,
  getUsageSections,
  remainingDurationLabel,
} from "../lib/rateLimitWindows";
import { formatUsedPercent } from "../lib/rateLimitFormatters";

function MiniBar({ usedPercent }: { usedPercent: number }) {
  return (
    <span
      data-usage-bar
      className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted"
    >
      <span
        className="block h-full rounded-full bg-muted-foreground/40"
        style={{ width: `${clampUsedPercent(usedPercent)}%` }}
      />
    </span>
  );
}

export function ProviderSegment({
  provider,
  compact = false,
  mode = "verbose",
  now = Date.now(),
}: {
  provider: ProviderRateLimits;
  compact?: boolean;
  mode?: StatusBarUsageMode;
  now?: number;
}) {
  const { t } = useTranslation("status");
  const icon = getProviderIcon(provider.provider, "size-3.5");
  const sections = getUsageSections(provider);
  const tightest = getTightestUsageSection(provider);
  const statusLabel =
    provider.status === "error"
      ? t("bar.refreshFailed")
      : provider.status === "unavailable"
        ? t("bar.unavailable")
        : "";

  if (
    provider.status === "idle" ||
    (provider.status === "fetching" && !tightest)
  ) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        {icon}
        <span className="animate-pulse">···</span>
      </span>
    );
  }

  if (provider.status === "error" && !tightest) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <AlertTriangle className="size-2.5 text-muted-foreground/80" />
        {!compact ? (
          <span className="text-[11px] font-medium">{statusLabel}</span>
        ) : null}
      </span>
    );
  }

  const isStale = provider.status === "error";

  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      {mode === "verbose" ? (
        <>
          {tightest && !compact ? (
            <MiniBar
              usedPercent={clampUsedPercent(tightest.window.usedPercent)}
            />
          ) : null}
          <span className="inline-flex items-center gap-1 text-[11px] text-foreground">
            {sections.map((section, index) => {
              const percent = formatUsedPercent(section.window.usedPercent);
              const remaining = remainingDurationLabel(section.window, now);
              const label =
                section.key === "fableWeekly"
                  ? t("roster.usedFable", { percent })
                  : remaining === "now"
                    ? t("roster.usedNow", { percent })
                    : t("roster.usedWindow", { percent, window: remaining });
              return (
                <span
                  key={section.key}
                  className="inline-flex items-center gap-1"
                >
                  {index > 0 ? (
                    <span className="text-muted-foreground">·</span>
                  ) : null}
                  <span className="tabular-nums">{label}</span>
                </span>
              );
            })}
          </span>
        </>
      ) : tightest ? (
        <span className="tabular-nums text-[11px] text-foreground">
          {formatUsedPercent(tightest.window.usedPercent)}
          {!compact ? ` ${remainingDurationLabel(tightest.window, now)}` : ""}
        </span>
      ) : null}
      {isStale ? (
        <AlertTriangle className="size-2.5 text-muted-foreground/80" />
      ) : null}
    </span>
  );
}
