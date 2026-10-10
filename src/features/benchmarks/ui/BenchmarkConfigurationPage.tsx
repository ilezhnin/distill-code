import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import {
  modelNameKey,
  useConfigurationHistory,
  useModelCatalog,
  useModelNames,
  type HistorySnapshot,
} from "../hooks/useBenchmarks";
import {
  boardShares,
  boardsFor,
  rankRows,
  rowKey,
} from "../lib/benchmarkBoards";
import { reportModels, modelKey, modelActivity } from "../lib/benchmarkModels";
import { rowOpenRun } from "../lib/benchmarkActivity";
import { catchUpCases } from "../lib/benchmarkCatchUp";
import { historyMeasurements } from "../lib/benchmarkHistory";
import {
  boardDescription,
  boardTitle,
  formatTokens,
  formatSpend,
  modelDisplayName,
  providerVendor,
  shortId,
} from "../lib/benchmarkLabels";
import { formatContext, resolveCatalogEntry } from "../lib/modelCatalog";
import type {
  BenchmarkVersion,
  LeaderboardReport,
  LeaderboardRow,
  ResultQuery,
  RunSummary,
} from "../types";
import { benchmarkKeys, useBenchmarkReleases } from "../hooks/useBenchmarks";
import { REQUIRED_REPETITIONS } from "../lib/benchmarkPlan";
import {
  TaskGrid,
  TaskSummary,
  taskCells,
  poolTaskOrder,
} from "./BenchmarkTaskGrid";
import { listByIds } from "./BenchmarkTestStatus";
import {
  BoardIcon,
  ShareMarks,
  RatingValue,
  SectionHeading,
  StateBadge,
} from "./BenchmarkPrimitives";
import { PointsHistoryChart } from "./PointsHistoryChart";

/** One board as it stands for the opened configuration in one measurement. */
interface BoardStanding {
  id: string;
  workClass: string | null;
  label: string;
  description: string;
  points: number | null;
  rank: number | null;
  of: number;
}

/** Every test result belongs to the model, regardless of execution settings. */
function rowOf(report: LeaderboardReport, key: string): LeaderboardRow | null {
  return reportModels(report).find((model) => model.key === key)?.row ?? null;
}

/** A history point's identity; older snapshots carry only their run. */
function pointId(snapshot: HistorySnapshot): string {
  return snapshot.id ?? snapshot.runId;
}

function money(value: number | null | undefined): string {
  return value == null ? "–" : `$${Number(value.toPrecision(3)).toString()}`;
}

/**
 * A model page: the rank and overall rating, the points over time with
 * every measurement selectable, every board with its place and points, the
 * facts behind the row, the vendor's list prices, then the attempts.
 */
export function BenchmarkConfigurationPage({
  row,
  report,
  runs,
  versions,
  onEvidence,
  onRun,
  onOpenRun,
}: {
  row: LeaderboardRow;
  report: LeaderboardReport;
  runs: RunSummary[];
  versions: BenchmarkVersion[];
  onEvidence: (id: string) => void;
  /** Opens this model's run dialog, following the run measuring it now. */
  onRun: (activeRunId: string | null) => void;
  /** Opens an unfinished run that already covers some of the gaps. */
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const releases = useBenchmarkReleases();
  const releaseMarks = useMemo(
    () =>
      releases.map((release) => ({
        id: release.id,
        name: release.name,
        at: release.createdAt,
      })),
    [releases],
  );
  const { formatDate } = useLocaleFormatting();
  const names = useModelNames();
  const catalog = useModelCatalog();
  const key = modelKey(row.configuration);
  const history = useConfigurationHistory(row.configuration, true);
  const measurements = useMemo(
    () => historyMeasurements(history.snapshots, key, false, true),
    [history.snapshots, key],
  );
  const [selection, setSelection] = useState<{
    id: string;
    runId: string;
  } | null>(null);
  // An unfinished run's point moves forward as more cells settle, so a
  // selection that vanished follows its run, else the newest point.
  const selected = selection
    ? (measurements.find((entry) => pointId(entry.snapshot) === selection.id) ??
      [...measurements]
        .reverse()
        .find((entry) => entry.snapshot.runId === selection.runId) ??
      measurements.at(-1) ??
      null)
    : null;
  const select = (id: string | null) => {
    const entry = measurements.find((point) => pointId(point.snapshot) === id);
    setSelection(
      entry
        ? { id: pointId(entry.snapshot), runId: entry.snapshot.runId }
        : null,
    );
  };
  // History changes the page only after an explicit point selection.
  const shownReport = selected?.report ?? report;
  const shownRow = selected?.row ?? rowOf(report, key) ?? row;
  // A point is dated by its observation, not by later evidence it borrows.
  const shownAt = selected ? selected.snapshot.createdAt : shownRow.measuredAt;
  // The attempts that measured something: a cell kept only for its spend,
  // such as a call the provider refused, is no result to list.
  const results = shownRow.resultAttemptIds ?? shownRow.attemptIds;
  const attemptQuery: ResultQuery = { attemptIds: results };
  // Every standing attempt as blocks, one per pool case in board order: a
  // case measured once shows that one repetition, a case never run is a gap.
  const standing = shownRow.attemptIds;
  const summaries = useQuery({
    queryKey: [...benchmarkKeys, "cells", attemptQuery, standing],
    // Current verdicts match the chart's recalculation of the same evidence.
    queryFn: () => listByIds(standing, attemptQuery.asOf ?? null),
    enabled: standing.length > 0,
  });
  const cells = useMemo(() => {
    const pool = new Set(shownReport.cohort?.versionIds ?? []);
    // Use the service's eligible cases, just like the counters and ratings.
    // Author-excluded cases are not unmeasured tasks for this model.
    const eligible = new Set([
      ...shownRow.scoredVersionIds,
      ...shownRow.missingVersionIds,
      ...(shownRow.unsupportedVersionIds ?? []),
    ]);
    const order = poolTaskOrder(versions, shownReport.cohort).filter(
      (version) => pool.has(version.id) && eligible.has(version.id),
    );
    return taskCells(order, summaries.data ?? [], null);
  }, [
    shownReport.cohort,
    shownRow.scoredVersionIds,
    shownRow.missingVersionIds,
    shownRow.unsupportedVersionIds,
    versions,
    summaries.data,
  ]);
  const catchUp = useMemo(() => catchUpCases(row, runs), [row, runs]);
  const activity = useMemo(
    () => modelActivity({ key, row, configurations: [] }, runs),
    [key, row, runs],
  );
  // The run the dialog starts from: the one measuring the model now, else
  // its newest run whose window is still open.
  const open = useMemo(() => rowOpenRun(row, runs, Date.now()), [row, runs]);
  const dialogRunId = activity.runId ?? open?.id ?? null;
  const queuedRunId = catchUp.queuedRunId;
  // The run measuring this model now, else one that plans its gaps.
  const openRunId = activity.runId ?? queuedRunId;
  const statusHint = t(
    `configuration.statusHint.${selected ? "retrospective" : shownRow.status}`,
    { defaultValue: "" },
  );
  const standings: BoardStanding[] = useMemo(() => {
    const boards = boardsFor(shownReport.cohort);
    return boards.map((board) => {
      const rows = reportModels(shownReport).map((model) =>
        model.key === modelKey(shownRow.configuration) ? shownRow : model.row,
      );
      const ranked = rankRows(rows, board);
      const entry = ranked.find(
        (result) => rowKey(result.row) === rowKey(shownRow),
      );
      return {
        id: board.id,
        workClass: board.workClass,
        label: boardTitle(t, board),
        description: boardDescription(t, board),
        points: entry?.points ?? null,
        rank: entry?.rank ?? null,
        of: ranked.filter((result) => result.rank != null).length,
      };
    });
  }, [shownReport, shownRow, t]);
  const overall = standings.find((board) => board.id === "overall");
  const axes = standings.filter((board) => board.id !== "overall");
  const modelName =
    shownRow.configuration.modelName ??
    names.get(modelNameKey(shownRow.configuration));
  const fact = resolveCatalogEntry(
    catalog,
    shownRow.configuration,
    modelName,
    shownAt ?? report.cohort?.newestRunAt,
  );
  const name =
    fact?.displayName ?? modelDisplayName(shownRow.configuration, modelName);
  const vendor =
    fact?.vendor ?? providerVendor(shownRow.configuration.providerId);
  const specs: [string, string][] = [
    [t("configuration.apiModelId"), shownRow.configuration.modelId],
    // What the id ran as, by the attempts' own usage: an alias names its
    // target, and more than one means the id moved between models.
    [
      t("fields.resolvedModel"),
      shownRow.resolvedModels?.length
        ? shownRow.resolvedModels.join(", ")
        : t("unknown"),
    ],
    [t("fields.provider"), shownRow.configuration.providerId],
    [
      t("configuration.context"),
      formatContext(fact?.contextTokens) ?? t("unknown"),
    ],
    [t("configuration.cases"), `${shownRow.scored} / ${shownRow.planned}`],
    // Attempts out of every case's three: the unit the grid counts in.
    [
      t("configuration.attempts"),
      `${results.length} / ${shownRow.planned * REQUIRED_REPETITIONS}`,
    ],
    [
      t("configuration.measured"),
      shownAt == null
        ? t("unknown")
        : formatDate(shownAt, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
    ],
    [
      t("configuration.spend"),
      formatSpend(t, shownRow.cost, shownRow.medianOutputTokens),
    ],
    [
      t("configuration.outputTokens"),
      formatTokens(t, shownRow.medianOutputTokens),
    ],
  ];
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted">
            {getProviderIcon(shownRow.configuration.providerId, "size-6")}
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-2xl font-medium tracking-tight">
              {name}
            </h2>
            <p className="text-sm text-muted-foreground">{vendor}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-8">
          <dl className="flex gap-8 text-right">
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("configuration.rankLabel")}
              </dt>
              <dd className="font-display text-2xl tabular-nums">
                {overall?.rank == null ? (
                  <span className="text-muted-foreground">–</span>
                ) : (
                  <>
                    <span className={cn(overall.rank === 1 && "text-chart-1")}>
                      {overall.rank}
                    </span>
                    <span className="ml-1 text-sm text-muted-foreground">
                      {t("configuration.of", { of: overall.of })}
                    </span>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("configuration.ratingLabel")}
              </dt>
              <dd className="font-display text-2xl tabular-nums">
                <RatingValue
                  points={overall?.points ?? null}
                  row={shownRow}
                  board={{ workClass: null }}
                />
              </dd>
              {overall?.points != null ? (
                <ShareMarks
                  className="justify-end"
                  shares={boardShares(shownRow, { workClass: null })}
                />
              ) : null}
            </div>
          </dl>
          <Button
            type="button"
            size="sm"
            leftIcon={<IconPlayerPlay />}
            onClick={() => onRun(dialogRunId)}
          >
            {t("configuration.run")}
          </Button>
          {openRunId ? (
            <Tooltip delayDuration={TOOLTIP_DELAY.held}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t("configuration.queued", {
                    id: shortId(openRunId),
                  })}
                  // A run measuring the model now opens the model's own run
                  // view; a waiting run opens with its controls.
                  onClick={() =>
                    activity.runId
                      ? onRun(activity.runId)
                      : onOpenRun(openRunId)
                  }
                >
                  {activity.running > 0 ? (
                    <Spinner decorative className="size-3.5 text-chart-1" />
                  ) : null}
                  {activity.open > 0
                    ? t(
                        activity.running > 0
                          ? "activity.running"
                          : "activity.left",
                      )
                    : t("configuration.queuedShort")}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("configuration.queued", { id: shortId(openRunId) })}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>
      {measurements.length > 0 ? (
        <section aria-label={t("history.title")}>
          <PointsHistoryChart
            releases={releaseMarks}
            points={measurements.map((entry) => {
              // A point counts only the cases finished by its date; the
              // cases its recalculation borrows from later cells are named
              // apart, never as measured then.
              const backfilled =
                entry.snapshot.backfilledVersionIds?.length ?? 0;
              return {
                id: pointId(entry.snapshot),
                at: entry.snapshot.createdAt,
                points: entry.row.points,
                series: entry.series,
                scored: entry.row.scored - backfilled,
                planned: entry.row.planned,
                backfilled,
                revised: entry.snapshot.revisedVersionIds?.length ?? 0,
              };
            })}
            selectedId={selected ? pointId(selected.snapshot) : null}
            onSelect={select}
          />
        </section>
      ) : null}
      {selected ? (
        <Button variant="outline" size="sm" onClick={() => select(null)}>
          {t("configuration.current")}
        </Button>
      ) : null}
      {!["comparable", "preliminary", "untested"].includes(shownRow.status) ? (
        <div className="flex flex-wrap items-center gap-2">
          {statusHint ? (
            <Tooltip delayDuration={TOOLTIP_DELAY.held}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <StateBadge state={shownRow.status} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-72">
                {statusHint}
              </TooltipContent>
            </Tooltip>
          ) : (
            <StateBadge state={shownRow.status} />
          )}
        </div>
      ) : null}
      <div className="grid gap-10 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <SectionHeading title={t("configuration.ratings")} />
            <span className="text-xs text-muted-foreground">
              {t("configuration.higherIsBetter")}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {axes.map((board) => (
              <li key={board.id} className="py-3">
                <div className="flex items-center gap-4">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <BoardIcon
                      board={board}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 font-medium leading-tight">
                      {board.label}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <ShareMarks shares={boardShares(shownRow, board)} />
                  </div>
                  <RatingValue
                    points={board.points}
                    row={shownRow}
                    board={board}
                    className={cn(
                      "w-14 shrink-0 text-right font-display text-lg font-semibold tabular-nums",
                      board.rank === 1 && "text-chart-1",
                      board.points == null && "text-muted-foreground",
                    )}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-4">
          <SectionHeading title={t("configuration.specs")} />
          <dl className="divide-y divide-border text-sm">
            {specs.map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-4 py-2"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      {fact?.inputPerMillion != null || fact?.outputPerMillion != null ? (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <SectionHeading title={t("configuration.pricing")} />
            <span className="text-xs text-muted-foreground">
              {t("configuration.perMillion")}
            </span>
          </div>
          <dl className="grid grid-cols-3 gap-6">
            {[
              [t("configuration.input"), fact?.inputPerMillion],
              [t("configuration.cachedInput"), fact?.cacheReadPerMillion],
              [t("configuration.output"), fact?.outputPerMillion],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {label}
                </dt>
                <dd className="font-display text-2xl tabular-nums">
                  {money(value as number | null | undefined)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {fact?.cacheWritePerMillion != null
              ? `${t("configuration.cacheWrites", { price: money(fact.cacheWritePerMillion) })} · `
              : ""}
            {t("configuration.source", {
              source: fact?.source || t("unknown"),
              date: formatDate(fact?.checkedAt ?? 0, { dateStyle: "medium" }),
            })}
          </p>
        </section>
      ) : null}
      <section className="space-y-4">
        <SectionHeading
          title={t("grid.title", {
            cases: cells.length,
            attempts: cells.reduce((sum, cell) => sum + cell.dots.length, 0),
          })}
        />
        <TaskSummary cells={cells} />
        <TaskGrid
          cells={cells}
          onOpen={(cell) => onEvidence(cell.attemptIds[0])}
        />
      </section>
    </div>
  );
}
