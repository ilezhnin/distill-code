import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowDown,
  IconArrowUp,
  IconPlus,
  IconX,
} from "@tabler/icons-react";

import {
  KNOWN_MODEL_CANDIDATES,
  MODEL_PREFERENCE_CLASSES,
  applyClassOverride,
  modelPreferenceClassIds,
  type ModelPreferenceClassId,
} from "@/features/agents/lib/modelRanking";
import { isDefaultRoutingPolicy } from "@/features/agents/lib/routingPolicy";
import { LearnedClassStatus } from "@/features/benchmarks/ui/LearnedClassStatus";
import {
  retryRoutingPolicyHydration,
  useRoutingPolicyStore,
} from "@/features/agents/stores/routingPolicyStore";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SettingsRow } from "@/shared/ui/settings-row";
import { SettingsSection } from "@/shared/ui/settings-section";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

/** Automatic task selection status, with explicitly secondary fallback controls. */
export function RoutingPolicySection() {
  const { t } = useTranslation("settings");
  const policy = useRoutingPolicyStore((state) => state.policy);
  const setThreshold = useRoutingPolicyStore((state) => state.setThreshold);
  const setClassOverride = useRoutingPolicyStore(
    (state) => state.setClassOverride,
  );
  const resetPolicy = useRoutingPolicyStore((state) => state.resetPolicy);
  const hydrationFailed = useRoutingPolicyStore(
    (state) => state.hydrationFailed,
  );
  const [retrying, setRetrying] = useState(false);

  const retryHydration = () => {
    setRetrying(true);
    void retryRoutingPolicyHydration().finally(() => {
      setRetrying(false);
    });
  };

  return (
    <SettingsSection
      title={t("routing.title")}
      titleId="settings-routing"
      data-testid="settings-routing"
    >
      {hydrationFailed ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground"
          data-testid="routing-not-persisted"
          role="status"
        >
          <span>{t("routing.notPersisted")}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={retrying}
            data-testid="routing-retry-hydration"
            onClick={retryHydration}
          >
            {t("routing.retryLoad")}
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("routing.classesDescription")}
      </p>
      {modelPreferenceClassIds().map((classId) => (
        <SettingsRow
          key={classId}
          label={t(`routing.classes.${classId}`)}
          description={<LearnedClassStatus classId={classId} />}
        />
      ))}
      <details className="space-y-3" data-testid="routing-fallback-controls">
        <summary className="cursor-pointer text-sm">
          {t("routing.fallbackControls")}
        </summary>
        <p className="text-xs text-muted-foreground">
          {t("routing.fallbackDescription")}
        </p>
        <SettingsRow
          label={t("routing.waveThreshold")}
          description={t("routing.waveThresholdDescription")}
          action={
            <PercentInput
              value={policy.waveNearLimitPercent}
              testId="routing-wave-threshold"
              onChange={(percent) =>
                setThreshold("waveNearLimitPercent", percent)
              }
            />
          }
        />
        <SettingsRow
          label={t("routing.chatThreshold")}
          description={t("routing.chatThresholdDescription")}
          action={
            <PercentInput
              value={policy.chatNearLimitPercent}
              testId="routing-chat-threshold"
              onChange={(percent) =>
                setThreshold("chatNearLimitPercent", percent)
              }
            />
          }
        />
        {modelPreferenceClassIds().map((classId) => (
          <ClassRankingRow
            key={classId}
            classId={classId}
            labels={effectiveLabels(classId, policy.classOverrides[classId])}
            overridden={Boolean(policy.classOverrides[classId])}
            onChange={(labels) => setClassOverride(classId, labels)}
          />
        ))}
        {isDefaultRoutingPolicy(policy) ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="routing-reset"
            onClick={resetPolicy}
          >
            {t("routing.reset")}
          </Button>
        )}
      </details>
    </SettingsSection>
  );
}

/** Saved fallback preferences, kept separate from automatic candidates. */
function effectiveLabels(
  classId: ModelPreferenceClassId,
  override: string[] | undefined,
): string[] {
  return applyClassOverride(
    MODEL_PREFERENCE_CLASSES[classId].ranking,
    override,
  ).map((candidate) => candidate.label);
}

function PercentInput({
  value,
  testId,
  onChange,
}: {
  value: number;
  testId: string;
  onChange: (percent: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        min={50}
        max={100}
        value={value}
        data-testid={testId}
        className="h-8 w-20 text-right tabular-nums"
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      <span className="text-xs text-muted-foreground">%</span>
    </div>
  );
}

function ClassRankingRow({
  classId,
  labels,
  overridden,
  onChange,
}: {
  classId: ModelPreferenceClassId;
  labels: string[];
  overridden: boolean;
  onChange: (labels: string[] | null) => void;
}) {
  const { t } = useTranslation("settings");
  const unused = KNOWN_MODEL_CANDIDATES.filter(
    (candidate) => !labels.includes(candidate.label),
  );

  const move = (index: number, delta: number) => {
    const next = [...labels];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <SettingsRow
      layout="stacked"
      align="start"
      label={t(`routing.classes.${classId}`)}
      data-testid="routing-class-row"
      data-class-id={classId}
      description={
        overridden ? <span>{t("routing.classOverridden")}</span> : null
      }
      action={
        <div className="flex min-w-0 flex-col gap-1">
          {labels.map((label, index) => (
            <div key={label} className="flex items-center gap-1">
              <span
                className={cn(
                  "min-w-32 text-xs",
                  index === 0 ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {index + 1}. {label}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xxs"
                aria-label={t("routing.moveUp", { label })}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <IconArrowUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xxs"
                aria-label={t("routing.moveDown", { label })}
                disabled={index === labels.length - 1}
                onClick={() => move(index, 1)}
              >
                <IconArrowDown aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xxs"
                aria-label={t("routing.remove", { label })}
                // The last one may not be removed: a class with no candidates
                // resolves to nothing and silently stops routing, which looks
                // exactly like the feature being broken.
                disabled={labels.length === 1}
                onClick={() =>
                  onChange(labels.filter((entry) => entry !== label))
                }
              >
                <IconX aria-hidden="true" />
              </Button>
            </div>
          ))}
          {unused.length > 0 ? (
            <Select
              value=""
              onValueChange={(label) => onChange([...labels, label])}
            >
              <SelectTrigger
                size="sm"
                className="h-7 w-44 text-xs"
                aria-label={t("routing.add")}
              >
                <IconPlus className="size-3" aria-hidden="true" />
                <SelectValue placeholder={t("routing.add")} />
              </SelectTrigger>
              <SelectContent>
                {unused.map((candidate) => (
                  <SelectItem key={candidate.label} value={candidate.label}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      }
    />
  );
}
