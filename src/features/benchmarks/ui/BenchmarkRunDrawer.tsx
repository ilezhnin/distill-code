import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { Progress } from "@/shared/ui/progress";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import {
  benchmarkKeys,
  useBenchmarkDefinitions,
  useBenchmarkRuns,
} from "../hooks/useBenchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { explicitEffort } from "../lib/benchmarkEffort";
import {
  attentionLabel,
  modelDisplayName,
  shortId,
} from "../lib/benchmarkLabels";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  StateBadge,
} from "./BenchmarkPrimitives";
import { TaskGrid, TaskSummary, taskCells } from "./BenchmarkTaskGrid";
import { FINISHED_RUN, listByIds } from "./BenchmarkTestStatus";

/**
 * One frozen run: its progress, every test in the order the run takes them
 * with its state and clock, and pause, resume and cancel.
 */
export function BenchmarkRunDrawer({
  runId,
  onClose,
  onEvidence,
}: {
  runId: string;
  onClose: () => void;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [...benchmarkKeys, "run", runId],
    queryFn: () => benchmarkApi.getRun(runId),
  });
  // The summary names what parked a run that waits for the operator.
  const summary = useBenchmarkRuns().data?.find((entry) => entry.id === runId);
  const definitions = useBenchmarkDefinitions();
  const names = useMemo(
    () =>
      new Map(
        (definitions.data ?? []).flatMap((definition) =>
          definition.versions.map((version) => [
            version.id,
            version.manifest.name,
          ]),
        ),
      ),
    [definitions.data],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const control = async (operation: (id: string) => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation(runId);
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const run = query.data;
  const terminal = run ? FINISHED_RUN.has(run.state) : false;
  const attempts = run?.attempts ?? [];
  const settled = attempts.filter(
    (attempt) => attempt.phase === "terminal",
  ).length;
  const total = attempts.length;
  // Summaries carry each attempt's score.
  const attemptIds = useMemo(
    () => attempts.map((attempt) => attempt.id),
    [attempts],
  );
  const summaries = useQuery({
    queryKey: [...benchmarkKeys, "run-attempts", runId, attemptIds],
    queryFn: () => listByIds(attemptIds),
    enabled: attemptIds.length > 0,
  });
  const scores = useMemo(
    () =>
      new Map(
        (summaries.data ?? []).map((summary) => [
          summary.id,
          summary.score ?? null,
        ]),
      ),
    [summaries.data],
  );
  // One model's run is titled by the model, a matrix by its id.
  const configurations = run?.request.configurations ?? [];
  const single = configurations.length === 1 ? configurations[0] : null;
  const effort = single ? explicitEffort(single.effort) : null;
  // One grid per configuration, its cases in the run's dispatch order.
  const grids = useMemo(() => {
    const order: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const attempt of attempts) {
      if (seen.has(attempt.versionId)) continue;
      seen.add(attempt.versionId);
      order.push({
        id: attempt.versionId,
        name: names.get(attempt.versionId) ?? shortId(attempt.versionId),
      });
    }
    return configurations.map((configuration) => ({
      key: configuration.id,
      label: configurationLabel(configuration),
      cells: taskCells(
        order,
        attempts
          .filter((attempt) => attempt.configuration.id === configuration.id)
          .map((attempt) => ({
            ...attempt,
            cost: attempt.usage.cost,
            score: scores.get(attempt.id) ?? null,
          })),
        run?.state ?? null,
      ),
    }));
  }, [attempts, configurations, names, scores, run?.state]);
  // Keep the configuration that works now in view as a matrix run moves on.
  const rows = useRef(new Map<string, HTMLDivElement>());
  const runningKey = grids.find((grid) =>
    grid.cells.some(
      (cell) =>
        cell.status?.kind === "running" || cell.status?.kind === "waiting",
    ),
  )?.key;
  useEffect(() => {
    if (runningKey)
      rows.current.get(runningKey)?.scrollIntoView?.({ block: "nearest" });
  }, [runningKey]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {single ? (
              <>
                <span className="shrink-0">
                  {getProviderIcon(single.providerId, "size-5")}
                </span>
                <span>{modelDisplayName(single)}</span>
                {effort ? <Badge variant="outline">{effort}</Badge> : null}
              </>
            ) : (
              t("runs.runTitle", { id: shortId(runId) })
            )}
          </DialogTitle>
          <DialogDescription>
            {run
              ? `${formatDate(run.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}${single ? ` · ${shortId(runId)}` : ""}`
              : t("loading")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {query.error || error ? (
            <BenchmarkAlert>
              {error ?? benchmarkErrorMessage(query.error)}
            </BenchmarkAlert>
          ) : null}
          {query.isPending ? (
            <BenchmarkEmpty title={t("loading")} compact />
          ) : null}
          {run ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <StateBadge state={run.state} />
                    {run.request.preview ? (
                      <span className="text-xs text-muted-foreground">
                        {t("runs.preview")}
                      </span>
                    ) : null}
                    {run.state === "needs_attention" ? (
                      <span className="text-xs text-muted-foreground">
                        {attentionLabel(t, summary ?? { attention: null })}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t("runs.progress", { completed: settled, total })}
                  </span>
                </div>
                <Progress
                  value={total === 0 ? 0 : (settled / total) * 100}
                  aria-label={t("runs.progressLabel")}
                />
              </div>
              <div className="max-h-[60vh] space-y-6 overflow-y-auto">
                {grids.map((grid) => (
                  <section key={grid.key} className="space-y-3">
                    {single ? null : (
                      <h3 className="text-sm font-medium">{grid.label}</h3>
                    )}
                    <TaskSummary cells={grid.cells} />
                    <div
                      ref={(element) => {
                        if (element) rows.current.set(grid.key, element);
                        else rows.current.delete(grid.key);
                      }}
                    >
                      <TaskGrid
                        cells={grid.cells}
                        onOpen={(cell) => onEvidence(cell.attemptIds[0])}
                      />
                    </div>
                  </section>
                ))}
              </div>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            flush
            className="sm:mr-auto"
            onClick={onClose}
          >
            {t("actions.close")}
          </Button>
          {run && !terminal ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy || run.state !== "running"}
                onClick={() => void control(benchmarkApi.pauseRun)}
              >
                {t("actions.pause")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  !["paused", "needs_attention", "planned"].includes(run.state)
                }
                onClick={() => void control(benchmarkApi.resumeRun)}
              >
                {t("actions.resume")}
              </Button>
              <Button
                type="button"
                variant="outline"
                destructive
                disabled={busy || run.state === "cancelling"}
                onClick={() => void control(benchmarkApi.cancelRun)}
              >
                {t("actions.cancelRun")}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
