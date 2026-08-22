import { useTranslation } from "react-i18next";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import type { ProviderRateLimits } from "../lib/rateLimitTypes";
import {
  barColorClass,
  clampUsedPercent,
  getUsageSections,
} from "../lib/rateLimitWindows";
import {
  formatUsedPercent,
  getProviderUsageStatusKind,
  updatedAgoParts,
} from "../lib/rateLimitFormatters";
import { formatDuration } from "../lib/rateLimitWindows";

export function ProviderDetailsPanel({
  provider,
  now = Date.now(),
}: {
  provider: ProviderRateLimits;
  now?: number;
}) {
  const { t } = useTranslation("status");
  const name = t(`providers.${provider.provider}`);
  const sections = getUsageSections(provider);
  const statusKind = getProviderUsageStatusKind(provider);
  const updatedParts =
    provider.updatedAt > 0 ? updatedAgoParts(provider.updatedAt, now) : null;
  const updated = updatedParts
    ? t("roster.updated", {
        when:
          updatedParts.kind === "justNow"
            ? t("roster.justNow")
            : updatedParts.kind === "minutes"
              ? t("roster.minutesAgo", { count: updatedParts.count })
              : t("roster.hoursAgo", { count: updatedParts.count }),
      })
    : null;

  return (
    <div className="w-[260px] space-y-3 p-3 text-xs">
      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          {getProviderIcon(provider.provider, "size-3.5")}
          {name}
        </div>
        {updated ? (
          <div className="text-muted-foreground/80">{updated}</div>
        ) : null}
      </div>

      {statusKind === "refresh-failed" && sections.length === 0 ? (
        <div className="space-y-0.5">
          <div className="text-[11px] font-medium text-foreground/85">
            {t("bar.refreshFailed")}
          </div>
          <div className="text-muted-foreground">
            {provider.error ?? t("roster.signInToSee")}
          </div>
        </div>
      ) : null}

      {sections.length > 0 ? (
        <div className="border-t border-border/70" />
      ) : null}

      {sections.map((section) => {
        const used = clampUsedPercent(section.window.usedPercent);
        const reset =
          typeof section.window.resetsAt === "number"
            ? formatDuration(section.window.resetsAt - now)
            : null;
        const resetLabel =
          reset == null
            ? null
            : reset === "now"
              ? t("roster.resetsNow")
              : t("roster.resetsIn", { duration: reset });
        return (
          <div key={section.key} className="space-y-1">
            <div className="font-medium text-foreground">
              {t(`roster.${section.label}`)}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${barColorClass(used)}`}
                style={{ width: `${used}%` }}
              />
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>
                {t("roster.percentUsed", { percent: formatUsedPercent(used) })}
              </span>
              {resetLabel ? <span>{resetLabel}</span> : null}
            </div>
          </div>
        );
      })}

      {provider.error && sections.length > 0 ? (
        <div className="space-y-0.5">
          <div className="text-[11px] font-medium text-foreground/85">
            {t("roster.refreshFailedCached")}
          </div>
          <div className="text-muted-foreground">{provider.error}</div>
        </div>
      ) : null}
    </div>
  );
}
