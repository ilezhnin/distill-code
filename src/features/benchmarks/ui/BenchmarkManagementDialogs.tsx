import { Label } from "@/shared/ui/label";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
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
import type {
  BenchmarkDraft,
  RunSummary,
  ExportResult,
  Schedule,
} from "../types";
import {
  BenchmarkField,
  BenchmarkNotice,
  BenchmarkSelect,
} from "./BenchmarkFields";

export function BenchmarkImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const importDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft: BenchmarkDraft = JSON.parse(content);
      const definition = await benchmarkApi.importDefinition(draft);
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
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error && <BenchmarkNotice error>{error}</BenchmarkNotice>}
          <Input
            type="file"
            accept=".json,application/json"
            aria-label={t("import.file")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                if (file.size > 8 * 1024 * 1024) {
                  setError(t("import.tooLarge"));
                  return;
                }
                void file
                  .text()
                  .then(setContent)
                  .catch((failure) => setError(benchmarkErrorMessage(failure)));
              }
            }}
          />
          <Textarea
            rows={16}
            aria-label={t("import.content")}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !content.trim()}
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
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
          {error && <BenchmarkNotice error>{error}</BenchmarkNotice>}
          <BenchmarkField label={t("fields.name")}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </BenchmarkField>
          <BenchmarkField label={t("baseline.threshold")}>
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
          </BenchmarkField>
          <fieldset className="space-y-2">
            <legend>{t("baseline.runs")}</legend>
            {runs
              .filter(
                (run) => run.state === "completed" && !run.request.preview,
              )
              .map((run) => (
                <Label key={run.id} className="flex items-center gap-2 text-sm">
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
                  {new Date(run.createdAt).toLocaleString()}
                  <code className="text-xs">{run.id.slice(0, 8)}</code>
                </Label>
              ))}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
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
          {error && <BenchmarkNotice error>{error}</BenchmarkNotice>}
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
          {result && (
            <BenchmarkNotice>
              <p>{t("export.completed", { count: result.rowCount })}</p>
              <code className="block break-all text-xs">{result.path}</code>
              <code className="block break-all text-xs">
                {result.contentHash}
              </code>
            </BenchmarkNotice>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
          {result && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void revealInFileManager(result.manifestPath).catch((failure) =>
                  setError(benchmarkErrorMessage(failure)),
                )
              }
            >
              {t("export.reveal")}
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void exportData()}
          >
            {t("actions.export")}
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
        <DialogBody className="space-y-4">
          {(error || schedules.error) && (
            <BenchmarkNotice error>
              {error ?? benchmarkErrorMessage(schedules.error)}
            </BenchmarkNotice>
          )}
          {schedules.data?.map((schedule) => (
            <div
              key={schedule.id}
              className="flex items-center justify-between gap-4 rounded-md border border-border p-3"
            >
              <div>
                <p className="text-sm">{schedule.name}</p>
                <p className="text-xs text-muted-foreground">
                  {schedule.missed
                    ? t("schedules.missed")
                    : t("schedules.due", {
                        time: new Date(schedule.nextDueAt).toLocaleString(),
                      })}
                </p>
                {schedule.pausedReason && (
                  <p className="text-xs text-muted-foreground">
                    {schedule.pausedReason}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t("schedules.generated", {
                    count: schedule.generatedRunIds?.length ?? 0,
                    max: schedule.maxRuns,
                  })}
                </p>
              </div>
              <Label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={schedule.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    void save({
                      ...schedule,
                      enabled: checked === true,
                      nextDueAt:
                        checked === true
                          ? Date.now() + schedule.intervalMinutes * 60_000
                          : schedule.nextDueAt,
                      missed: false,
                    })
                  }
                />
                {t("enabled")}
              </Label>
            </div>
          ))}
          <BenchmarkField label={t("fields.name")}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </BenchmarkField>
          <BenchmarkField label={t("schedules.plan")}>
            {(id) => (
              <BenchmarkSelect
                id={id}
                value={runId}
                onChange={setRunId}
                options={[
                  { value: "none", label: t("schedules.chooseRun") },
                  ...runs
                    .filter((entry) => !entry.request.preview)
                    .map((entry) => ({
                      value: entry.id,
                      label: `${new Date(entry.createdAt).toLocaleString()} / ${entry.id.slice(0, 8)}`,
                    })),
                ]}
              />
            )}
          </BenchmarkField>
          <BenchmarkField label={t("schedules.interval")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={60}
                value={interval}
                onChange={(event) => setInterval(Number(event.target.value))}
              />
            )}
          </BenchmarkField>
          {run && (
            <BenchmarkNotice>
              {t("schedules.budget", {
                executions: run.request.maxExecutions,
                seconds: run.request.timeoutSeconds,
              })}
            </BenchmarkNotice>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <BenchmarkField label={t("schedules.maxRuns")}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={1000}
                  value={maxRuns}
                  onChange={(event) => setMaxRuns(Number(event.target.value))}
                />
              )}
            </BenchmarkField>
            <BenchmarkField label={t("schedules.maxTotalExecutions")}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={10000}
                  value={maxTotalExecutions}
                  onChange={(event) =>
                    setMaxTotalExecutions(Number(event.target.value))
                  }
                />
              )}
            </BenchmarkField>
          </div>
          <Label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={discovery}
              onCheckedChange={(checked) => setDiscovery(checked === true)}
            />
            {t("schedules.discovery")}
          </Label>
          {discovery && (
            <div className="space-y-4 rounded-md border border-border p-3">
              <BenchmarkNotice>
                {scope
                  ? t("schedules.scope", {
                      provider: scope.providerId,
                      account: scope.accountId ?? t("run.noAccount"),
                    })
                  : t("schedules.chooseRun")}
              </BenchmarkNotice>
              <p className="text-sm text-muted-foreground">
                {t("schedules.discoveryHelp")}
              </p>
              <BenchmarkField label={t("schedules.modelIds")}>
                {(id) => (
                  <Input
                    id={id}
                    value={modelIds}
                    onChange={(event) => setModelIds(event.target.value)}
                  />
                )}
              </BenchmarkField>
              <BenchmarkField label={t("schedules.maxCandidates")}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={32}
                    value={maxCandidates}
                    onChange={(event) =>
                      setMaxCandidates(Number(event.target.value))
                    }
                  />
                )}
              </BenchmarkField>
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
          )}
          <Label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked === true)}
            />
            {t("schedules.optIn")}
          </Label>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={
              busy ||
              !name.trim() ||
              !run ||
              interval < 60 ||
              !Number.isFinite(interval) ||
              !Number.isInteger(maxRuns) ||
              maxRuns < 1 ||
              maxRuns > 1000 ||
              !Number.isInteger(maxTotalExecutions) ||
              maxTotalExecutions < 1 ||
              maxTotalExecutions > 10000 ||
              (discovery &&
                (!scope?.accountId ||
                  !Number.isInteger(maxCandidates) ||
                  maxCandidates < 1 ||
                  maxCandidates > 32))
            }
            onClick={() => {
              if (run)
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
            {t("actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
