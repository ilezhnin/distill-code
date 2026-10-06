// A measurement as a grid of task blocks, the way a run reads at a glance:
// one block per case with its number, its mark, its time and its spend. The
// block opens the case's evidence; its name belongs to the test management
// pages and the evidence, so a held hover is the only place the grid shows it.
import { useTranslation } from "react-i18next";
import { IconClock, IconCoin } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { formatElapsed, formatUsd } from "../lib/benchmarkLabels";
import type { AttemptSummary } from "../types";
import {
  TestStatusMark,
  testStatus,
  type TestStatus,
} from "./BenchmarkTestStatus";

export interface TaskCell {
  versionId: string;
  /** 1-based position in the pool's order. */
  number: number;
  name: string;
  /** Null for a case nobody measured yet: a gap. */
  status: TestStatus | null;
  durationMs: number | null;
  cost: number | null;
  /** The case's attempts, repetition order; the first opens the evidence. */
  attemptIds: string[];
}

/** The attempt fields a cell reads; summaries and full attempts both carry them. */
export type CellAttempt = Pick<
  AttemptSummary,
  "id" | "phase" | "outcome" | "finishedAt" | "durationMs" | "cost"
> & {
  versionId: string;
  repetition: number;
  score?: number | null;
  startedAt?: number | null;
  reason?: string | null;
  waitUntil?: number | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * One cell per case in `order`, from the attempts that measured it. A case
 * without an attempt is a gap. Time is the median repetition, spend their
 * mean, unknown when any repetition's spend is.
 */
export function taskCells(
  order: { id: string; name: string; graded?: boolean }[],
  attempts: CellAttempt[],
  runState: string | null,
): TaskCell[] {
  const byCase = new Map<string, CellAttempt[]>();
  for (const attempt of attempts) {
    const list = byCase.get(attempt.versionId) ?? [];
    list.push(attempt);
    byCase.set(attempt.versionId, list);
  }
  return order.map((version, index) => {
    const list = (byCase.get(version.id) ?? []).sort(
      (a, b) => a.repetition - b.repetition,
    );
    const scores = new Map(list.map((a) => [a.id, a.score ?? null]));
    const costs = list.map((a) => a.cost);
    return {
      versionId: version.id,
      number: index + 1,
      name: version.name,
      status:
        list.length === 0
          ? null
          : testStatus(list, scores, runState, version.graded ?? false),
      // The clock the running block showed: from its start to its finish.
      durationMs: median(
        list.flatMap((a) =>
          a.startedAt != null && a.finishedAt != null
            ? [a.finishedAt - a.startedAt]
            : a.durationMs == null
              ? []
              : [a.durationMs],
        ),
      ),
      cost:
        costs.length > 0 && costs.every((cost) => cost != null)
          ? costs.reduce((sum, cost) => sum + (cost as number), 0) /
            costs.length
          : null,
      attemptIds: list.map((a) => a.id),
    };
  });
}

/** How far a measurement got, in the counts a run view leads with. */
export function TaskSummary({ cells }: { cells: TaskCell[] }) {
  const { t } = useTranslation("benchmarks");
  const kinds = cells.map((cell) => cell.status?.kind ?? "gap");
  const count = (...which: string[]) =>
    kinds.filter((kind) => which.includes(kind)).length;
  // A graded case is finished, neither solved nor failed: the boards count
  // its mean points.
  const scored = cells.flatMap((cell) =>
    cell.status?.kind === "scored" ? [cell.status] : [],
  );
  const solved = scored.filter(
    (status) => !status.graded && status.passes === status.of,
  ).length;
  const failed =
    scored.filter((status) => !status.graded && status.passes < status.of)
      .length + count("unscored");
  const items: [string, number][] = [
    ["grid.inProgress", count("running", "judging", "waiting")],
    ["grid.finished", count("scored", "unscored")],
    ["grid.solved", solved],
    ["grid.attention", failed],
    ["grid.queued", count("queued", "gap")],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map(([key, value]) => (
        <div key={key} className="rounded-md border border-border px-3 py-2">
          <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {t(key)}
          </dt>
          <dd
            className={cn(
              "font-display text-xl tabular-nums",
              key === "grid.solved" && value > 0 && "text-success",
              key === "grid.attention" && value > 0 && "text-destructive",
            )}
          >
            {value}
            <span className="ml-1 text-xs text-muted-foreground">
              / {cells.length}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function tone(status: TestStatus | null): string {
  if (!status) return "border-dashed border-border text-muted-foreground";
  switch (status.kind) {
    case "scored":
      if (status.graded) return "border-border bg-muted/40";
      return status.passes === status.of
        ? "border-success/40 bg-success/5"
        : "border-destructive/40 bg-destructive/5";
    case "running":
    case "judging":
    case "waiting":
      return "border-chart-1/60 bg-chart-1/5";
    case "unscored":
      return "border-destructive/40 bg-destructive/5";
    default:
      return "border-border";
  }
}

/** The blocks, in pool order; a block opens its case's evidence. */
export function TaskGrid({
  cells,
  now,
  onOpen,
}: {
  cells: TaskCell[];
  now: number;
  onOpen: (cell: TaskCell) => void;
}) {
  const { t } = useTranslation("benchmarks");
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
      {cells.map((cell) => {
        const active =
          cell.status?.kind === "running" ||
          cell.status?.kind === "judging" ||
          cell.status?.kind === "waiting";
        return (
          <li key={cell.versionId}>
            <Tooltip delayDuration={TOOLTIP_DELAY.held}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={cell.attemptIds.length === 0}
                  aria-current={active ? "step" : undefined}
                  aria-label={t("grid.taskNamed", {
                    number: cell.number,
                    name: cell.name,
                  })}
                  onClick={() => onOpen(cell)}
                  className={cn(
                    "flex w-full flex-col gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    "enabled:hover:bg-muted disabled:cursor-default",
                    tone(cell.status),
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium tabular-nums">
                      {t("grid.task", { number: cell.number })}
                    </span>
                    <TestStatusMark status={cell.status} now={now} compact />
                  </span>
                  <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <IconClock className="size-3.5" aria-hidden />
                      {cell.durationMs == null
                        ? "–"
                        : formatElapsed(t, cell.durationMs)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <IconCoin className="size-3.5" aria-hidden />
                      {cell.cost == null ? "–" : formatUsd(t, cell.cost)}
                    </span>
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{cell.name}</TooltipContent>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
