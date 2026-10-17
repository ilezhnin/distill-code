import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  benchmarkApi,
  benchmarkErrorMessage,
} from "@/features/benchmarks/api/benchmarks";
import {
  MAX_TIME_LIMIT_MINUTES,
  useBenchmarkSettingsStore,
} from "@/features/benchmarks/stores/benchmarkSettingsStore";
import type { ProviderAccount } from "@/features/providers/api/providerAccounts";
import {
  startProviderAccountsMonitor,
  useProviderAccountsStore,
} from "@/features/providers/stores/providerAccountsStore";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";

/** Settings every benchmark run shares, kept out of the run dialogs. */
export function BenchmarkSettings() {
  const { t } = useTranslation("settings");
  const minutes = useBenchmarkSettingsStore(
    (state) => state.settings.timeLimitMinutes,
  );
  const setMinutes = useBenchmarkSettingsStore(
    (state) => state.setTimeLimitMinutes,
  );
  return (
    <SettingsPage
      title={t("benchmarks.title")}
      description={t("benchmarks.description")}
      contentClassName="space-y-8"
    >
      <SettingsSections>
        <SettingsSection>
          <SettingsRow
            label={t("benchmarks.timeLimit.label")}
            description={t("benchmarks.timeLimit.description")}
          >
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                max={MAX_TIME_LIMIT_MINUTES}
                value={minutes}
                aria-label={t("benchmarks.timeLimit.label")}
                className="h-8 w-24 text-right tabular-nums"
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  if (Number.isFinite(next)) setMinutes(next);
                }}
              />
              <span className="text-xs text-muted-foreground">
                {t("benchmarks.timeLimit.unit")}
              </span>
            </div>
          </SettingsRow>
          <CreditLimitRow />
        </SettingsSection>
        <ZaiSandboxKeys />
      </SettingsSections>
    </SettingsPage>
  );
}

/**
 * The credits tests may spend once plan usage is spent, and what they spent:
 * the backend measures it from the accounts' balances.
 */
function CreditLimitRow() {
  const { t } = useTranslation("settings");
  const { formatNumber } = useLocaleFormatting();
  const limit = useBenchmarkSettingsStore(
    (state) => state.settings.creditLimit,
  );
  const setLimit = useBenchmarkSettingsStore((state) => state.setCreditLimit);
  const [spent, setSpent] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    benchmarkApi
      .getCreditSpend()
      .then((spend) => {
        if (current) setSpent(spend.spent);
      })
      .catch(() => {
        if (current) setSpent(null);
      });
    return () => {
      current = false;
    };
  }, []);
  const amount = (value: number) =>
    formatNumber(value, { maximumFractionDigits: 2 });
  return (
    <SettingsRow
      label={t("benchmarks.creditLimit.label")}
      description={t("benchmarks.creditLimit.description")}
    >
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            step={1}
            value={limit ?? ""}
            placeholder={t("benchmarks.creditLimit.placeholder")}
            aria-label={t("benchmarks.creditLimit.label")}
            className="h-8 w-28 text-right tabular-nums"
            onChange={(event) => {
              const text = event.target.value.trim();
              if (!text) {
                setLimit(null);
                return;
              }
              const next = Number(text);
              if (Number.isFinite(next) && next >= 0) setLimit(next);
            }}
          />
          <span className="text-xs text-muted-foreground">
            {t("benchmarks.creditLimit.unit")}
          </span>
        </div>
        {spent === null ? (
          <p className="text-xs text-destructive" role="status">
            {t("benchmarks.creditLimit.unavailable")}
          </p>
        ) : spent !== undefined ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {limit === null
              ? t("benchmarks.creditLimit.spent", { spent: amount(spent) })
              : t("benchmarks.creditLimit.spentOfLimit", {
                  spent: amount(spent),
                  limit: amount(limit),
                })}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

const ZAI_PROVIDER_ID = "zai-acp";

/**
 * Z.ai tests run in the benchmark sandbox, which keeps its own copy of each
 * Coding Plan account's key; this copies it there without a script.
 */
function ZaiSandboxKeys() {
  const { t } = useTranslation("settings");
  const loaded = useProviderAccountsStore((state) => state.loaded);
  const accounts = useProviderAccountsStore((state) => state.accounts).filter(
    (account) => account.providerId === ZAI_PROVIDER_ID,
  );
  useEffect(() => {
    startProviderAccountsMonitor();
  }, []);
  if (!loaded) return null;
  return (
    <SettingsSection title={t("benchmarks.sandboxKeys.title")}>
      {accounts.length === 0 ? (
        <SettingsRow
          label={t("benchmarks.sandboxKeys.none")}
          description={t("benchmarks.sandboxKeys.noneDescription")}
        />
      ) : (
        accounts.map((account) => (
          <SandboxKeyRow key={account.id} account={account} />
        ))
      )}
    </SettingsSection>
  );
}

type CopyResult =
  | { state: "idle" | "copying" | "done" }
  | { state: "error"; message: string };

function SandboxKeyRow({ account }: { account: ProviderAccount }) {
  const { t } = useTranslation("settings");
  const [result, setResult] = useState<CopyResult>({ state: "idle" });
  const copy = async () => {
    setResult({ state: "copying" });
    try {
      await benchmarkApi.copyKeyToSandbox(account.providerId, account.id);
      setResult({ state: "done" });
    } catch (error) {
      setResult({ state: "error", message: benchmarkErrorMessage(error) });
    }
  };
  return (
    <SettingsRow
      label={account.label}
      description={t("benchmarks.sandboxKeys.description")}
      align="start"
      action={({ labelId }) => (
        <div className="flex max-w-80 flex-col items-end gap-1">
          <Button
            type="button"
            variant="subtle"
            size="xs"
            aria-describedby={labelId}
            feedbackState={result.state === "copying" ? "loading" : "idle"}
            loadingLabel={t("benchmarks.sandboxKeys.copying")}
            onClick={() => void copy()}
          >
            {t("benchmarks.sandboxKeys.copy")}
          </Button>
          {result.state === "done" ? (
            <p
              className="text-right text-xs text-muted-foreground"
              role="status"
            >
              {t("benchmarks.sandboxKeys.done")}
            </p>
          ) : result.state === "error" ? (
            <p className="text-right text-xs text-destructive" role="alert">
              {t("benchmarks.sandboxKeys.failed", { message: result.message })}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}
