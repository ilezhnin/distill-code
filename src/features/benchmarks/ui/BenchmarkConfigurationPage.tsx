import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft, IconPlayerPlay } from "@tabler/icons-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { toggleVariants } from "@/shared/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import {
  historyKey,
  modelNameKey,
  useConfigurationHistory,
  useModelCatalog,
  useModelNames,
  type HistorySnapshot,
} from "../hooks/useBenchmarks";
import { boardsFor, rankRows, rowKey } from "../lib/benchmarkBoards";
import { catchUpCases } from "../lib/benchmarkCatchUp";
import { explicitEffort } from "../lib/benchmarkEffort";
import { historyMeasurements } from "../lib/benchmarkHistory";
import {
  boardDescription,
  boardTitle,
  formatTokens,
  formatUsd,
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
import { BenchmarkAttemptList } from "./BenchmarkAttemptList";
import {
  BenchmarkToolbar,
  BoardIcon,
  ScoreBar,
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
  share: number | null;
}

/** Runtime revisions share a leaderboard identity. */
function rowOf(report: LeaderboardReport, key: string): LeaderboardRow | null {
  return (
    report.rows
      .filter((row) => historyKey(row.configuration) === key)
      .sort((a, b) => b.scored - a.scored)[0] ?? null
  );
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
  onBack,
  actions,
}: {
  row: LeaderboardRow;
  report: LeaderboardReport;
  runs: RunSummary[];
  versions: BenchmarkVersion[];
  onEvidence: (id: string) => void;
  /** Starts a run over the given cases, for the gaps this row has. */
  onRun: (versionIds: string[]) => void;
  /** Opens an unfinished run that already covers some of the gaps. */
  onOpenRun: (runId: string) => void;
  onBack: () => void;
  /** The page actions, on the right of the back row. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const names = useModelNames();
  const catalog = useModelCatalog();
  const key = historyKey(row.configuration);
  const history = useConfigurationHistory(row.configuration);
  const [preferRecorded, setRecorded] = useState(false);
  const recalculatedPoints = useMemo(
    () => historyMeasurements(history.snapshots, key, false),
    [history.snapshots, key],
  );
  const recordedPoints = useMemo(
    () => historyMeasurements(history.snapshots, key, true),
    [history.snapshots, key],
  );
  // Only a mode with measurements is offered; an empty one never blanks the chart.
  const modes = [false, true].filter(
    (mode) => (mode ? recordedPoints : recalculatedPoints).length > 0,
  );
  const recorded = modes.includes(preferRecorded)
    ? preferRecorded
    : (modes[0] ?? preferRecorded);
  const measurements = recorded ? recordedPoints : recalculatedPoints;
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
  // A dated point lists the verdicts that stood at its date.
  const attemptQuery: ResultQuery =
    recorded && selected
      ? { attemptIds: shownRow.attemptIds, asOf: selected.snapshot.createdAt }
      : { attemptIds: shownRow.attemptIds };
  const catchUp = useMemo(() => catchUpCases(row, runs), [row, runs]);
  // Every case of the current pool this configuration is measured on,
  // including those its provider refused, which only a whole run asks again.
  const pool = useMemo(
    () => [
      ...new Set([
        ...row.scoredVersionIds,
        ...row.missingVersionIds,
        ...(row.unsupportedVersionIds ?? []),
      ]),
    ],
    [row],
  );
  const queuedRunId = catchUp.queuedRunId;
  // Missing cases first; with none missing and none queued, the whole pool again.
  const runCases =
    catchUp.owed.length > 0 ? catchUp.owed : queuedRunId ? [] : pool;
  const runAction =
    catchUp.owed.length > 0
      ? t("configuration.catchUp", { count: catchUp.owed.length })
      : t("configuration.runAgain", { count: pool.length });
  const statusHint = t(
    `configuration.statusHint.${selected && !recorded ? "retrospective" : shownRow.status}`,
    { defaultValue: "" },
  );
  const standings: BoardStanding[] = useMemo(() => {
    const boards = boardsFor(shownReport.cohort);
    return boards.map((board) => {
      const ranked = rankRows(shownReport.rows, board);
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
        share: entry?.share ?? null,
      };
    });
  }, [shownReport, shownRow, t]);
  const overall = standings.find((board) => board.id === "overall");
  const axes = standings.filter((board) => board.id !== "overall");
  const place = (board: BoardStanding | undefined) =>
    board?.rank == null
      ? t("configuration.notRanked")
      : t("configuration.rank", { rank: board.rank, of: board.of });
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
    // A model without an effort control has none; the CLI's "default" is
    // no level and never printed as one.
    [
      t("fields.effort"),
      explicitEffort(shownRow.configuration.effort) ??
        (shownRow.configuration.effort ? t("unknown") : t("run.noEffort")),
    ],
    [
      t("fields.fastMode"),
      shownRow.configuration.fastMode == null
        ? t("unknown")
        : shownRow.configuration.fastMode
          ? t("enabled")
          : t("disabled"),
    ],
    [
      t("configuration.runtime"),
      shownRow.configuration.inventoryRevision
        ? shortId(shownRow.configuration.inventoryRevision)
        : t("unknown"),
    ],
    [
      t("configuration.context"),
      formatContext(fact?.contextTokens) ?? t("unknown"),
    ],
    [t("configuration.cases"), `${shownRow.scored} / ${shownRow.planned}`],
    [
      t("configuration.measured"),
      shownAt == null
        ? t("unknown")
        : formatDate(shownAt, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
    ],
    [t("configuration.spend"), formatUsd(t, shownRow.cost)],
    [
      t("configuration.outputTokens"),
      formatTokens(t, shownRow.medianOutputTokens),
    ],
  ];
  return (
    <div className="space-y-8">
      <BenchmarkToolbar actions={actions}>
        <Button
          type="button"
          variant="ghost"
          flush
          leftIcon={<IconChevronLeft />}
          onClick={onBack}
        >
          {t("configuration.back")}
        </Button>
      </BenchmarkToolbar>
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
                {overall?.points ?? "–"}
              </dd>
            </div>
          </dl>
          {runCases.length > 0 ? (
            <Tooltip delayDuration={TOOLTIP_DELAY.held}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  leftIcon={<IconPlayerPlay />}
                  aria-label={runAction}
                  onClick={() => onRun(runCases)}
                >
                  {t("configuration.run")}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{runAction}</TooltipContent>
            </Tooltip>
          ) : null}
          {queuedRunId ? (
            <Tooltip delayDuration={TOOLTIP_DELAY.held}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t("configuration.queued", {
                    id: shortId(queuedRunId),
                  })}
                  onClick={() => onOpenRun(queuedRunId)}
                >
                  {t("configuration.queuedShort")}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("configuration.queued", { id: shortId(queuedRunId) })}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>
      {modes.length > 0 ? (
        <section aria-label={t("history.title")}>
          <PointsHistoryChart
            toolbar={
              <div className="flex items-center gap-0.5">
                {modes.map((mode) => (
                  <Tooltip
                    key={String(mode)}
                    delayDuration={TOOLTIP_DELAY.held}
                  >
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-pressed={recorded === mode}
                        data-state={recorded === mode ? "on" : "off"}
                        className={cn(
                          toggleVariants({ size: "sm" }),
                          "h-7 px-2.5 text-xs",
                        )}
                        onClick={() => {
                          setRecorded(mode);
                          setSelection(null);
                        }}
                      >
                        {t(mode ? "history.recorded" : "history.recalculated")}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-72">
                      {t(
                        mode
                          ? "history.recordedDescription"
                          : "history.recalculatedDescription",
                      )}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            }
            points={measurements.map((entry) => ({
              id: pointId(entry.snapshot),
              at: entry.snapshot.createdAt,
              points: entry.row.points,
              series: entry.series,
              scored: entry.row.scored,
              planned: entry.row.planned,
              backfilled: recorded
                ? 0
                : (entry.snapshot.backfilledVersionIds?.length ?? 0),
              revised: recorded
                ? 0
                : (entry.snapshot.revisedVersionIds?.length ?? 0),
            }))}
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
      {shownRow.status !== "comparable" ? (
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
                  <div className="flex w-52 shrink-0 items-center gap-2">
                    <BoardIcon
                      board={board}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0">
                      <div className="font-medium leading-tight">
                        {board.label}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {place(board)}
                      </div>
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    {board.share != null ? (
                      <ScoreBar
                        share={board.share}
                        leading={board.rank === 1}
                        label={`${board.label}: ${board.points ?? "–"}`}
                      />
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "w-14 shrink-0 text-right font-display text-lg font-semibold tabular-nums",
                      board.rank === 1 && "text-chart-1",
                      board.points == null && "text-muted-foreground",
                    )}
                  >
                    {board.points ?? "–"}
                  </span>
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
      <section className="space-y-3">
        <SectionHeading
          title={t("attempts.title", { count: shownRow.attemptIds.length })}
        />
        {shownRow.attemptIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("results.empty")}</p>
        ) : (
          <BenchmarkAttemptList
            query={attemptQuery}
            versions={versions}
            resetKey={`${recorded}:${selection?.id ?? "current"}`}
            onEvidence={onEvidence}
          />
        )}
      </section>
    </div>
  );
}
