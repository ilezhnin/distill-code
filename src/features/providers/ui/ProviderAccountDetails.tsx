import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { accountUsageFor } from "@/features/status/lib/accountUsage";
import { getUsageSections } from "@/features/status/lib/rateLimitWindows";
import { UsageLimits } from "@/features/status/ui/UsageLimits";
import type { ProviderRateLimits } from "@/features/status/lib/rateLimitTypes";
import { Badge } from "@/shared/ui/badge";
import type {
  ProviderAccount,
  ProviderAccountStatus,
} from "../api/providerAccounts";
import { accountStatusIsStale } from "../lib/providerAccountStatus";
import {
  canUseAccountReset,
  resetTokenRows,
  type ResetTokenRow,
} from "../lib/resetTokens";
import { ResetTokenList } from "./ResetTokenList";

export function ProviderAccountDetails({
  account,
  status,
  state = status?.state,
  now,
  onUseReset,
  resetDisabled = false,
}: {
  account: ProviderAccount;
  status: ProviderAccountStatus | undefined;
  /**
   * The account's state when the harness's own probe knows more than the
   * status adapter: a CLI sign-in with no usage source is judged by the
   * doctor report.
   */
  state?: ProviderAccountStatus["state"];
  now: number;
  onUseReset?: (row: ResetTokenRow) => void;
  resetDisabled?: boolean;
}) {
  const usage = accountUsageFor(account, status);
  return (
    <ProviderUsageDetails
      usage={usage}
      now={now}
      state={state}
      stale={status ? accountStatusIsStale(status, now) : false}
      resetTokens={resetTokenRows(status, now)}
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
  resetTokens?: ResetTokenRow[];
  onUseReset?: (row: ResetTokenRow) => void;
  resetDisabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { formatDate, formatNumber } = useLocaleFormatting();
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
            {usage.refused
              ? t("accounts.refused")
              : usagePaused && state === "error"
                ? t("accounts.usagePaused")
                : t(`accounts.states.${state}`)}
          </Badge>
        ) : null}
        <span className="text-muted-foreground">
          {t("accounts.subscription", {
            value: usage.planType ?? t("accounts.notReported"),
          })}
        </span>
        {usage.onCredits ? (
          <Badge variant="secondary">{t("accounts.onCredits")}</Badge>
        ) : null}
        {stale ? <Badge variant="outline">{t("accounts.stale")}</Badge> : null}
      </div>
      {getUsageSections(usage).length ? (
        <UsageLimits provider={usage} now={now} />
      ) : (
        <p className="text-muted-foreground">{t("accounts.limitsUnknown")}</p>
      )}
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
      {resetTokens?.length ? (
        <ResetTokenList
          rows={resetTokens}
          onUse={onUseReset}
          disabled={resetDisabled}
        />
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
