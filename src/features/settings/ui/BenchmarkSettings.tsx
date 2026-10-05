import { useTranslation } from "react-i18next";

import {
  MAX_TIME_LIMIT_MINUTES,
  useBenchmarkSettingsStore,
} from "@/features/benchmarks/stores/benchmarkSettingsStore";
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
        </SettingsSection>
      </SettingsSections>
    </SettingsPage>
  );
}
