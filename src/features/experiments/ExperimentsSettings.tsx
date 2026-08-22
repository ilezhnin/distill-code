import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  EXPERIMENT_DEFINITIONS,
  type ExperimentDefinition,
} from "./experimentDefinitions";
import { ExperimentConfigControls } from "./ExperimentConfigControls";
import {
  clearExperimentEnabledOverride,
  getVisibleExperimentRegistry,
  setExperimentEnabled,
  useExperimentList,
  type ExperimentRegistry,
} from "./experimentPreferences";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { Switch } from "@/shared/ui/switch";

interface ExperimentsSettingsProps {
  registry?: ExperimentRegistry;
}

interface RenderExperimentControlsOptions {
  configDisabled?: boolean;
  showDefaultLabel?: boolean;
  showExperimentToggle?: boolean;
  showResetToAuto?: boolean;
  toggleDisabled?: boolean;
}

export function ExperimentsSettings({
  registry = EXPERIMENT_DEFINITIONS,
}: ExperimentsSettingsProps) {
  const { t } = useTranslation("settings");
  const visibleRegistry = useMemo(
    () =>
      getVisibleExperimentRegistry(registry).filter(
        (definition) =>
          definition.settingsVisibility !== "dev" || import.meta.env.DEV,
      ),
    [registry],
  );
  const experiments = useExperimentList(visibleRegistry);
  const experimentsById = useMemo(
    () => new Map(experiments.map((experiment) => [experiment.id, experiment])),
    [experiments],
  );
  const handleExperimentEnabledChange = (
    definition: ExperimentDefinition,
    enabled: boolean,
  ) => {
    const didSave = setExperimentEnabled(definition.id, enabled, registry);

    if (!didSave) {
      toast.error(t("experiments.saveError"));
    }
  };

  const renderExperimentControls = (
    definition: ExperimentDefinition,
    rowClassName = "",
    {
      configDisabled,
      showDefaultLabel = false,
      showExperimentToggle = true,
      showResetToAuto = true,
      toggleDisabled = false,
    }: RenderExperimentControlsOptions = {},
  ) => {
    const experiment = experimentsById.get(definition.id);
    if (!experiment) return null;

    const titleId = `experiment-${definition.id}-title`;
    const descriptionId = `experiment-${definition.id}-description`;

    return (
      <div key={definition.id} className={rowClassName}>
        <SettingsRow
          labelId={titleId}
          descriptionId={descriptionId}
          label={
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">{t(definition.titleKey)}</span>
              {showDefaultLabel ? (
                <Badge
                  variant="secondary"
                  className="h-5 px-1.5 text-[11px] font-normal"
                  aria-hidden="true"
                >
                  {t("experiments.defaultLabel")}
                </Badge>
              ) : null}
            </span>
          }
          description={t(definition.descriptionKey)}
          action={
            showExperimentToggle ||
            (showResetToAuto && experiment.enabledSource === "explicit") ? (
              <div className="flex shrink-0 items-center gap-2">
                {showResetToAuto && experiment.enabledSource === "explicit" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const didSave = clearExperimentEnabledOverride(
                        definition.id,
                        registry,
                      );
                      if (!didSave) {
                        toast.error(t("experiments.saveError"));
                      }
                    }}
                    aria-label={t("experiments.resetToAuto")}
                  >
                    {t("experiments.resetToAuto")}
                  </Button>
                ) : null}
                {showExperimentToggle ? (
                  <Switch
                    checked={experiment.enabled}
                    disabled={toggleDisabled}
                    onCheckedChange={(enabled) => {
                      handleExperimentEnabledChange(definition, enabled);
                    }}
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                  />
                ) : null}
              </div>
            ) : undefined
          }
        />
        <ExperimentConfigControls
          definition={definition}
          experiment={experiment}
          registry={registry}
          disabled={configDisabled ?? !experiment.enabled}
        />
      </div>
    );
  };

  return (
    <SettingsPage
      title={t("experiments.title")}
      description={
        <>
          {t("experiments.description")}
          {import.meta.env.DEV ? (
            <span className="mt-1 block">
              {t("experiments.autoEnable.description")}
            </span>
          ) : null}
        </>
      }
    >
      {visibleRegistry.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("experiments.emptyDescription")}
        </p>
      ) : (
        <SettingsSections>
          <SettingsSection>
            {visibleRegistry.map((definition) => (
              <section
                key={definition.id}
                className="border-b border-border last:border-b-0"
              >
                {renderExperimentControls(definition)}
              </section>
            ))}
          </SettingsSection>
        </SettingsSections>
      )}
    </SettingsPage>
  );
}
