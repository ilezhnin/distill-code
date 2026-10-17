import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { benchmarkApi } from "@/features/benchmarks/api/benchmarks";
import {
  MAX_TIME_LIMIT_MINUTES,
  useBenchmarkSettingsStore,
} from "@/features/benchmarks/stores/benchmarkSettingsStore";
import { useLocaleFormatting } from "@/shared/i18n";
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
