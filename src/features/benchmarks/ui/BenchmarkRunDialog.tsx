import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconX } from "@tabler/icons-react";
import { listProviderAccounts } from "@/features/providers/api/providerAccounts";
import { providerDisplayName } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { Button } from "@/shared/ui/button";
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
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { shortId } from "../lib/benchmarkLabels";
import type {
  BenchmarkDefinition,
  Configuration,
  RunPreview,
  RunRequest,
} from "../types";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  SectionHeading,
  SelectField,
} from "./BenchmarkPrimitives";

export function BenchmarkRunDialog({
  definitions,
  selectedVersionIds = [],
  previewOnly = false,
  onClose,
  onStarted,
}: {
  definitions: BenchmarkDefinition[];
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
  const [effort, setEffort] = useState("none");
  const [fastMode, setFastMode] = useState(false);
  const [versions, setVersions] = useState(selectedVersionIds);
  const [configurations, setConfigurations] = useState<Configuration[]>([]);
  const [repetitions, setRepetitions] = useState(1);
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [maxExecutions, setMaxExecutions] = useState(20);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<{
    signature: string;
    result: RunPreview;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inventory = useQuery({
    queryKey: [...benchmarkKeys, "inventory", providerId, accountId],
    queryFn: () =>
      benchmarkApi.getInventory(
        providerId,
        accountId === "none" ? null : accountId,
      ),
    enabled: Boolean(providerId),
    staleTime: 30_000,
  });
  const model = inventory.data?.[Number(modelIndex)];
  const request: RunRequest = useMemo(
    () => ({
      requestKey,
      versionIds: versions,
      configurations,
      repetitions,
      timeoutSeconds,
      maxExecutions,
      preview: previewOnly,
    }),
    [
      requestKey,
      versions,
      configurations,
      repetitions,
      timeoutSeconds,
      maxExecutions,
      previewOnly,
    ],
  );
  const signature = JSON.stringify(request);
  const validPreview = preview?.signature === signature ? preview.result : null;
  const published = definitions.filter(
    (entry) => !entry.archived && entry.versions.length > 0,
  );
  const caseTurns = published
    .flatMap((definition) => definition.versions)
    .filter((version) => versions.includes(version.id))
    .reduce(
      (total, version) =>
        total + (version.manifest.workflow?.steps.length ?? 1),
      0,
    );
  const count = caseTurns * configurations.length * repetitions;
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
  const providerReasons =
    capabilities.data?.filter((entry) => entry.providerId === providerId) ?? [];
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
    if (!model) return;
    const config: Configuration = {
      ...model.configuration,
      effort: effort === "none" ? null : effort,
      fastMode: model.supportsFastMode ? fastMode : null,
    };
    config.id = [
      config.providerId,
      config.accountId ?? "",
      config.modelId,
      config.effort ?? "",
      config.fastMode ?? "",
    ].join(":");
    setConfigurations((previous) =>
      previewOnly
        ? [config]
        : previous.some((entry) => entry.id === config.id)
          ? previous
          : [...previous, config],
    );
  };
  const budgetField = (
    key: "repetitions" | "timeoutSeconds" | "maxExecutions",
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
        <DialogBody className="space-y-6">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          <fieldset className="space-y-2">
            <legend className="mb-2">
              <SectionHeading title={t("run.tests")} />
            </legend>
            {published.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("run.noPublished")}
              </p>
            ) : null}
            {published.flatMap((definition) =>
              definition.versions.map((version) => (
                <Label
                  key={version.id}
                  className="flex items-center gap-2 py-1 text-sm"
                >
                  <Checkbox
                    disabled={previewOnly}
                    checked={versions.includes(version.id)}
                    onCheckedChange={(checked) =>
                      setVersions((previous) =>
                        checked
                          ? [...previous, version.id]
                          : previous.filter((id) => id !== version.id),
                      )
                    }
                  />
                  <span className="min-w-0 truncate">
                    {version.manifest.name}
                  </span>
                  <code className="text-xs text-muted-foreground">
                    {shortId(version.contentHash)}
                  </code>
                </Label>
              )),
            )}
          </fieldset>
          <section className="space-y-3">
            <SectionHeading title={t("run.configurations")} />
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("fields.provider")}>
                {(id) => (
                  <SelectField
                    id={id}
                    value={providerId || "none"}
                    onChange={(value) => {
                      setProviderId(value === "none" ? "" : value);
                      setAccountId("none");
                      setModelIndex("none");
                      setEffort("none");
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
                    value={accountId}
                    onChange={(value) => {
                      setAccountId(value);
                      setModelIndex("none");
                    }}
                    options={[
                      { value: "none", label: t("run.noAccount") },
                      ...(accounts.data?.accounts
                        .filter(
                          (entry) =>
                            entry.providerId === providerId && entry.enabled,
                        )
                        .map((entry) => ({
                          value: entry.id,
                          label: entry.label,
                        })) ?? []),
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
                      onChange={(value) => {
                        setModelIndex(value);
                        setEffort("none");
                        setFastMode(false);
                      }}
                      options={[
                        { value: "none", label: t("run.chooseModel") },
                        ...(inventory.data?.map((entry, index) => ({
                          value: String(index),
                          label: entry.name,
                        })) ?? []),
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
                      value={effort}
                      onChange={setEffort}
                      options={[
                        {
                          value: "none",
                          label: model.efforts.length
                            ? t("run.defaultEffort")
                            : t("run.noEffort"),
                        },
                        ...model.efforts.map((value) => ({
                          value,
                          label: value,
                        })),
                      ]}
                    />
                  )}
                </Field>
              ) : null}
            </div>
            {providerId && inventory.isPending ? (
              <BenchmarkEmpty title={t("loading")} compact />
            ) : null}
            {inventory.error ? (
              <BenchmarkAlert>
                {benchmarkErrorMessage(inventory.error)}
              </BenchmarkAlert>
            ) : null}
            {providerReasons.map((entry) => (
              <p
                key={entry.executionProfile}
                className="text-xs text-muted-foreground"
              >
                {t(`profiles.${entry.executionProfile}`, {
                  defaultValue: entry.executionProfile,
                })}
                : {entry.reason}
              </p>
            ))}
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!model.available}
                  onClick={addConfiguration}
                >
                  {t("run.addConfiguration")}
                </Button>
              </div>
            ) : null}
            {configurations.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("run.noConfigurations")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {configurations.map((entry) => (
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
                      onClick={() =>
                        setConfigurations((previous) =>
                          previous.filter((config) => config.id !== entry.id),
                        )
                      }
                    >
                      <IconX />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-3">
            <SectionHeading title={t("run.budgetTitle")} />
            <div className="grid gap-3 md:grid-cols-3">
              {budgetField("repetitions", repetitions, setRepetitions)}
              {budgetField("timeoutSeconds", timeoutSeconds, setTimeoutSeconds)}
              {budgetField("maxExecutions", maxExecutions, setMaxExecutions)}
            </div>
            <p className="text-sm">
              <span>{t("run.executionCount", { count })}</span>
              {" · "}
              <span className="text-muted-foreground">
                {t("run.estimatedCost", {
                  value:
                    validPreview?.estimatedCost == null
                      ? t("unknown")
                      : validPreview.estimatedCost.toFixed(4),
                })}
              </span>
            </p>
            {validPreview?.costReason ? (
              <p className="text-xs text-muted-foreground">
                {validPreview.costReason}
              </p>
            ) : null}
            {validPreview && !validPreview.valid ? (
              <BenchmarkAlert>{validPreview.issues.join("\n")}</BenchmarkAlert>
            ) : null}
          </section>
        </DialogBody>
        <DialogFooter>
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
            variant="outline"
            disabled={busy || count === 0 || count > maxExecutions}
            onClick={() =>
              void operate(async () => {
                setPreview({
                  signature,
                  result: await benchmarkApi.previewRun(request),
                });
              })
            }
          >
            {t("run.checkPlan")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !validPreview?.valid}
            onClick={() =>
              void operate(async () => {
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
