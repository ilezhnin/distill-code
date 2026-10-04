import { useTranslation } from "react-i18next";
import { Progress } from "@/shared/ui/progress";
import { Spinner } from "@/shared/ui/spinner";
import { modelNameKey, useModelNames } from "../hooks/useBenchmarks";
import {
  activeRuns,
  runProgress,
  runningConfigurations,
} from "../lib/benchmarkActivity";
import { modelDisplayName } from "../lib/benchmarkLabels";
import type { RunSummary } from "../types";
import { StateBadge } from "./BenchmarkPrimitives";

/** Runs with work left: their progress, the models running now, and a way in. */
export function BenchmarkActivity({
  runs,
  onOpenRun,
}: {
  runs: RunSummary[];
  onOpenRun: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const names = useModelNames();
  const active = activeRuns(runs);
  if (active.length === 0) return null;
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
    </section>
  );
}
