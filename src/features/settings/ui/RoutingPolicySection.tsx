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
import { useRoutingPolicyStore } from "@/features/agents/stores/routingPolicyStore";
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

/**
 * How work is routed when a platform is running low, and which models each
 * class of work prefers (P36-P38).
 *
 * Both were constants in the source, and both are the operator's call. The
 * thresholds decide when a weekly allowance stops being spent on work that
 * did not need it; the class map is the "hard work here, light work there"
 * arrangement they described, editable without touching a single agent.
 *
 * Deliberately in AI providers rather than a section of its own: this is
 * about which provider gets the work, which is the question this page already
 * answers.
 */
export function RoutingPolicySection() {
  const { t } = useTranslation("settings");
  const policy = useRoutingPolicyStore((state) => state.policy);
  const setThreshold = useRoutingPolicyStore((state) => state.setThreshold);
  const setClassOverride = useRoutingPolicyStore(
    (state) => state.setClassOverride,
  );
  const resetPolicy = useRoutingPolicyStore((state) => state.resetPolicy);

  return (
    <SettingsSection
      title={t("routing.title")}
      titleId="settings-routing"
      data-testid="settings-routing"
    >
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
      <p className="text-xs text-muted-foreground">
        {t("routing.classesDescription")}
      </p>
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
    </SettingsSection>
  );
}

/** The order in force for a class: the operator's, or the shipped one. */
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
      description={overridden ? t("routing.classOverridden") : undefined}
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
