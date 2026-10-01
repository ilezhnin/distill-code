import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import type { ProviderRateLimits } from "../lib/rateLimitTypes";
import { formatUsedPercent, resetDuration } from "../lib/rateLimitFormatters";
import {
  barColorClass,
  clampUsedPercent,
  getUsageSections,
} from "../lib/rateLimitWindows";

/** The same quota rows in account settings, the picker and status details. */
export function UsageLimits({
  provider,
  now,
}: {
  provider: ProviderRateLimits;
  now: number;
}) {
  const { t } = useTranslation("status");
  const { formatDate } = useLocaleFormatting();
  return getUsageSections(provider).map((section) => {
    const used = clampUsedPercent(section.window.usedPercent);
    const periodLabel = t(`roster.${section.label}`);
    const label = section.modelId
      ? t("roster.modelWindow", { model: section.modelId, window: periodLabel })
      : periodLabel;
    const reset = resetDuration(section.window.resetsAt, now);
    const resetLabel =
      reset == null
        ? null
        : reset === "now"
          ? t("roster.resetsNow")
          : t("roster.resetsIn", { duration: reset });
    return (
      <div key={section.key} className="space-y-1">
        <div className="font-medium text-foreground">{label}</div>
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full", barColorClass(used))}
            style={{ width: `${used}%` }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-muted-foreground">
          <span>
            {t("roster.percentUsed", { percent: formatUsedPercent(used) })}
          </span>
          {resetLabel && section.window.resetsAt != null ? (
            <time
              dateTime={new Date(section.window.resetsAt).toISOString()}
              title={formatDate(section.window.resetsAt, {
                dateStyle: "short",
                timeStyle: "short",
              })}
            >
              {resetLabel}
            </time>
          ) : null}
        </div>
      </div>
    );
  });
}
