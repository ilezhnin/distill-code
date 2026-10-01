import { useTranslation } from "react-i18next";
import { providerDisplayName } from "@/features/providers/providerCatalog";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import type { ProviderRateLimits } from "../lib/rateLimitTypes";
import { getUsageSections } from "../lib/rateLimitWindows";
import {
  getProviderUsageStatusKind,
  updatedAgoParts,
} from "../lib/rateLimitFormatters";
import { useProviderRateLimitsStore } from "../stores/providerRateLimitsStore";
import { UsageLimits } from "./UsageLimits";

export function ProviderDetailsPanel({
  provider,
  now = Date.now(),
}: {
  provider: ProviderRateLimits;
  now?: number;
}) {
  const { t } = useTranslation("status");
  const name = providerDisplayName(provider.provider);
  const sections = getUsageSections(provider);
  const statusKind = getProviderUsageStatusKind(provider);
  // A poll that brings back the same usage keeps the provider object it had,
  // so the latest fetch time is read from the store.
  const fetchedAt =
    useProviderRateLimitsStore(
      (state) => state.fetchedAtByProvider[provider.provider],
    ) ?? provider.updatedAt;
  const updatedParts = fetchedAt > 0 ? updatedAgoParts(fetchedAt, now) : null;
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

      {statusKind === "sign-in" && sections.length === 0 ? (
        <div className="space-y-0.5">
          <div className="text-[11px] font-medium text-foreground/85">
            {t("roster.signInExpired")}
          </div>
          <div className="break-words text-muted-foreground">
            {provider.error ?? t("roster.signInToSee")}
          </div>
        </div>
      ) : null}

      {statusKind === "refresh-failed" && sections.length === 0 ? (
        <div className="space-y-0.5">
          <div className="text-[11px] font-medium text-foreground/85">
            {t("bar.refreshFailed")}
          </div>
          <div className="break-words text-muted-foreground">
            {provider.error ?? t("roster.signInToSee")}
          </div>
        </div>
      ) : null}

      {statusKind === "ok" && sections.length === 0 ? (
        <div className="text-muted-foreground">
          {t("roster.limitsUnavailable")}
        </div>
      ) : null}

      {sections.length > 0 ? (
        <div className="border-t border-border/70" />
      ) : null}

      <UsageLimits provider={provider} now={now} />

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
