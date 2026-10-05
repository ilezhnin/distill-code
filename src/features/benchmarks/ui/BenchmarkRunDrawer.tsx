import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
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
import { benchmarkKeys, useBenchmarkDefinitions } from "../hooks/useBenchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { explicitEffort } from "../lib/benchmarkEffort";
import { modelDisplayName, shortId } from "../lib/benchmarkLabels";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  StateBadge,
} from "./BenchmarkPrimitives";
import {
  FINISHED_RUN,
  listByIds,
  TestStatusMark,
  testStatus,
  useNow,
} from "./BenchmarkTestStatus";

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
  const statuses = useMemo(
    () =>
      new Map(
        attempts.map((attempt) => [
          attempt.id,
          testStatus([attempt], scores, terminal),
        ]),
      ),
    [attempts, scores, terminal],
  );
  const working = attempts.filter((attempt) => {
    const kind = statuses.get(attempt.id)?.kind;
    return kind === "running" || kind === "judging";
  });
  const now = useNow(working.length > 0);
  // Keep the attempt that runs now in view as the run moves down the list.
  const rows = useRef(new Map<string, HTMLLIElement>());
  const runningId = attempts.find(
    (attempt) => statuses.get(attempt.id)?.kind === "running",
  )?.id;
  useEffect(() => {
    if (runningId)
      rows.current.get(runningId)?.scrollIntoView?.({ block: "nearest" });
  }, [runningId]);
  // One model's run is titled by the model, a matrix by its id.
  const configurations = run?.request.configurations ?? [];
  const single = configurations.length === 1 ? configurations[0] : null;
  const repeated = (run?.request.repetitions ?? 1) > 1;
  const effort = single ? explicitEffort(single.effort) : null;
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
              <ol className="max-h-[55vh] overflow-y-auto">
                {attempts.map((attempt) => {
                  const status = statuses.get(attempt.id) ?? null;
                  const current =
                    status?.kind === "running" || status?.kind === "judging";
                  const details = [
                    single ? null : configurationLabel(attempt.configuration),
                    repeated
                      ? t("fields.repetitionValue", {
                          value: attempt.repetition + 1,
                        })
                      : null,
                    status?.kind === "unscored" ? attempt.reason : null,
                  ].filter(Boolean);
                  return (
                    <li
                      key={attempt.id}
                      ref={(element) => {
                        if (element) rows.current.set(attempt.id, element);
                        else rows.current.delete(attempt.id);
                      }}
                      aria-current={current ? "step" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-2 py-1.5 text-sm",
                        current && "bg-muted",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">
                          {names.get(attempt.versionId) ??
                            shortId(attempt.versionId)}
                        </div>
                        {details.length > 0 ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {details.join(" · ")}
                          </div>
                        ) : null}
                      </div>
                      <TestStatusMark status={status} now={now} />
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={attempt.phase === "pending"}
                        onClick={() => onEvidence(attempt.id)}
                      >
                        {t("actions.inspect")}
                      </Button>
                    </li>
                  );
                })}
              </ol>
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
