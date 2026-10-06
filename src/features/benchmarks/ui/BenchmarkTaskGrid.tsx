// A measurement as a grid of task blocks, the way a run reads at a glance:
// one block per case with its number, its mark, its time and its spend. The
// block opens the case's evidence; its name belongs to the test management
// pages and the evidence, so a held hover is the only place the grid shows it.
import { useTranslation } from "react-i18next";
import { IconClock, IconCoin } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { formatUsd } from "../lib/benchmarkLabels";
import type { AttemptSummary } from "../types";
import {
  type DotState,
  passed,
  RepetitionDots,
  TestStatusMark,
  testStatus,
  type TestStatus,
  WORKING,
} from "./BenchmarkTestStatus";
import { REQUIRED_REPETITIONS } from "../lib/benchmarkPlan";

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
  /** One dot per repetition the measurement needs, in repetition order. */
  dots: DotState[];
  /**
   * What the dots add up to: solved once every needed repetition passed,
   * failed once any did not, running while one works, else not done yet,
   * a single pass included.
   */
  verdict: "queued" | "running" | "solved" | "failed";
}

function verdictOf(
  dots: DotState[],
  status: TestStatus | null,
): TaskCell["verdict"] {
  if (dots.includes("running") || status?.kind === "waiting") return "running";
  if (dots.includes("failed") || status?.kind === "unscored") return "failed";
  if (dots.length > 0 && dots.every((dot) => dot === "passed")) return "solved";
  return "queued";
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

/** A block's clock: seconds under a minute, else m:ss, else h:mm:ss. */
export function compactElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  if (minutes > 0) return `${minutes}:${pad(seconds)}`;
  return `${seconds} s`;
}

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
  order: { id: string; name: string }[],
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
    const dots: DotState[] = list.map((a) => {
      const score = a.score ?? null;
      if (score != null) return passed(score) ? "passed" : "failed";
      if (
        WORKING.has(a.phase) ||
        a.phase === "awaiting_judges" ||
        a.outcome === "pending_review"
      )
        return "running";
      // Before its score arrives a settled attempt reads by its outcome; one
      // that never started, or was cancelled, never did.
      if (a.phase !== "terminal" || a.outcome == null) return "queued";
      if (a.outcome === "pass") return "passed";
      return a.outcome === "cancelled" ? "queued" : "failed";
    });
    while (dots.length < REQUIRED_REPETITIONS) dots.push("queued");
    const status =
      list.length === 0 ? null : testStatus(list, scores, runState);
    return {
      versionId: version.id,
      number: index + 1,
      name: version.name,
      status,
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
      dots,
      verdict: verdictOf(dots, status),
    };
  });
}

/**
 * How far a measurement got, in attempts: every case needs three, so the
 * tiles count dots out of cases times three. Cases are counted elsewhere,
 * out of the pool; the two units never share a tile.
 */
export function TaskSummary({ cells }: { cells: TaskCell[] }) {
  const { t } = useTranslation("benchmarks");
  const dots = cells.flatMap((cell) => cell.dots);
  const count = (state: DotState) => dots.filter((dot) => dot === state).length;
  const passed = count("passed");
  const failed = count("failed");
  const items: [string, number][] = [
    ["grid.inProgress", count("running")],
    ["grid.finished", passed + failed],
    ["grid.passed", passed],
    ["grid.attention", failed],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([key, value]) => (
        <div key={key} className="rounded-md border border-border px-3 py-2">
          <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {t(key)}
          </dt>
          <dd
            className={cn(
              "font-display text-xl tabular-nums",
              key === "grid.passed" && value > 0 && "text-success",
              key === "grid.attention" && value > 0 && "text-destructive",
            )}
          >
            {value}
            <span className="ml-1 text-xs text-muted-foreground">
              / {dots.length}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The frame reads the whole case the way its dots read each repetition: grey
 * until it starts, blue while it works, green solved, red failed.
 */
function tone(verdict: TaskCell["verdict"]): string {
  switch (verdict) {
    case "solved":
      return "border-success/50 bg-success/5";
    case "failed":
      return "border-destructive/50 bg-destructive/5";
    case "running":
      return "border-info/60 bg-info/5";
    default:
      return "border-muted-foreground/30 text-muted-foreground";
  }
}

/** The blocks, in pool order; a block opens its case's evidence. */
export function TaskGrid({
  cells,
  onOpen,
}: {
  cells: TaskCell[];
  onOpen: (cell: TaskCell) => void;
}) {
  const { t } = useTranslation("benchmarks");
  // A waiting block names its next try against the time it is drawn at.
  const now = Date.now();
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
      {cells.map((cell) => {
        const active = cell.verdict === "running";
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
                    tone(cell.verdict),
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium tabular-nums">
                      {t("grid.task", { number: cell.number })}
                    </span>
                    <RepetitionDots states={cell.dots} />
                  </span>
                  {cell.status?.kind === "waiting" ? (
                    // A wait says what it is and how long, in the clock's place.
                    <TestStatusMark status={cell.status} now={now} compact />
                  ) : (
                    <span className="flex items-center justify-between gap-2 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <IconClock className="size-3.5" aria-hidden />
                        {cell.durationMs == null
                          ? "–"
                          : compactElapsed(cell.durationMs)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <IconCoin className="size-3.5" aria-hidden />
                        {cell.cost == null ? "–" : formatUsd(t, cell.cost)}
                      </span>
                    </span>
                  )}
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
