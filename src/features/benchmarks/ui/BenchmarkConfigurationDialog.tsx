import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import {
  historyKey,
  type HistorySnapshot,
  useConfigurationHistory,
} from "../hooks/useBenchmarks";
import { boardsFor, rankRows, rowKey } from "../lib/benchmarkBoards";
import {
  boardDescription,
  boardTitle,
  formatTokens,
  formatUsd,
  shortId,
} from "../lib/benchmarkLabels";
import { formatContext } from "../lib/modelCatalog";
import type {
  BenchmarkVersion,
  CatalogEntry,
  LeaderboardReport,
  LeaderboardRow,
  RunSummary,
} from "../types";
import { BenchmarkAttemptsDialog } from "./BenchmarkAttemptsDialog";
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
 * A model page in a dialog: rank and overall rating in the header, the
 * points history with every measurement selectable, every board with its
 * place and points, the facts behind the row, the vendor's list prices,
 * then the attempts as evidence.
 */
export function BenchmarkConfigurationDialog({
  row,
  report,
  runs,
  name,
  vendor,
  fact,
  versions,
  onEvidence,
  onClose,
}: {
  row: LeaderboardRow;
  report: LeaderboardReport;
  runs: RunSummary[];
  name: string;
  vendor: string;
  fact: CatalogEntry | null;
  versions: BenchmarkVersion[];
  onEvidence: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
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
            entry.row?.status === "comparable",
        ),
    [history.snapshots, key],
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selected =
    measurements.find((entry) => entry.snapshot.runId === selectedRunId) ??
    (row.status === "comparable" ? measurements.at(-1) : null) ??
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
    <BenchmarkAttemptsDialog
      title={name}
      description={vendor}
      icon={getProviderIcon(shownRow.configuration.providerId, "size-6")}
      aside={
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
      }
      attemptIds={shownRow.attemptIds}
      versions={versions}
      onEvidence={onEvidence}
      onClose={onClose}
    >
      {measurements.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <SectionHeading title={t("history.title")} />
            {selected ? (
              <span className="text-xs text-muted-foreground">
                {t("history.showing", {
                  date: formatDate(
                    selected.row.measuredAt ?? selected.snapshot.createdAt,
                    {
                      dateStyle: "medium",
                      timeStyle: "short",
                    },
                  ),
                  run: shortId(selected.snapshot.runId),
                  count: selected.row.scored,
                })}
              </span>
            ) : null}
          </div>
          <PointsHistoryChart
            points={measurements.map((entry) => ({
              id: entry.snapshot.runId,
              at: entry.row.measuredAt ?? entry.snapshot.createdAt,
              points: entry.row.points,
            }))}
            selectedId={selected?.snapshot.runId ?? null}
            onSelect={setSelectedRunId}
          />
        </section>
      ) : null}
      {shownRow.status !== "comparable" ? (
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={shownRow.status} />
          <span className="text-xs text-muted-foreground">
            {shownRow.reason}
          </span>
        </div>
      ) : null}
      <div className="grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <SectionHeading title={t("configuration.ratings")} />
            <span className="text-xs text-muted-foreground">
              {t("configuration.higherIsBetter")}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {axes.map((board) => (
              <li key={board.id} className="space-y-1.5 py-3">
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
                <p className="text-xs text-muted-foreground">
                  {board.description}
                </p>
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
    </BenchmarkAttemptsDialog>
  );
}
