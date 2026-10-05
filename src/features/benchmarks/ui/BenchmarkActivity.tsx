import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";
import { Spinner } from "@/shared/ui/spinner";
import { modelNameKey, useModelNames } from "../hooks/useBenchmarks";
import {
  activeRuns,
  runProgress,
  runningConfigurations,
  stalledRuns,
} from "../lib/benchmarkActivity";
import { modelDisplayName } from "../lib/benchmarkLabels";
import type { RunSummary } from "../types";
import { StateBadge } from "./BenchmarkPrimitives";

/**
 * Runs that dispatch, each with its progress and the models running now, and
 * one line of runs that wait for the operator. Each opens its run.
 */
export function BenchmarkActivity({
  runs,
  onOpenRun,
}: {
  runs: RunSummary[];
  onOpenRun: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const names = useModelNames();
  const active = activeRuns(runs);
  const stalled = stalledRuns(runs);
  if (active.length === 0 && stalled.length === 0) return null;
  return (
    <section aria-label={t("activity.title")} className="flex flex-col gap-2">
      {active.map((run) => {
        const { settled, total } = runProgress([run]);
        const now = runningConfigurations(run).map((entry) =>
          [
            modelDisplayName(entry, names.get(modelNameKey(entry))),
            entry.effort,
          ]
            .filter(Boolean)
            .join(" "),
        );
        return (
          <button
            key={run.id}
            type="button"
            className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-muted/50"
            onClick={() => onOpenRun(run.id)}
          >
            {run.state === "running" ? (
              <Spinner decorative className="size-4 shrink-0 text-chart-1" />
            ) : (
              <StateBadge state={run.state} />
            )}
            <span className="shrink-0 text-sm tabular-nums">
              {t("activity.progress", { settled, total })}
            </span>
            <Progress
              value={total === 0 ? 0 : (settled / total) * 100}
              aria-label={t("runs.progressLabel")}
              className="h-1.5 w-32 shrink-0"
            />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {now.length > 0
                ? t("activity.now", { models: now.join(", ") })
                : null}
            </span>
          </button>
        );
      })}
      {stalled.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state="needs_attention" />
          {stalled.map((run) => (
            <Button
              key={run.id}
              type="button"
              variant="ghost"
              size="xs"
              className="tabular-nums"
              onClick={() => onOpenRun(run.id)}
            >
              {formatDate(run.createdAt, {
                dateStyle: "short",
                timeStyle: "short",
              })}
              {" · "}
              {t("activity.progress", {
                settled: run.settledCount,
                total: run.attemptCount,
              })}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
