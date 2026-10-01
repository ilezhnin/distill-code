import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
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
import { Progress } from "@/shared/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { shortId } from "../lib/benchmarkLabels";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  StateBadge,
} from "./BenchmarkPrimitives";

/** One frozen run: progress, per-attempt outcomes and pause/resume/cancel. */
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
  const terminal = run && ["completed", "cancelled"].includes(run.state);
  const settled =
    run?.attempts.filter((attempt) => attempt.phase === "terminal").length ?? 0;
  const total = run?.attempts.length ?? 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            {t("runs.runTitle", { id: shortId(runId) })}
          </DialogTitle>
          <DialogDescription>
            {run
              ? formatDate(run.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("fields.configuration")}</TableHead>
                    <TableHead>{t("fields.repetition")}</TableHead>
                    <TableHead>{t("fields.status")}</TableHead>
                    <TableHead>{t("evidence.title")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.attempts.map((attempt) => (
                    <TableRow key={attempt.id}>
                      <TableCell>
                        {configurationLabel(attempt.configuration)}
                      </TableCell>
                      <TableCell>{attempt.repetition + 1}</TableCell>
                      <TableCell className="whitespace-normal">
                        <StateBadge state={attempt.outcome ?? attempt.phase} />
                        {attempt.reason ? (
                          <p className="mt-1 max-w-80 text-xs text-muted-foreground">
                            {attempt.reason}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => onEvidence(attempt.id)}
                        >
                          {t("actions.inspect")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!terminal ? (
                <p className="text-xs text-muted-foreground">
                  {t("runs.controls")}
                </p>
              ) : null}
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
