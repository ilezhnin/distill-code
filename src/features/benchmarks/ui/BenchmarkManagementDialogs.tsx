import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { revealInFileManager } from "@/shared/lib/fileManager";
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
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { accountDisplay, shortId } from "../lib/benchmarkLabels";
import type {
  BenchmarkDraft,
  ExportResult,
  RunSummary,
  Schedule,
} from "../types";
import {
  BenchmarkAlert,
  Field,
  SectionHeading,
  SelectField,
} from "./BenchmarkPrimitives";

function CloseButton({
  onClose,
  disabled = false,
}: {
  onClose: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("benchmarks");
  return (
    <Button
      type="button"
      variant="ghost"
      flush
      className="sm:mr-auto"
      disabled={disabled}
      onClick={onClose}
    >
      {t("actions.close")}
    </Button>
  );
}

export function BenchmarkImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (id?: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [publish, setPublish] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Importing never runs anything; publishing only verifies the evaluator
  // against its own references, so a prepared set can be loaded ready to run.
  const importOne = async (draft: BenchmarkDraft) => {
    const definition = await benchmarkApi.importDefinition(draft);
    if (publish) {
      await benchmarkApi.publishVersion(
        definition.id,
        definition.draftRevision,
      );
    }
    return definition;
  };
  const importDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      if (files.length > 1) {
        const failures: string[] = [];
        for (const file of files) {
          try {
            await importOne(JSON.parse(await file.text()));
          } catch (failure) {
            failures.push(`${file.name}: ${benchmarkErrorMessage(failure)}`);
          }
        }
        await client.invalidateQueries({ queryKey: benchmarkKeys });
        if (failures.length) {
          setError(failures.join("\n"));
          return;
        }
        onImported();
        return;
      }
      const definition = await importOne(JSON.parse(content));
      await client.invalidateQueries({ queryKey: benchmarkKeys });
      onImported(definition.id);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          <Input
            type="file"
            multiple
            accept=".json,application/json"
            aria-label={t("import.file")}
            onChange={(event) => {
              const chosen = [...(event.target.files ?? [])];
              setError(null);
              if (chosen.some((file) => file.size > 8 * 1024 * 1024)) {
                setError(t("import.tooLarge"));
                setFiles([]);
                return;
              }
              setFiles(chosen);
              if (chosen.length === 1) {
                void chosen[0]
                  .text()
                  .then(setContent)
                  .catch((failure) => setError(benchmarkErrorMessage(failure)));
              }
            }}
          />
          <Label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={publish}
              onCheckedChange={(checked) => setPublish(checked === true)}
            />
            {t("import.publish")}
          </Label>
          {files.length > 1 ? (
            <p className="text-sm text-muted-foreground">
              {t("import.selected", { count: files.length })}
            </p>
          ) : (
            <Textarea
              rows={14}
              variant="code"
              aria-label={t("import.content")}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <CloseButton onClose={onClose} disabled={busy} />
          <Button
            type="button"
            variant="primary"
            disabled={busy || (files.length <= 1 && !content.trim())}
            onClick={() => void importDraft()}
          >
            {t("actions.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BenchmarkBaselineDialog({
  runs,
  onClose,
  onCreated,
}: {
  runs: RunSummary[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eligible = runs.filter(
    (run) => run.state === "completed" && !run.request.preview,
  );
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const baseline = await benchmarkApi.createBaseline(
        name.trim(),
        selected,
        threshold / 100,
      );
      await client.invalidateQueries({ queryKey: benchmarkKeys });
      onCreated(baseline.id);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("baseline.create")}</DialogTitle>
          <DialogDescription>{t("baseline.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          <Field label={t("fields.name")}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label={t("baseline.threshold")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={100}
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
            )}
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm">{t("baseline.runs")}</legend>
            {eligible.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("baseline.noRuns")}
              </p>
            ) : null}
            {eligible.map((run) => (
              <Label
                key={run.id}
                className="flex items-center gap-2 py-1 text-sm"
              >
                <Checkbox
                  checked={selected.includes(run.id)}
                  onCheckedChange={(checked) =>
                    setSelected((previous) =>
                      checked
                        ? [...previous, run.id]
                        : previous.filter((id) => id !== run.id),
                    )
                  }
                />
                {formatDate(run.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                <code className="text-xs text-muted-foreground">
                  {shortId(run.id)}
                </code>
              </Label>
            ))}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <CloseButton onClose={onClose} disabled={busy} />
          <Button
            type="button"
            variant="primary"
            disabled={
              busy ||
              !name.trim() ||
              !selected.length ||
              !Number.isFinite(threshold) ||
              threshold < 0 ||
              threshold > 100
            }
            onClick={() => void save()}
          >
            {t("baseline.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BenchmarkExportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("benchmarks");
  const [includeHeldOut, setIncludeHeldOut] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exportData = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await benchmarkApi.exportDataset(includeHeldOut));
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
          <DialogDescription>{t("export.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          <Label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={includeHeldOut}
              onCheckedChange={(checked) => {
                setIncludeHeldOut(checked === true);
                setResult(null);
              }}
            />
            {t("export.heldOut")}
          </Label>
          {result ? (
            <div role="status" className="space-y-1 text-sm">
              <p>{t("export.completed", { count: result.rowCount })}</p>
              <code className="block break-all text-xs text-muted-foreground">
                {result.path}
              </code>
              <p className="text-xs text-muted-foreground">
                {t("export.hash")}:{" "}
                <code className="break-all">{result.contentHash}</code>
              </p>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <CloseButton onClose={onClose} disabled={busy} />
          {result ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void revealInFileManager(result.manifestPath).catch((failure) =>
                  setError(benchmarkErrorMessage(failure)),
                )
              }
            >
              {t("actions.reveal")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void exportData()}
          >
            {t("toolbar.export")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BenchmarkSchedulesDialog({
  runs,
  onClose,
}: {
  runs: RunSummary[];
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const schedules = useQuery({
    queryKey: [...benchmarkKeys, "schedules"],
    queryFn: benchmarkApi.listSchedules,
  });
  const [name, setName] = useState("");
  const [runId, setRunId] = useState("none");
  const [interval, setInterval] = useState(1440);
  const [enabled, setEnabled] = useState(false);
  const [discovery, setDiscovery] = useState(false);
  const [includeNewModels, setIncludeNewModels] = useState(false);
  const [modelIds, setModelIds] = useState("");
  const [maxCandidates, setMaxCandidates] = useState(4);
  const [maxRuns, setMaxRuns] = useState(20);
  const [maxTotalExecutions, setMaxTotalExecutions] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = runs.find((entry) => entry.id === runId);
  const scope = run?.request.configurations[0];
  const save = async (schedule: Schedule) => {
    setBusy(true);
    setError(null);
    try {
      await benchmarkApi.saveSchedule(schedule);
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const canSave =
    !busy &&
    name.trim() !== "" &&
    Boolean(run) &&
    Number.isFinite(interval) &&
    interval >= 60 &&
    Number.isInteger(maxRuns) &&
    maxRuns >= 1 &&
    maxRuns <= 1000 &&
    Number.isInteger(maxTotalExecutions) &&
    maxTotalExecutions >= 1 &&
    maxTotalExecutions <= 10000 &&
    (!discovery ||
      (Boolean(scope?.accountId) &&
        Number.isInteger(maxCandidates) &&
        maxCandidates >= 1 &&
        maxCandidates <= 32));
  const numberField = (
    label: string,
    value: number,
    set: (value: number) => void,
    min: number,
    max?: number,
  ) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
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
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("schedules.title")}</DialogTitle>
          <DialogDescription>{t("schedules.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {error || schedules.error ? (
            <BenchmarkAlert>
              {error ?? benchmarkErrorMessage(schedules.error)}
            </BenchmarkAlert>
          ) : null}
          {schedules.data && schedules.data.length > 0 ? (
            <section className="space-y-2">
              <SectionHeading title={t("schedules.existing")} />
              <ul className="divide-y divide-border">
                {schedules.data.map((schedule) => (
                  <li
                    key={schedule.id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm">{schedule.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {schedule.missed
                          ? t("schedules.missed")
                          : t("schedules.due", {
                              time: formatDate(schedule.nextDueAt, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }),
                            })}
                        {" · "}
                        {t("schedules.generated", {
                          count: schedule.generatedRunIds?.length ?? 0,
                          max: schedule.maxRuns,
                        })}
                      </p>
                      {schedule.pausedReason ? (
                        <p className="text-xs text-muted-foreground">
                          {schedule.pausedReason}
                        </p>
                      ) : null}
                    </div>
                    <Label className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={schedule.enabled}
                        disabled={busy}
                        aria-label={t("enabled")}
                        onCheckedChange={(checked) =>
                          void save({
                            ...schedule,
                            enabled: checked,
                            nextDueAt: checked
                              ? Date.now() + schedule.intervalMinutes * 60_000
                              : schedule.nextDueAt,
                            missed: false,
                          })
                        }
                      />
                      {t("enabled")}
                    </Label>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="space-y-4">
            <SectionHeading title={t("schedules.newCampaign")} />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t("fields.name")}>
                {(id) => (
                  <Input
                    id={id}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t("schedules.plan")}>
                {(id) => (
                  <SelectField
                    id={id}
                    value={runId}
                    onChange={setRunId}
                    options={[
                      { value: "none", label: t("schedules.chooseRun") },
                      ...runs
                        .filter((entry) => !entry.request.preview)
                        .map((entry) => ({
                          value: entry.id,
                          label: t("filters.runLabel", {
                            date: formatDate(entry.createdAt, {
                              dateStyle: "short",
                              timeStyle: "short",
                            }),
                            id: shortId(entry.id),
                          }),
                        })),
                    ]}
                  />
                )}
              </Field>
              {numberField(t("schedules.interval"), interval, setInterval, 60)}
              {numberField(
                t("schedules.maxRuns"),
                maxRuns,
                setMaxRuns,
                1,
                1000,
              )}
              {numberField(
                t("schedules.maxTotalExecutions"),
                maxTotalExecutions,
                setMaxTotalExecutions,
                1,
                10000,
              )}
            </div>
            {run ? (
              <p className="text-xs text-muted-foreground">
                {t("schedules.budget", {
                  executions: run.request.maxExecutions,
                  seconds: run.request.timeoutSeconds,
                })}
              </p>
            ) : null}
            <Label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={discovery}
                onCheckedChange={(checked) => setDiscovery(checked === true)}
              />
              {t("schedules.discovery")}
            </Label>
            {discovery ? (
              <div className="space-y-4 rounded-md bg-muted/40 p-4">
                <p className="text-xs text-muted-foreground">
                  {scope
                    ? t("schedules.scope", {
                        provider: scope.providerId,
                        account: accountDisplay(t, scope.accountId),
                      })
                    : t("schedules.chooseRun")}{" "}
                  {t("schedules.discoveryHelp")}
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label={t("schedules.modelIds")}>
                    {(id) => (
                      <Input
                        id={id}
                        value={modelIds}
                        onChange={(event) => setModelIds(event.target.value)}
                      />
                    )}
                  </Field>
                  {numberField(
                    t("schedules.maxCandidates"),
                    maxCandidates,
                    setMaxCandidates,
                    1,
                    32,
                  )}
                </div>
                <Label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={includeNewModels}
                    onCheckedChange={(checked) =>
                      setIncludeNewModels(checked === true)
                    }
                  />
                  {t("schedules.includeNew")}
                </Label>
              </div>
            ) : null}
            <Label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={enabled}
                onCheckedChange={(checked) => setEnabled(checked === true)}
              />
              {t("schedules.optIn")}
            </Label>
          </section>
        </DialogBody>
        <DialogFooter>
          <CloseButton onClose={onClose} disabled={busy} />
          <Button
            type="button"
            variant="primary"
            disabled={!canSave}
            onClick={() => {
              if (!run) return;
              void save({
                id: crypto.randomUUID(),
                name: name.trim(),
                enabled,
                intervalMinutes: interval,
                nextDueAt: Date.now() + interval * 60_000,
                request: { ...run.request, requestKey: crypto.randomUUID() },
                missed: false,
                discovery:
                  discovery && scope?.accountId
                    ? {
                        providerId: scope.providerId,
                        accountId: scope.accountId,
                        includeNewModels,
                        modelIds: modelIds
                          .split(",")
                          .map((id) => id.trim())
                          .filter(Boolean),
                        maxCandidates,
                      }
                    : null,
                maxRuns,
                maxTotalExecutions,
                generatedRunIds: [],
                pausedReason: null,
              });
            }}
          >
            {t("schedules.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
