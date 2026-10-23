// A measurement as a grid of task blocks, the way a run reads at a glance:
// one block per case with its number, its mark, its time and its spend. The
// block opens the case's evidence; its name belongs to the test management
// pages and the evidence, so a held hover is the only place the grid shows it.
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { replaceEqualDeep } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconClock, IconCoin } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { formatUsd } from "../lib/benchmarkLabels";
import type {
  AttemptSummary,
  AttemptActivity,
  BenchmarkVersionSummary,
  LeaderboardCohort,
  Evaluation,
} from "../types";
import {
  type DotState,
  FAILING_OUTCOMES,
  FINISHED_RUN,
  passed,
  RepetitionDots,
  TestStatusMark,
  testStatus,
  type TestStatus,
  useNow,
  WORKING,
} from "./BenchmarkTestStatus";
import { REQUIRED_REPETITIONS } from "../lib/benchmarkPlan";
import {
  activityElapsed,
  compactElapsed,
  taskActivity,
  type TaskActivity,
} from "../lib/benchmarkTaskTiming";
export { compactElapsed } from "../lib/benchmarkTaskTiming";

export interface TaskReference {
  id: string;
  name: string;
  number: number;
}

/** The pool supplies the same task numbers to model pages and individual runs. */
export function poolTaskOrder(
  versions: BenchmarkVersionSummary[],
  cohort: LeaderboardCohort | null | undefined,
): TaskReference[] {
  const pool = new Set(cohort?.versionIds ?? []);
  const classes = new Map(
    (cohort?.workClasses ?? []).map((id, index) => [id, index]),
  );
  return [...versions]
    .sort(
      (a, b) =>
        Number(pool.has(b.id)) - Number(pool.has(a.id)) ||
        (classes.get(a.manifest.workClassId) ?? 99) -
          (classes.get(b.manifest.workClassId) ?? 99) ||
        a.manifest.name.localeCompare(b.manifest.name) ||
        a.id.localeCompare(b.id),
    )
    .map((version, index) => ({
      id: version.id,
      name: version.manifest.name,
      number: index + 1,
    }));
}

export interface TaskCell {
  versionId: string;
  /** 1-based position in the pool's order. */
  number: number;
  name: string;
  /** Null for a case nobody measured yet: a gap. */
  status: TestStatus | null;
  durationMs: number | null;
  activity: TaskActivity;
  /** Whether the task can still advance. */
  clock: boolean;
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
  // An unscored test failed only on a quality outcome; one that stopped on
  // infrastructure or admission is not done yet.
  if (
    dots.includes("failed") ||
    (status?.kind === "unscored" &&
      status.outcome != null &&
      FAILING_OUTCOMES.has(status.outcome))
  )
    return "failed";
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
  /** The run that made the attempt, where cells span runs. */
  runId?: string;
  score?: number | null;
  startedAt?: number | null;
  reason?: string | null;
  waitUntil?: number | null;
  activity?: AttemptActivity | null;
  evaluations?: Evaluation[];
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The state of the run an attempt belongs to: one state for the cells of a
 * single run, a lookup by run id where cells span runs.
 */
export type RunStateOf =
  | string
  | null
  | ((runId: string | undefined) => string | null);

/**
 * One cell per case in `order`, from the attempts that measured it. A case
 * without an attempt is a gap. Measured time is the median repetition,
 * spend their mean, unknown when any repetition's spend is. Active work
 * and queue intervals remain separate from that model speed measurement.
 */
export function taskCells(
  order: { id: string; name: string; number?: number }[],
  attempts: CellAttempt[],
  runState: RunStateOf,
  minimumRepetitions = REQUIRED_REPETITIONS,
): TaskCell[] {
  const stateOf = (attempt: CellAttempt | undefined): string | null =>
    typeof runState === "function" ? runState(attempt?.runId) : runState;
  const finished = (attempt: CellAttempt) => {
    const state = stateOf(attempt);
    return state != null && FINISHED_RUN.has(state);
  };
  const byCase = new Map<string, CellAttempt[]>();
  for (const attempt of attempts) {
    // A repetition superseded by a restart, or dropped when the run's
    // window closed, is no attempt of the cell.
    if (attempt.outcome === "superseded") continue;
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
      // A rendering owed its panel works on while its run can resume; in a
      // finished run it awaits review and counts nowhere.
      if (
        WORKING.has(a.phase) ||
        a.phase === "awaiting_judges" ||
        (a.outcome === "pending_review" && !finished(a))
      )
        return "running";
      // Before its score arrives a settled attempt reads by its outcome, as
      // the ledger counts it; one that never started, was cancelled or
      // stopped on infrastructure is a gap, not a failure.
      if (a.phase !== "terminal") return "queued";
      if (a.outcome === "pass") return "passed";
      return a.outcome != null && FAILING_OUTCOMES.has(a.outcome)
        ? "failed"
        : "stopped";
    });
    while (dots.length < minimumRepetitions) dots.push("queued");
    const status =
      list.length === 0 ? null : testStatus(list, scores, stateOf(list[0]));
    const unfinished = list.some(
      (attempt) => attempt.phase !== "terminal" && !finished(attempt),
    );
    return {
      versionId: version.id,
      number: version.number ?? index + 1,
      name: version.name,
      status,
      // Both full attempts and summaries carry the same measured execution time.
      durationMs: median(
        list.flatMap((a) => (a.durationMs == null ? [] : [a.durationMs])),
      ),
      activity: taskActivity(list, unfinished),
      clock: unfinished,
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
 * The cells as the active run measuring them reads: a case the run works on
 * now is in progress, one it has queued and that has no result yet is not
 * started; a queued case with a result keeps it until the run replaces it.
 * `open` maps the run's cases to whether one of them runs now.
 */
export function withOpenCells(
  cells: TaskCell[],
  open: Map<string, boolean>,
): TaskCell[] {
  if (open.size === 0) return cells;
  return cells.map((cell) => {
    const running = open.get(cell.versionId);
    if (running == null || cell.verdict === "running") return cell;
    if (running)
      return {
        ...cell,
        status: { kind: "running", startedAt: null },
        clock: true,
        dots: cell.dots.map((_, index) => (index === 0 ? "running" : "queued")),
        verdict: "running",
      };
    if (cell.verdict !== "queued") return cell;
    return {
      ...cell,
      status: { kind: "queued" },
      dots: cell.dots.map(() => "queued"),
      verdict: "queued",
    };
  });
}

/**
 * The cases by what their dots add up to, one count per case rather than
 * per repetition: not started, in progress, passed, failed, and, when any,
 * cases whose attempts stopped before a result.
 */
export function TaskSummary({ cells }: { cells: TaskCell[] }) {
  const { t } = useTranslation("benchmarks");
  const count = (verdict: TaskCell["verdict"]) =>
    cells.filter((cell) => cell.verdict === verdict).length;
  // A case not done yet whose attempt stopped on infrastructure or
  // admission is not counted, rather than not started.
  const stopped = cells.filter(
    (cell) => cell.verdict === "queued" && cell.dots.includes("stopped"),
  ).length;
  const passed = count("solved");
  const failed = count("failed");
  const items: [string, number][] = [
    ["grid.queued", count("queued") - stopped],
    ["grid.inProgress", count("running")],
    ["grid.passed", passed],
    ["grid.attention", failed],
  ];
  if (stopped > 0) items.push(["grid.stopped", stopped]);
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
  clockAt,
  timing = "generation",
}: {
  cells: TaskCell[];
  onOpen: (cell: TaskCell) => void;
  /** A paused run holds its clocks at the recorded pause, across reopening. */
  clockAt?: number;
  /** Run details show active time; model statistics keep generation speed. */
  timing?: "generation" | "elapsed";
}) {
  // Recalculated history snapshots often contain the same settled cases.
  // Retain a case only when all its data is equal, including evidence IDs
  // and recorded activity. Keep just the committed pool, keyed across reorders.
  const previous = useRef(new Map<string, TaskCell>());
  const shared = useMemo(
    () =>
      cells.map((cell) =>
        replaceEqualDeep(previous.current.get(cell.versionId), cell),
      ),
    [cells],
  );
  useLayoutEffect(() => {
    previous.current = new Map(shared.map((cell) => [cell.versionId, cell]));
  }, [shared]);
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
      {shared.map((cell) => (
        <TaskCard
          key={cell.versionId}
          cell={cell}
          onOpen={onOpen}
          clockAt={clockAt}
          timing={timing}
        />
      ))}
    </ul>
  );
}

// A live clock belongs to its card; one running case must not redraw every
// settled case in a model's pool each second.
const TaskCard = memo(function TaskCard({
  cell,
  onOpen,
  clockAt,
  timing,
}: {
  cell: TaskCell;
  onOpen: (cell: TaskCell) => void;
  clockAt?: number;
  timing: "generation" | "elapsed";
}) {
  const { t } = useTranslation("benchmarks");
  const now = useNow(
    clockAt == null && (cell.clock || cell.status?.kind === "waiting"),
  );
  const active = cell.verdict === "running";
  const times = activityElapsed(cell.activity, clockAt ?? now);
  const actual = cell.clock || timing === "elapsed";
  const elapsed = actual ? times.execution : cell.durationMs;
  const timeHint = actual
    ? `${t(cell.activity.partial ? "grid.partialTimeHint" : "grid.totalHint")}\n${t("grid.measuredHint")}: ${
        cell.durationMs == null ? "–" : compactElapsed(cell.durationMs)
      }\n${t("grid.waited")}: ${times.waiting == null ? "–" : `${cell.activity.partial ? "≥ " : ""}${compactElapsed(times.waiting)}`}`
    : t("grid.measuredHint");
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
              "flex h-full w-full flex-col gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
              "enabled:hover:bg-muted disabled:cursor-default",
              tone(cell.verdict),
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium tabular-nums">
                {t("grid.task", { number: cell.number })}
              </span>
              <RepetitionDots
                states={cell.dots}
                animate={
                  clockAt == null &&
                  (cell.status?.kind === "running" ||
                    cell.status?.kind === "judging")
                }
              />
            </span>
            {cell.status?.kind === "waiting" ||
            cell.status?.kind === "judging" ||
            cell.status?.kind === "paused" ? (
              <TestStatusMark
                status={cell.status}
                now={clockAt ?? now}
                waitingMs={times.waiting}
                waitingPartial={cell.activity.partial}
                compact
              />
            ) : null}
            <span className="mt-auto flex items-center justify-between gap-2 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
              <span className="inline-flex items-center gap-1" title={timeHint}>
                <IconClock className="size-3.5" aria-hidden />
                {elapsed == null
                  ? "–"
                  : `${actual && cell.activity.partial ? "≥ " : ""}${compactElapsed(elapsed)}`}
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
});
