import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { accountUsageFor } from "@/features/status/lib/accountUsage";
import { getUsageSections } from "@/features/status/lib/rateLimitWindows";
import { UsageLimits } from "@/features/status/ui/UsageLimits";
import type { ProviderRateLimits } from "@/features/status/lib/rateLimitTypes";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import type {
  ProviderAccount,
  ProviderAccountResetCredit,
  ProviderAccountStatus,
} from "../api/providerAccounts";
import {
  accountStatusIsStale,
  canUseAccountReset,
  resetCreditIsAvailable,
} from "../lib/providerAccountStatus";

export function ProviderAccountDetails({
  account,
  status,
  now,
  onUseReset,
  resetDisabled = false,
}: {
  account: ProviderAccount;
  status: ProviderAccountStatus | undefined;
  now: number;
  onUseReset?: (credit: ProviderAccountResetCredit, label: string) => void;
  resetDisabled?: boolean;
}) {
  const usage = accountUsageFor(account, status);
  return (
    <ProviderUsageDetails
      usage={usage}
      now={now}
      state={status?.state}
      stale={status ? accountStatusIsStale(status, now) : false}
      resetTokens={status?.resetTokens}
      onUseReset={canUseAccountReset(status, now) ? onUseReset : undefined}
      resetDisabled={resetDisabled}
    />
  );
}

/** One presentation for every provider; adapters own provider-specific data. */
export function ProviderUsageDetails({
  usage,
  now,
  state = usage.accountLimited
    ? "limited"
    : usage.status === "error"
      ? "error"
      : usage.status === "ok"
        ? "ready"
        : "unknown",
  stale = usage.status === "error",
  resetTokens,
  onUseReset,
  resetDisabled = false,
}: {
  usage: ProviderRateLimits;
  now: number;
  state?: ProviderAccountStatus["state"];
  stale?: boolean;
  resetTokens?: ProviderAccountStatus["resetTokens"];
  onUseReset?: (credit: ProviderAccountResetCredit, label: string) => void;
  resetDisabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { formatDate, formatNumber } = useLocaleFormatting();
  const hasResetCredits = Boolean(resetTokens?.credits?.length);
  const usagePaused = usage.usageRetryAt != null;
  const retrySeconds = Math.max(
    0,
    Math.ceil(((usage.usageRetryAt ?? now) - now) / 1000),
  );
  const date = (value: number) =>
    formatDate(value, { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {state !== "ready" ? (
          <Badge
            variant={
              state === "limited" ||
              (state === "error" && !usagePaused) ||
              state === "needs_auth"
                ? "destructive"
                : "secondary"
            }
          >
            {usagePaused && state === "error"
              ? t("accounts.usagePaused")
              : t(`accounts.states.${state}`)}
          </Badge>
        ) : null}
        <span className="text-muted-foreground">
          {t("accounts.subscription", {
            value: usage.planType ?? t("accounts.notReported"),
          })}
        </span>
        {stale ? <Badge variant="outline">{t("accounts.stale")}</Badge> : null}
      </div>
      {getUsageSections(usage).length ? (
        <UsageLimits provider={usage} now={now} />
      ) : (
        <p className="text-muted-foreground">{t("accounts.limitsUnknown")}</p>
      )}
      {!hasResetCredits && resetTokens ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          <span>
            {t("accounts.resetTokens", {
              value: formatNumber(resetTokens.available),
            })}
          </span>
          {resetTokens.expiresAt ? (
            <span>
              {t("accounts.expiresAt", {
                date: date(resetTokens.expiresAt),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      {usage.credits?.map((credit) => {
        const amount = (raw: string | null) => {
          const numeric = raw?.trim() ? Number(raw) : NaN;
          if (!Number.isFinite(numeric)) return t("accounts.notReported");
          const currency = credit.currency?.match(/^[A-Z]{3}$/)?.[0];
          return formatNumber(
            numeric,
            currency
              ? { style: "currency", currency }
              : { maximumFractionDigits: 0 },
          );
        };
        const balance = credit.unlimited
          ? t("accounts.unlimited")
          : amount(credit.balance);
        const label = t(`accounts.creditLabels.${credit.id}`, {
          defaultValue: credit.label,
        });
        return (
          <div key={credit.id} className="space-y-1 text-muted-foreground">
            <p>
              {t("accounts.creditBalance", {
                label,
                value:
                  credit.total == null || credit.unlimited
                    ? balance
                    : t("accounts.creditRemaining", {
                        balance,
                        total: amount(credit.total),
                      }),
              })}
            </p>
            {credit.expiresAt ? (
              <p>{t("accounts.expiresAt", { date: date(credit.expiresAt) })}</p>
            ) : null}
          </div>
        );
      })}
      {resetTokens?.credits?.length ? (
        <div className="space-y-1 text-muted-foreground">
          {resetTokens.credits.map((credit) => {
            const label = t(`accounts.resetTypes.${credit.resetType}`, {
              defaultValue: credit.title ?? credit.resetType,
            });
            return (
              <div
                key={credit.id}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <p title={credit.description ?? undefined}>
                  {label}
                  {credit.status !== "available"
                    ? ` · ${t(`accounts.resetStates.${credit.status}`, {
                        defaultValue: credit.status,
                      })}`
                    : ""}
                  {credit.expiresAt
                    ? ` · ${t("accounts.expiresAt", { date: date(credit.expiresAt) })}`
                    : ""}
                </p>
                {onUseReset && resetCreditIsAvailable(credit, now) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={resetDisabled}
                    aria-label={t("accounts.useNamedReset", { name: label })}
                    onClick={() => onUseReset(credit, label)}
                  >
                    {t("accounts.use")}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {usagePaused ? (
        <p className="text-muted-foreground" role="status">
          {retrySeconds > 0
            ? t("accounts.usageRetryIn", {
                minutes: Math.floor(retrySeconds / 60),
                seconds: String(retrySeconds % 60).padStart(2, "0"),
              })
            : t("accounts.usageRetryPending")}
        </p>
      ) : usage.error ? (
        <p className="break-words text-destructive" role="status">
          {usage.error}
        </p>
      ) : null}
    </div>
  );
}
