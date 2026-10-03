import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft } from "@tabler/icons-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import {
  type HistorySnapshot,
  historyKey,
  modelNameKey,
  useConfigurationHistory,
  useModelCatalog,
  useModelNames,
} from "../hooks/useBenchmarks";
import { boardsFor, rankRows, rowKey } from "../lib/benchmarkBoards";
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
  RunSummary,
} from "../types";
import { BenchmarkAttemptList } from "./BenchmarkAttemptList";
import {
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

/** The row of a configuration inside a report: the best-covered one when runtimes differ. */
function rowOf(report: LeaderboardReport, key: string): LeaderboardRow | null {
  return (
    report.rows
      .filter((row) => historyKey(row.configuration) === key)
      .sort((a, b) => b.scored - a.scored)[0] ?? null
  );
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
  onBack,
}: {
  row: LeaderboardRow;
  report: LeaderboardReport;
  runs: RunSummary[];
  versions: BenchmarkVersion[];
  onEvidence: (id: string) => void;
  /** Starts a run over the given cases, for the gaps this row has. */
  onRun: (versionIds: string[]) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const names = useModelNames();
  const catalog = useModelCatalog();
  const key = historyKey(row.configuration);
  const history = useConfigurationHistory(runs);
  const measurements = useMemo(
    () =>
      history.snapshots
        .map((snapshot) => ({ snapshot, row: rowOf(snapshot.report, key) }))
        .filter(
          (
            entry,
          ): entry is { snapshot: HistorySnapshot; row: LeaderboardRow } =>
            entry.row?.points != null,
        ),
    [history.snapshots, key],
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selected =
    measurements.find((entry) => entry.snapshot.runId === selectedRunId) ??
    measurements.at(-1) ??
    null;
  // The chosen measurement drives everything below the chart; the cohort row
  // stands in until the history has loaded.
  const shownReport = selected?.snapshot.report ?? report;
  const shownRow = selected?.row ?? rowOf(report, key) ?? row;
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
    shownRow.measuredAt ?? report.cohort?.newestRunAt,
  );
  const name =
    fact?.displayName ?? modelDisplayName(shownRow.configuration, modelName);
  const vendor =
    fact?.vendor ?? providerVendor(shownRow.configuration.providerId);
  const specs: [string, string][] = [
    [t("configuration.apiModelId"), shownRow.configuration.modelId],
    [t("fields.provider"), shownRow.configuration.providerId],
    [t("fields.effort"), shownRow.configuration.effort ?? t("unknown")],
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
      shownRow.measuredAt == null
        ? t("unknown")
        : formatDate(shownRow.measuredAt, {
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
      <Button
        type="button"
        variant="ghost"
        flush
        leftIcon={<IconChevronLeft />}
        onClick={onBack}
      >
        {t("configuration.back")}
      </Button>
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
        <dl className="flex shrink-0 gap-8 text-right">
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
      </header>
      {measurements.length > 0 ? (
        <PointsHistoryChart
          points={measurements.map((entry) => ({
            id: entry.snapshot.runId,
            at: entry.row.measuredAt ?? entry.snapshot.createdAt,
            points: entry.row.points,
          }))}
          selectedId={selected?.snapshot.runId ?? null}
          onSelect={setSelectedRunId}
        />
      ) : null}
      {shownRow.status !== "comparable" ? (
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={shownRow.status} />
          <span className="text-xs text-muted-foreground">
            {shownRow.reason}
          </span>
        </div>
      ) : null}
      {row.missingVersionIds.length > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRun(row.missingVersionIds)}
        >
          {t("configuration.catchUp", { count: row.missingVersionIds.length })}
        </Button>
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
            query={{ attemptIds: shownRow.attemptIds }}
            versions={versions}
            onEvidence={onEvidence}
          />
        )}
      </section>
    </div>
  );
}
