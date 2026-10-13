import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
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
import {
  retryRoutingPolicyHydration,
  useRoutingPolicyStore,
} from "@/features/agents/stores/routingPolicyStore";
import {
  LearnedClassStatus,
  useClassPolicies,
} from "@/features/benchmarks/ui/LearnedClassStatus";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

/** Selection preferences are independent of provider setup and account controls. */
export function ModelSelectionSettings() {
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
  const [expandedClass, setExpandedClass] =
    useState<ModelPreferenceClassId | null>(null);
  const policies = useClassPolicies();
  const classes = modelPreferenceClassIds();
  const certifiedClasses = new Set(
    policies.error
      ? []
      : policies.data
          ?.filter((entry) => entry.certificateId && entry.certifiedAt !== null)
          .map((entry) => entry.workClassId),
  );
  const certifiedCount = classes.filter((id) =>
    certifiedClasses.has(id),
  ).length;
  const summary = policies.isPending
    ? t("routing.evidenceLoading")
    : policies.error
      ? t("routing.evidenceUnavailable")
      : certifiedCount > 0
        ? t("routing.certifiedSummary", {
            count: certifiedCount,
            total: classes.length,
          })
        : t("routing.fallbackSummary");

  return (
    <SettingsPage
      title={t("nav.routing")}
      description={t("routing.pageDescription")}
    >
      <SettingsSections>
        <SettingsSection
          title={t("routing.title")}
          titleId="settings-routing"
          data-testid="settings-routing"
        >
          <div className="space-y-2 py-3">
            <p className="text-sm" role="status">
              {summary}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("routing.selectionDescription")}
            </p>
          </div>
          {hydrationFailed ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs"
              data-testid="routing-not-persisted"
              role="status"
            >
              <span>{t("routing.notPersisted")}</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  void retryRoutingPolicyHydration().finally(() =>
                    setRetrying(false),
                  );
                }}
              >
                {t("routing.retryLoad")}
              </Button>
            </div>
          ) : null}
        </SettingsSection>

        <SettingsSection
          title={t("routing.categories")}
          titleId="routing-categories"
        >
          {classes.map((classId) => {
            const expanded = expandedClass === classId;
            const certified = certifiedClasses.has(classId);
            const override = policy.classOverrides[classId];
            const labels = applyClassOverride(
              MODEL_PREFERENCE_CLASSES[classId].ranking,
              override,
            ).map((candidate) => candidate.label);
            const status = policies.isPending
              ? "loading"
              : policies.error
                ? "unavailable"
                : certified
                  ? "certified"
                  : "fallback";
            return (
              <Collapsible
                key={classId}
                open={expanded}
                onOpenChange={(open) => setExpandedClass(open ? classId : null)}
                data-testid={`routing-category-${classId}`}
              >
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="default"
                    className="my-1 w-full justify-between"
                    aria-label={t(`routing.classes.${classId}`)}
                  >
                    <span className="min-w-0 truncate">
                      {t(`routing.classes.${classId}`)}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {override ? (
                        <span className="hidden text-xs text-muted-foreground sm:inline">
                          {t("routing.custom")}
                        </span>
                      ) : null}
                      {certified ? (
                        <Badge variant="secondary">
                          {t("routing.status.certified")}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t(`routing.status.${status}`)}
                        </span>
                      )}
                      <IconChevronDown
                        className={cn(
                          "size-3.5 transition-transform",
                          expanded && "rotate-180",
                        )}
                        aria-hidden="true"
                      />
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-4 px-3 pb-5 pt-2">
                    <div className="space-y-1">
                      <h3 className="text-sm font-medium">
                        {t("routing.fallbackOrder")}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t("routing.fallbackDescription")}
                      </p>
                    </div>
                    <FallbackOrder
                      labels={labels}
                      onChange={(next) => setClassOverride(classId, next)}
                    />
                    {override ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setClassOverride(classId, null)}
                      >
                        {t("routing.resetClass")}
                      </Button>
                    ) : null}
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">
                        {t("routing.evidenceDetails")}
                      </summary>
                      <LearnedClassStatus classId={classId} className="pt-2" />
                    </details>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </SettingsSection>

        <SettingsSection>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="default"
                className="group w-full justify-between"
              >
                {t("routing.usageLimits")}
                <IconChevronDown
                  className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="py-3 text-xs text-muted-foreground">
                {t("routing.usageDescription")}
              </p>
              <SettingsRow
                label={t("routing.waveThreshold")}
                description={t("routing.waveThresholdDescription")}
              >
                <PercentInput
                  value={policy.waveNearLimitPercent}
                  label={t("routing.waveThreshold")}
                  testId="routing-wave-threshold"
                  onChange={(value) =>
                    setThreshold("waveNearLimitPercent", value)
                  }
                />
              </SettingsRow>
              <SettingsRow
                label={t("routing.chatThreshold")}
                description={t("routing.chatThresholdDescription")}
              >
                <PercentInput
                  value={policy.chatNearLimitPercent}
                  label={t("routing.chatThreshold")}
                  testId="routing-chat-threshold"
                  onChange={(value) =>
                    setThreshold("chatNearLimitPercent", value)
                  }
                />
              </SettingsRow>
            </CollapsibleContent>
          </Collapsible>
        </SettingsSection>
        {isDefaultRoutingPolicy(policy) ? null : (
          <Button type="button" variant="ghost" size="xs" onClick={resetPolicy}>
            {t("routing.reset")}
          </Button>
        )}
      </SettingsSections>
    </SettingsPage>
  );
}

function PercentInput({
  value,
  label,
  testId,
  onChange,
}: {
  value: number;
  label: string;
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
        aria-label={label}
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

function FallbackOrder({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
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
    <div className="max-w-sm space-y-2">
      <ol className="space-y-1">
        {labels.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span className="w-4 text-xs tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
            <div className="flex items-center gap-1">
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
                disabled={labels.length === 1}
                onClick={() =>
                  onChange(labels.filter((entry) => entry !== label))
                }
              >
                <IconX aria-hidden="true" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {unused.length > 0 ? (
        <Select
          value=""
          onValueChange={(label) => onChange([...labels, label])}
        >
          <SelectTrigger
            size="sm"
            className="w-full"
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
  );
}
