import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconX } from "@tabler/icons-react";
import { listProviderAccounts } from "@/features/providers/api/providerAccounts";
import { providerDisplayName } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import {
  benchmarkApi,
  benchmarkErrorMessage,
  isRefusal,
} from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import {
  EXECUTION_PROFILES,
  executionProfileOf,
  resolveCatchUpConfiguration,
} from "../lib/benchmarkCatchUp";
import { configurationLabel } from "../lib/benchmarkDraft";
import { explicitEfforts, preselectedEffort } from "../lib/benchmarkEffort";
import { plannedTurns, REQUIRED_REPETITIONS } from "../lib/benchmarkPlan";
import { currentVersions } from "../lib/benchmarkReleases";
import { runTimeLimitSeconds } from "../stores/benchmarkSettingsStore";
import type {
  BenchmarkDefinitionSummary,
  Configuration,
  InventoryModel,
  RunRequest,
} from "../types";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  SectionHeading,
  SelectField,
} from "./BenchmarkPrimitives";
import { BenchmarkTestPicker } from "./BenchmarkTestPicker";

/** The effort field's one value for a model without an effort control. */
const NO_EFFORT = "no-effort-setting";

type ModelSelection = {
  configuration: Configuration;
  inventory: InventoryModel[];
};

/** One model choice, with the runtime entries its tests may need. */
function modelChoices(inventory: InventoryModel[]) {
  const grouped = new Map<string, InventoryModel[]>();
  for (const entry of inventory) {
    const config = entry.configuration;
    const key = JSON.stringify([
      config.providerId,
      config.accountId,
      config.modelId,
      config.modelName ?? null,
      config.billingMode,
    ]);
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((entries) => ({
    ...(entries.find(
      (entry) => entry.configuration.executionProfile === "native_text",
    ) ?? entries[0]),
    inventory: entries,
    efforts: [...new Set(entries.flatMap((entry) => entry.efforts))],
    supportsFastMode: entries.some((entry) => entry.supportsFastMode),
    available: entries.some((entry) => entry.available),
  }));
}

export function BenchmarkRunDialog({
  definitions,
  selectedVersionIds = [],
  previewOnly = false,
  onClose,
  onStarted,
}: {
  definitions: BenchmarkDefinitionSummary[];
  selectedVersionIds?: string[];
  previewOnly?: boolean;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const providers = useProviderCatalogStore((state) => state.entries);
  const accounts = useQuery({
    queryKey: ["benchmark-run-accounts"],
    queryFn: listProviderAccounts,
  });
  const capabilities = useQuery({
    queryKey: [...benchmarkKeys, "capabilities"],
    queryFn: benchmarkApi.getCapabilities,
  });
  const [providerId, setProviderId] = useState("");
  const [accountId, setAccountId] = useState("none");
  const [modelIndex, setModelIndex] = useState("none");
  // An explicit level the selected model lists; null until one is chosen,
  // and for a model without an effort control.
  const [effort, setEffort] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState(false);
  const [selected, setVersions] = useState(selectedVersionIds);
  const [savedSelections, setSelections] = useState<ModelSelection[]>([]);
  const [repetitions, setRepetitions] = useState(REQUIRED_REPETITIONS);
  const published = currentVersions(definitions);
  // A publication invalidates an old selection instead of silently running
  // different test content under an already checked plan.
  const chosenVersions = published.filter((version) =>
    selected.includes(version.id),
  );
  const versions = chosenVersions.map((version) => version.id);
  // The run's limit only stops a turn that never ends (Settings).
  const timeoutSeconds = runTimeLimitSeconds(chosenVersions);
  // Follow the selected plan until the operator sets an explicit ceiling.
  const [executionLimit, setMaxExecutions] = useState<number | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  // What the plan check refused, for the settings it checked; a change
  // clears it, and Start checks the plan again.
  const [refusal, setRefusal] = useState<{
    signature: string;
    issues: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renewingPolicy, setRenewingPolicy] = useState(false);
  // Managed accounts, and for a provider whose CLI keeps its own sign-in the
  // fixed identity that names it.
  const managedAccounts = (id: string) =>
    accounts.data?.accounts.filter(
      (entry) =>
        entry.providerId === id && entry.enabled && entry.id !== cliAccount(id),
    ) ?? [];
  const cliAccount = (id: string) =>
    capabilities.data?.find(
      (entry) =>
        entry.providerId === id && entry.executionProfile === "native_text",
    )?.cliAccountId ?? null;
  const providerCliAccount = cliAccount(providerId);
  // A provider whose only sign-in is its CLI's has nothing else to choose,
  // so that sign-in is selected whenever its capability arrives.
  const onlyCliAccount =
    managedAccounts(providerId).length === 0 ? providerCliAccount : null;
  const selectedAccount =
    accountId === "none" ? (onlyCliAccount ?? accountId) : accountId;
  const inventory = useQuery({
    queryKey: [...benchmarkKeys, "inventory", providerId, selectedAccount],
    queryFn: () =>
      benchmarkApi.getInventory(
        providerId,
        selectedAccount === "none" ? null : selectedAccount,
      ),
    // Without capabilities the account a provider signs in with is unknown.
    enabled: Boolean(providerId) && !capabilities.isPending,
    staleTime: 30_000,
  });
  const inventoryFailure = inventory.error
    ? benchmarkErrorMessage(inventory.error)
    : (inventory.data?.find(
        (entry) =>
          !entry.available && entry.reason?.includes("Linux text policy proof"),
      )?.reason ?? null);
  const policyCheckMissing = inventoryFailure?.includes(
    "Linux text policy proof",
  );
  const models = modelChoices(inventory.error ? [] : (inventory.data ?? []));
  const model = models[Number(modelIndex)];
  // The CLI's "default" names no level, so it is never offered: a model that
  // lists levels runs at one of them, and only a model without an effort
  // control runs with the effort unset.
  const modelEfforts = model ? explicitEfforts(model.efforts) : [];
  const effortChosen =
    modelEfforts.length === 0 ||
    (effort !== null && modelEfforts.includes(effort));
  const selectedConfiguration: Configuration | null =
    model?.available && effortChosen
      ? {
          ...model.configuration,
          effort: modelEfforts.length ? effort : null,
          fastMode: model.supportsFastMode ? fastMode : null,
        }
      : null;
  if (selectedConfiguration) {
    selectedConfiguration.id = JSON.stringify([
      selectedConfiguration.providerId,
      selectedConfiguration.accountId,
      selectedConfiguration.modelId,
      selectedConfiguration.modelName ?? null,
      selectedConfiguration.billingMode,
      selectedConfiguration.effort,
      selectedConfiguration.fastMode,
    ]);
  }
  const selection: ModelSelection | null =
    selectedConfiguration && model
      ? { configuration: selectedConfiguration, inventory: model.inventory }
      : null;
  // The visible selection is already part of the plan. Saving it is only
  // necessary when the operator wants to choose another configuration too.
  const selections =
    selection &&
    !savedSelections.some(
      (entry) => entry.configuration.id === selection.configuration.id,
    )
      ? [...savedSelections, selection]
      : savedSelections;
  // Every selected model owes every selected test. Resolve each needed
  // runtime as the model's own Run dialog does; never drop unavailable cases.
  const profiles = EXECUTION_PROFILES.filter((profile) =>
    chosenVersions.some(
      (version) => executionProfileOf(version.manifest) === profile,
    ),
  );
  const configurations: Configuration[] = [];
  let routingIssue: string | null = null;
  for (const entry of selections) {
    for (const executionProfile of profiles) {
      const resolved = resolveCatchUpConfiguration(
        { ...entry.configuration, executionProfile },
        entry.inventory,
      );
      if ("configuration" in resolved) {
        configurations.push(resolved.configuration);
      } else {
        routingIssue ??= t("run.unavailableTests", {
          model: configurationLabel(entry.configuration),
          reason:
            resolved.issue === "unavailable" && resolved.reason
              ? resolved.reason
              : t(
                  resolved.issue === "changed"
                    ? "run.settingsUnavailable"
                    : "run.runtimeUnavailable",
                ),
        });
      }
    }
  }
  const count = selections.length * plannedTurns(chosenVersions) * repetitions;
  const maxExecutions = executionLimit ?? Math.max(1, count);
  const planIssue =
    selections.length === 0
      ? t("run.noConfigurations")
      : versions.length === 0
        ? t("run.noTests")
        : !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100
          ? t("run.invalidRepetitions")
          : routingIssue
            ? routingIssue
            : !Number.isInteger(maxExecutions) || maxExecutions < 1
              ? t("run.invalidLimit")
              : count > maxExecutions
                ? t("run.overBudget", { count, limit: maxExecutions })
                : null;
  const request: RunRequest = {
    requestKey,
    versionIds: versions,
    configurations,
    repetitions,
    timeoutSeconds,
    maxExecutions,
    preview: previewOnly,
  };
  const signature = JSON.stringify(request);
  const refused = refusal?.signature === signature ? refusal.issues : null;
  const supported = new Set(
    capabilities.data
      ?.filter((entry) => entry.supported)
      .map((entry) => entry.providerId) ?? [],
  );
  const providerOptions = [
    ...new Set([
      ...(capabilities.data
        ?.map((entry) => entry.providerId)
        .filter((id) => id !== "*") ?? []),
      ...providers.map((entry) => entry.id),
    ]),
  ].map((id) => ({
    value: id,
    label: supported.has(id)
      ? providerDisplayName(id)
      : t("run.unsupportedProvider", { provider: providerDisplayName(id) }),
  }));
  const operate = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const addConfiguration = () => {
    if (!selection) return;
    setSelections(selections);
    setModelIndex("none");
    setEffort(null);
    setFastMode(false);
  };
  const refreshInventory = async () => {
    const refreshedInventory = await client.fetchQuery({
      queryKey: [...benchmarkKeys, "inventory", providerId, selectedAccount],
      queryFn: () =>
        benchmarkApi.getInventory(
          providerId,
          selectedAccount === "none" ? null : selectedAccount,
          true,
        ),
      staleTime: 0,
    });
    setSelections((previous) =>
      previous.map((entry) =>
        entry.configuration.providerId === providerId &&
        entry.configuration.accountId === selectedAccount
          ? { ...entry, inventory: refreshedInventory }
          : entry,
      ),
    );
  };
  const renewPolicy = () =>
    operate(async () => {
      setRenewingPolicy(true);
      try {
        await benchmarkApi.renewPolicyCheck(providerId);
        await client.invalidateQueries({
          queryKey: [...benchmarkKeys, "inventory", providerId],
          refetchType: "none",
        });
        await refreshInventory();
      } finally {
        setRenewingPolicy(false);
      }
    });
  const budgetField = (
    key: "repetitions" | "maxExecutions",
    value: number,
    set: (value: number) => void,
  ) => (
    <Field key={key} label={t(`fields.${key}`)}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={1}
          disabled={previewOnly && key === "repetitions"}
          value={value}
          onChange={(event) => set(Number(event.target.value))}
        />
      )}
    </Field>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("run.title")}</DialogTitle>
          <DialogDescription>
            {previewOnly ? t("run.preview") : t("run.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          <Card className="gap-3 p-4">
            <SectionHeading title={t("run.configurations")} />
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("fields.provider")}>
                {(id) => (
                  <SelectField
                    id={id}
                    value={providerId || "none"}
                    disabled={busy}
                    onChange={(value) => {
                      setProviderId(value === "none" ? "" : value);
                      setAccountId("none");
                      setModelIndex("none");
                      setEffort(null);
                    }}
                    options={[
                      { value: "none", label: t("run.chooseProvider") },
                      ...providerOptions,
                    ]}
                  />
                )}
              </Field>
              <Field label={t("fields.account")}>
                {(id) => (
                  <SelectField
                    id={id}
                    value={selectedAccount}
                    disabled={busy}
                    onChange={(value) => {
                      setAccountId(value);
                      setModelIndex("none");
                    }}
                    options={[
                      // An inventory without an account is refused; a
                      // provider with only its CLI sign-in never offers it.
                      ...(onlyCliAccount
                        ? []
                        : [{ value: "none", label: t("run.noAccount") }]),
                      ...managedAccounts(providerId).map((entry) => ({
                        value: entry.id,
                        label: entry.label,
                      })),
                      ...(providerCliAccount
                        ? [
                            {
                              value: providerCliAccount,
                              label: t("run.cliLogin"),
                            },
                          ]
                        : []),
                    ]}
                  />
                )}
              </Field>
              {providerId ? (
                <Field label={t("fields.model")}>
                  {(id) => (
                    <SelectField
                      id={id}
                      value={modelIndex}
                      disabled={busy}
                      onChange={(value) => {
                        setModelIndex(value);
                        const chosen = models[Number(value)];
                        setEffort(
                          chosen ? preselectedEffort(chosen.efforts) : null,
                        );
                        setFastMode(false);
                      }}
                      options={[
                        { value: "none", label: t("run.chooseModel") },
                        ...models.map((entry, index) => ({
                          value: String(index),
                          label: entry.name,
                        })),
                      ]}
                    />
                  )}
                </Field>
              ) : null}
              {model ? (
                <Field label={t("fields.effort")}>
                  {(id) => (
                    <SelectField
                      id={id}
                      value={modelEfforts.length ? (effort ?? "") : NO_EFFORT}
                      onChange={(value) =>
                        setEffort(value === NO_EFFORT ? null : value)
                      }
                      options={
                        modelEfforts.length
                          ? modelEfforts.map((value) => ({
                              value,
                              label: value,
                            }))
                          : [{ value: NO_EFFORT, label: t("run.noEffort") }]
                      }
                    />
                  )}
                </Field>
              ) : null}
            </div>
            {providerId && inventory.isPending ? (
              <BenchmarkEmpty title={t("loading")} compact />
            ) : null}
            {inventoryFailure ? (
              <BenchmarkAlert
                tone={
                  policyCheckMissing || isRefusal(inventory.error)
                    ? "warning"
                    : "error"
                }
              >
                <p>
                  {t(
                    policyCheckMissing
                      ? "modelRun.policyCheckMissing"
                      : "modelRun.availabilityFailed",
                  )}
                </p>
                <details>
                  <summary>{t("detail.technical")}</summary>
                  <p>{inventoryFailure}</p>
                </details>
                {policyCheckMissing ? (
                  <p>{t("modelRun.policyCheckHelp")}</p>
                ) : null}
                <Button
                  type="button"
                  variant="alert"
                  size="xs"
                  disabled={inventory.isFetching || busy}
                  onClick={() =>
                    void (policyCheckMissing
                      ? renewPolicy()
                      : operate(refreshInventory))
                  }
                >
                  {t(
                    renewingPolicy
                      ? "modelRun.policyCheckRenewing"
                      : policyCheckMissing
                        ? "modelRun.policyCheckRenew"
                        : inventory.isFetching
                          ? "modelRun.readinessChecking"
                          : "modelRun.readinessRetry",
                  )}
                </Button>
              </BenchmarkAlert>
            ) : null}
            {model && !model.available ? (
              <p className="text-xs text-muted-foreground">
                {model.reason ?? t("states.unsupported")}
              </p>
            ) : null}
            {model ? (
              <div className="flex flex-wrap items-center gap-4">
                {model.supportsFastMode ? (
                  <Label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={fastMode}
                      onCheckedChange={(checked) =>
                        setFastMode(checked === true)
                      }
                    />
                    {t("fields.fastMode")}
                  </Label>
                ) : null}
                {!previewOnly ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!model.available || !effortChosen}
                    onClick={addConfiguration}
                  >
                    {t("run.addConfiguration")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {selections.length === 0 && providerId ? (
              <p className="text-xs text-muted-foreground">
                {t("run.noConfigurations")}
              </p>
            ) : selections.length > 0 ? (
              <ul className="divide-y divide-border">
                {selections.map(({ configuration: entry }) => {
                  return (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-2 py-1.5 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {configurationLabel(entry)}
                      </span>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("actions.remove")}
                        onClick={() => {
                          setSelections((previous) =>
                            previous.filter(
                              (item) => item.configuration.id !== entry.id,
                            ),
                          );
                          if (selection?.configuration.id === entry.id)
                            setModelIndex("none");
                        }}
                      >
                        <IconX />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </Card>
          <Card className="gap-3 p-4">
            <SectionHeading title={t("run.budgetTitle")} />
            <div className="grid grid-cols-2 gap-3">
              {budgetField("repetitions", repetitions, setRepetitions)}
              {budgetField("maxExecutions", maxExecutions, setMaxExecutions)}
            </div>
            <p className="text-sm">{t("run.executionCount", { count })}</p>
            {refused ? (
              <BenchmarkAlert tone="warning">
                {refused.join("\n")}
              </BenchmarkAlert>
            ) : null}
          </Card>
          <Card className="gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <SectionHeading title={t("run.tests")} />
              <span className="text-xs text-muted-foreground">
                {t("modelRun.selected", {
                  selected: chosenVersions.length,
                  total: published.length,
                })}
              </span>
            </div>
            <BenchmarkTestPicker
              versions={published}
              selectedIds={versions}
              disabled={previewOnly || busy}
              onChange={setVersions}
            />
          </Card>
        </DialogBody>
        <DialogFooter>
          {planIssue ? (
            <p
              role="status"
              className="text-xs text-muted-foreground sm:mr-auto"
            >
              {planIssue}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            flush
            className="sm:mr-auto"
            disabled={busy}
            onClick={onClose}
          >
            {t("actions.close")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || count === 0 || planIssue !== null}
            onClick={() =>
              void operate(async () => {
                // The plan is checked first, as on the model's page: a
                // refusal names its reasons and starts nothing.
                const check = await benchmarkApi.previewRun(request);
                if (!check.valid) {
                  setRefusal({ signature, issues: check.issues });
                  return;
                }
                const run = await benchmarkApi.startRun(request);
                await client.invalidateQueries({ queryKey: benchmarkKeys });
                onStarted(run.id);
              })
            }
          >
            {t("run.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
