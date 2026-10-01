import { Label } from "@/shared/ui/label";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listProviderAccounts } from "@/features/providers/api/providerAccounts";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import type {
  BenchmarkDefinition,
  Configuration,
  RunPreview,
  RunRequest,
} from "../types";
import {
  BenchmarkField,
  BenchmarkNotice,
  BenchmarkSelect,
} from "./BenchmarkFields";

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
  const caseTurns = definitions
    .flatMap((definition) => definition.versions)
    .filter((version) => versions.includes(version.id))
    .reduce(
      (total, version) =>
        total + (version.manifest.workflow?.steps.length ?? 1),
      0,
    );
  const count = caseTurns * configurations.length * repetitions;
  const providerOptions = [
    ...new Set([
      ...(capabilities.data
        ?.map((entry) => entry.providerId)
        .filter((id) => id !== "*") ?? []),
      ...providers.map((entry) => entry.id),
    ]),
  ];
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
          <DialogDescription>{t("run.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {error && <BenchmarkNotice error>{error}</BenchmarkNotice>}
          {previewOnly && <BenchmarkNotice>{t("run.preview")}</BenchmarkNotice>}
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              {t("run.tests")}
            </legend>
            {definitions
              .filter((entry) => !entry.archived)
              .flatMap((definition) =>
                definition.versions.map((version) => (
                  <Label
                    key={version.id}
                    className="flex items-center gap-2 text-sm"
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
                    <span>{version.manifest.name}</span>
                    <code className="text-xs text-muted-foreground">
                      {version.contentHash.slice(0, 10)}
                    </code>
                  </Label>
                )),
              )}
            {!definitions.some(
              (entry) => !entry.archived && entry.versions.length,
            ) && <BenchmarkNotice>{t("run.noPublished")}</BenchmarkNotice>}
          </fieldset>
          <div className="grid gap-3 md:grid-cols-2">
            <BenchmarkField label={t("fields.provider")}>
              {(id) => (
                <BenchmarkSelect
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
                    ...providerOptions.map((value) => ({
                      value,
                      label: value,
                    })),
                  ]}
                />
              )}
            </BenchmarkField>
            <BenchmarkField label={t("fields.account")}>
              {(id) => (
                <BenchmarkSelect
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
            </BenchmarkField>
          </div>
          {providerId && (
            <>
              {inventory.isPending && (
                <BenchmarkNotice>{t("loading")}</BenchmarkNotice>
              )}
              {inventory.error && (
                <BenchmarkNotice error>
                  {benchmarkErrorMessage(inventory.error)}
                </BenchmarkNotice>
              )}
              <BenchmarkField label={t("fields.model")}>
                {(id) => (
                  <BenchmarkSelect
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
              </BenchmarkField>
              {model && (
                <div className="space-y-3">
                  <BenchmarkField label={t("fields.effort")}>
                    {(id) => (
                      <BenchmarkSelect
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
                  </BenchmarkField>
                  {model.supportsFastMode && (
                    <Label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={fastMode}
                        onCheckedChange={(checked) =>
                          setFastMode(checked === true)
                        }
                      />
                      {t("fields.fastMode")}
                    </Label>
                  )}
                  {!model.available && (
                    <BenchmarkNotice>
                      {model.reason ?? t("unsupported")}
                    </BenchmarkNotice>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!model.available}
                    onClick={addConfiguration}
                  >
                    {t("run.addConfiguration")}
                  </Button>
                </div>
              )}
              {capabilities.data
                ?.filter((entry) => entry.providerId === providerId)
                .map((entry) => (
                  <p
                    key={entry.executionProfile}
                    className="text-xs text-muted-foreground"
                  >
                    {entry.executionProfile}: {entry.reason}
                  </p>
                ))}
            </>
          )}
          <div className="space-y-2">
            {configurations.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>{configurationLabel(entry)}</span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setConfigurations((previous) =>
                      previous.filter((config) => config.id !== entry.id),
                    )
                  }
                >
                  {t("actions.remove")}
                </Button>
              </div>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { key: "repetitions", value: repetitions, set: setRepetitions },
              {
                key: "timeoutSeconds",
                value: timeoutSeconds,
                set: setTimeoutSeconds,
              },
              {
                key: "maxExecutions",
                value: maxExecutions,
                set: setMaxExecutions,
              },
            ].map((field) => (
              <BenchmarkField key={field.key} label={t(`fields.${field.key}`)}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    disabled={previewOnly && field.key === "repetitions"}
                    value={field.value}
                    onChange={(event) => field.set(Number(event.target.value))}
                  />
                )}
              </BenchmarkField>
            ))}
          </div>
          <BenchmarkNotice>
            {t("run.executionCount", { count })}
            <div>
              {t("run.estimatedCost", {
                value:
                  validPreview?.estimatedCost == null
                    ? t("unknown")
                    : validPreview.estimatedCost.toFixed(4),
              })}
            </div>
            {validPreview?.costReason && <div>{validPreview.costReason}</div>}
          </BenchmarkNotice>
          {validPreview && !validPreview.valid && (
            <BenchmarkNotice error>
              {validPreview.issues.join("\n")}
            </BenchmarkNotice>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
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
