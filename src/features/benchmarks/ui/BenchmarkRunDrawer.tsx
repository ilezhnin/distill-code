import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import { BenchmarkNotice } from "./BenchmarkFields";

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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("runs.title")}</DialogTitle>
          <DialogDescription>{t("runs.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {query.isPending && <BenchmarkNotice>{t("loading")}</BenchmarkNotice>}
          {(query.error || error) && (
            <BenchmarkNotice error>
              {error ?? benchmarkErrorMessage(query.error)}
            </BenchmarkNotice>
          )}
          {run && (
            <>
              <div className="flex justify-between gap-3 text-sm">
                <span>
                  {t(`states.${run.state}`, { defaultValue: run.state })}
                </span>
                <span>
                  {t("runs.progress", {
                    completed: run.attempts.filter(
                      (attempt) => attempt.phase === "terminal",
                    ).length,
                    total: run.attempts.length,
                  })}
                </span>
              </div>
              <progress
                className="w-full"
                value={
                  run.attempts.filter((attempt) => attempt.phase === "terminal")
                    .length
                }
                max={Math.max(1, run.attempts.length)}
                aria-label={t("runs.progressLabel")}
              />
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
                      <TableCell>
                        <div>
                          {t(`states.${attempt.outcome ?? attempt.phase}`, {
                            defaultValue: attempt.outcome ?? attempt.phase,
                          })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {attempt.reason}
                        </p>
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
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
          {run && !terminal && (
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
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
