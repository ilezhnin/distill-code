import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { accountUsageFor } from "@/features/status/lib/accountUsage";
import { getUsageSections } from "@/features/status/lib/rateLimitWindows";
import { UsageLimits } from "@/features/status/ui/UsageLimits";
import { Badge } from "@/shared/ui/badge";
import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "../api/providerAccounts";
import { accountStatusIsStale } from "../lib/providerAccountStatus";

export function ProviderAccountDetails({
  account,
  status,
  now,
}: {
  account: ProviderAccount;
  status: ProviderAccountStatus | undefined;
  now: number;
}) {
  const usage = accountUsageFor(account, status);
  const { t } = useTranslation("settings");
  const { formatDate, formatNumber } = useLocaleFormatting();
  const date = (value: number) =>
    formatDate(value, { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {status?.state !== "ready" ? (
          <Badge
            variant={
              status?.state === "limited" ||
              status?.state === "error" ||
              status?.state === "needs_auth"
                ? "destructive"
                : "secondary"
            }
          >
            {t(`accounts.states.${status?.state ?? "unknown"}`)}
          </Badge>
        ) : null}
        <span className="text-muted-foreground">
          {t("accounts.subscription", {
            value: status?.subscription ?? t("accounts.notReported"),
          })}
        </span>
        {status && accountStatusIsStale(status, now) ? (
          <Badge variant="outline">{t("accounts.stale")}</Badge>
        ) : null}
      </div>
      {getUsageSections(usage).length ? (
        <UsageLimits provider={usage} now={now} />
      ) : (
        <p className="text-muted-foreground">{t("accounts.limitsUnknown")}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>
          {t("accounts.resetTokens", {
            value: status?.resetTokens
              ? formatNumber(status.resetTokens.available)
              : t("accounts.notReported"),
          })}
        </span>
        {status?.resetTokens?.expiresAt ? (
          <span>
            {t("accounts.expiresAt", {
              date: date(status.resetTokens.expiresAt),
            })}
          </span>
        ) : null}
        {status?.credits ? (
          <span>
            {t("accounts.credits", {
              value: status.credits.unlimited
                ? t("accounts.unlimited")
                : (status.credits.balance ?? t("accounts.notReported")),
            })}
          </span>
        ) : null}
      </div>
      {status?.resetTokens?.credits?.length ? (
        <div className="space-y-1 text-muted-foreground">
          {status.resetTokens.credits.map((credit) => (
            <p key={credit.id} title={credit.description ?? undefined}>
              {credit.title ?? credit.resetType}
              {" · "}
              {credit.status}
              {credit.expiresAt
                ? ` · ${t("accounts.expiresAt", { date: date(credit.expiresAt) })}`
                : ""}
            </p>
          ))}
        </div>
      ) : null}
      <div className="text-muted-foreground">
        {status && status.lastUpdatedAt > 0
          ? t("accounts.updatedAt", { date: date(status.lastUpdatedAt) })
          : t("accounts.neverUpdated")}
      </div>
      {status?.error ? (
        <p className="break-words text-destructive" role="status">
          {status.error}
        </p>
      ) : null}
    </div>
  );
}
