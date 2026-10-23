import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { stalePin } from "../lib/benchmarkCatchUp";
import { configurationLabel } from "../lib/benchmarkDraft";
import { explicitEffort } from "../lib/benchmarkEffort";
import {
  attentionLabel,
  modelDisplayName,
  shortId,
} from "../lib/benchmarkLabels";
import { runWindowCloses } from "../lib/benchmarkPlan";
import { firstById } from "../lib/benchmarkLookup";
import type { Configuration } from "../types";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  StateBadge,
} from "./BenchmarkPrimitives";
import {
  TaskGrid,
  TaskSummary,
  taskCells,
  type TaskReference,
} from "./BenchmarkTaskGrid";
import { FINISHED_RUN, listByIds } from "./BenchmarkTestStatus";
import {
  BenchmarkWorkflowActivity,
  BenchmarkWorkflowProgress,
} from "./BenchmarkWorkflowProgress";

/** The model a configuration runs, whatever its execution profile. */
function modelIdentity(configuration: Configuration): string {
  return JSON.stringify([
    configuration.providerId,
    configuration.accountId ?? null,
    configuration.modelId,
    explicitEffort(configuration.effort),
    configuration.fastMode ?? false,
  ]);
}

/**
 * One frozen run: its progress, every test in the order the run takes them
 * with its state and clock, and pause, resume and cancel.
 */
export function BenchmarkRunDrawer({
  taskOrder = [],
  runId,
  onClose,
  onEvidence,
}: {
  taskOrder?: TaskReference[];
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
      // The views refresh in the background: refetching every benchmark
      // query (the board included) can take seconds, and the controls must
      // stay usable meanwhile, Stop during a pause drain above all.
      void client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const run = query.data;
  const terminal = run ? FINISHED_RUN.has(run.state) : false;
  // A run planned on a runtime the inventory no longer lists cannot go on:
  // every further test would be refused, so it is only stopped.
  const inventories = useQueries({
    queries: (terminal ? [] : (run?.request.configurations ?? [])).map(
      (entry) => ({
        queryKey: [
          "benchmark-catch-up-inventory",
          entry.providerId,
          entry.accountId ?? null,
        ],
        queryFn: () =>
          benchmarkApi.getInventory(entry.providerId, entry.accountId ?? null),
        staleTime: Number.POSITIVE_INFINITY,
      }),
    ),
  });
  const outdated =
    !terminal &&
    (run?.request.configurations ?? []).some((entry, index) => {
      const inventory = inventories[index]?.data;
      return inventory != null && stalePin(entry, inventory);
    });
  const attempts = run?.attempts ?? [];
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
  const summaryById = useMemo(
    () => firstById(summaries.data ?? []),
    [summaries.data],
  );
  const taskById = useMemo(() => firstById(taskOrder), [taskOrder]);
  // A model's configurations, one per execution profile, are one model:
  // its run is titled by the model and shows one grid; a matrix of models
  // is titled by its id, one grid per model.
  const configurations = run?.request.configurations ?? [];
  const models = useMemo(() => {
    const grouped = new Map<string, Configuration[]>();
    for (const configuration of configurations) {
      const key = modelIdentity(configuration);
      grouped.set(key, [...(grouped.get(key) ?? []), configuration]);
    }
    return [...grouped.entries()];
  }, [configurations]);
  const single = models.length === 1 ? models[0][1][0] : null;
  const effort = single ? explicitEffort(single.effort) : null;
  // One grid per model, its cases in the run's dispatch order.
  const grids = useMemo(() => {
    return models.map(([key, entries]) => {
      const ids = new Set(entries.map((entry) => entry.id));
      const own = attempts.filter((attempt) =>
        ids.has(attempt.configuration.id),
      );
      // Only the cases the model's configurations planned.
      const order: { id: string; name: string; number?: number }[] = [];
      const seen = new Set<string>();
      for (const attempt of own) {
        if (seen.has(attempt.versionId)) continue;
        seen.add(attempt.versionId);
        order.push({
          id: attempt.versionId,
          name: names.get(attempt.versionId) ?? shortId(attempt.versionId),
          number: taskById.get(attempt.versionId)?.number,
        });
      }
      return {
        key,
        label: configurationLabel(entries[0]),
        cells: taskCells(
          order,
          own.map((attempt) => ({
            ...attempt,
            cost: summaryById.get(attempt.id)?.cost ?? attempt.usage.cost,
            score: scores.get(attempt.id) ?? null,
          })),
          run?.state ?? null,
          0, // A run counts only its actual attempts, never placeholder repetitions.
        ),
      };
    });
  }, [attempts, models, names, scores, run?.state, taskById, summaryById]);
  // Keep the configuration that works now in view as a matrix run moves on.
  const rows = useRef(new Map<string, HTMLDivElement>());
  // Progress in tests: a cell, one configuration measuring one case, is
  // settled once every repetition of it has its result.
  const cells = grids.flatMap((grid) => grid.cells);
  const total = cells.filter((cell) => cell.status != null).length;
  const settled = cells.filter(
    (cell) =>
      (cell.status?.kind === "scored" || cell.status?.kind === "unscored") &&
      !cell.dots.some((dot) => dot === "running" || dot === "queued"),
  ).length;
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
          {outdated ? (
            <BenchmarkAlert tone="warning">
              {t("run.outdatedHint")}
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
                  </div>
                  {!run.request.workflowPolicy ? (
                    <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                      {t("runs.progress", { completed: settled, total })}
                    </span>
                  ) : null}
                </div>
                {run.state === "needs_attention" ? (
                  <p className="text-xs text-muted-foreground">
                    {attentionLabel(
                      t,
                      summary ?? { attention: null },
                      formatDate(runWindowCloses(run), {
                        dateStyle: "short",
                        timeStyle: "short",
                      }),
                    )}
                  </p>
                ) : null}
                {!run.request.workflowPolicy ? (
                  <Progress
                    value={total === 0 ? 0 : (settled / total) * 100}
                    aria-label={t("runs.progressLabel")}
                  />
                ) : null}
              </div>
              {run.request.workflowPolicy ? (
                <BenchmarkWorkflowProgress runId={run.id} />
              ) : summary?.workflowActivity?.length &&
                [
                  "running",
                  "pausing",
                  "cancelling",
                  "needs_attention",
                ].includes(run.state) ? (
                <BenchmarkWorkflowActivity run={summary} />
              ) : null}
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
                        timing="elapsed"
                        clockAt={
                          run.state === "paused"
                            ? (run.pausedSince ?? run.updatedAt)
                            : undefined
                        }
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
              {outdated ? null : (
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
                      !["paused", "needs_attention", "planned"].includes(
                        run.state,
                      )
                    }
                    onClick={() => void control(benchmarkApi.resumeRun)}
                  >
                    {t("actions.resume")}
                  </Button>
                </>
              )}
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
