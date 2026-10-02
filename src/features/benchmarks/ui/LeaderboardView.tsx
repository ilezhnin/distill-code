import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { DisclosureButton } from "@/shared/ui/disclosure-button";
import { SearchBar } from "@/shared/ui/SearchBar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { modelNameKey, useModelNames } from "../hooks/useBenchmarks";
import {
  boardsFor,
  rankRows,
  rowKey,
  type Board,
  type BoardId,
  type RankedRow,
} from "../lib/benchmarkBoards";
import {
  configurationOrigin,
  formatQuality,
  formatSeconds,
  formatTokens,
  formatUsd,
  modelDisplayName,
  workClassLabel,
} from "../lib/benchmarkLabels";
import type {
  BenchmarkVersion,
  Configuration,
  LeaderboardReport,
  LeaderboardRow,
} from "../types";
import { BenchmarkConfigurationDialog } from "./BenchmarkConfigurationDialog";
import {
  AxisBars,
  BenchmarkEmpty,
  BenchmarkPager,
  FilterMenu,
  ModelIdentity,
  ScoreBar,
  StateBadge,
  type Option,
} from "./BenchmarkPrimitives";
import type { ResultScope } from "./BenchmarksView";

interface Props {
  report: LeaderboardReport | undefined;
  loading: boolean;
  scope: ResultScope;
  onScopeChange: (scope: ResultScope) => void;
  suiteOptions: Option[];
  runOptions: Option[];
  versions: BenchmarkVersion[];
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onEvidence: (id: string) => void;
}

const MotionRow = motion.create(TableRow);

function distinct(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

/** Rows that differ only by runtime revision need the revision to tell them apart. */
function twinKey(configuration: Configuration): string {
  return [
    configuration.providerId,
    configuration.modelId,
    configuration.effort ?? "",
    String(configuration.fastMode),
  ].join("/");
}

export function LeaderboardView({
  report,
  loading,
  scope,
  onScopeChange,
  suiteOptions,
  runOptions,
  versions,
  page,
  pageSize,
  onPageChange,
  onEvidence,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const reduceMotion = useReducedMotion();
  const names = useModelNames();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [effort, setEffort] = useState("all");
  const [fast, setFast] = useState("all");
  const [track, setTrack] = useState("all");
  const [view, setView] = useState<"chart" | "table">("chart");
  const [boardId, setBoardId] = useState<BoardId>("overall");
  const [unrankedOpen, setUnrankedOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => report?.rows ?? [], [report]);
  const cohort = report?.cohort;
  const boards = useMemo(() => boardsFor(cohort), [cohort]);
  const board = boards.find((entry) => entry.id === boardId) ?? boards[0];
  const nameOf = (row: LeaderboardRow) =>
    modelDisplayName(
      row.configuration,
      names.get(modelNameKey(row.configuration)),
    );
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          `${modelDisplayName(row.configuration, names.get(modelNameKey(row.configuration)))} ${row.configuration.modelId} ${configurationOrigin(row.configuration)}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()) &&
          (provider === "all" || row.configuration.providerId === provider) &&
          (effort === "all" || row.configuration.effort === effort) &&
          (fast === "all" || String(row.configuration.fastMode) === fast) &&
          (track === "all" || row.configuration.executionProfile === track),
      ),
    [rows, names, query, provider, effort, fast, track],
  );
  const ranked = useMemo(() => rankRows(visible, board), [visible, board]);
  const rankedRows = useMemo(
    () => ranked.filter((entry) => entry.rank != null),
    [ranked],
  );
  const unranked = ranked.filter((entry) => entry.rank == null);
  // Nothing ranked yet means nothing to hide behind.
  const showUnranked = unrankedOpen || rankedRows.length === 0;
  const shown = showUnranked ? ranked : rankedRows;
  // Every board's share per row feeds the small profile bars.
  const shares = useMemo(
    () =>
      new Map(
        boards.map((entry) => [
          entry.id,
          new Map(
            rankRows(visible, entry).map((result) => [
              rowKey(result.row),
              result.share,
            ]),
          ),
        ]),
      ),
    [boards, visible],
  );
  const twins = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of shown) {
      const key = twinKey(entry.row.configuration);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [shown]);
  const selectedRow = rows.find((row) => rowKey(row) === selected) ?? null;
  const scored = rows.filter((row) => row.status === "comparable").length;
  const measuredAt = rows.reduce<number | null>(
    (latest, row) =>
      row.measuredAt != null && (latest == null || row.measuredAt > latest)
        ? row.measuredAt
        : latest,
    null,
  );
  const transition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 38 };
  const boardLabel = (entry: Board) =>
    entry.workClass
      ? workClassLabel(t, entry.workClass)
      : t(`leaderboard.boards.${entry.id}`);
  const boardDescription = (entry: Board) =>
    entry.workClass
      ? t("leaderboard.boardDescriptions.class", {
          label: workClassLabel(t, entry.workClass),
        })
      : t(`leaderboard.boardDescriptions.${entry.id}`);
  const formatValue = (entry: Board, value: number | null) => {
    if (value == null) return "–";
    if (entry.id === "efficiency") return formatTokens(t, value);
    if (entry.id === "speed") return formatSeconds(t, value);
    if (entry.id === "cost") return formatUsd(t, value);
    return formatQuality(t, value);
  };
  const facet = (
    label: string,
    value: string,
    set: (value: string) => void,
    values: string[],
    labelFor: (value: string) => string = (value) => value,
  ) =>
    values.length > 1 ? (
      <FilterMenu
        label={label}
        value={value}
        onChange={set}
        options={[
          { value: "all", label: `${label}: ${t("all")}` },
          ...values.map((entry) => ({ value: entry, label: labelFor(entry) })),
        ]}
      />
    ) : null;
  const rankCell = (entry: RankedRow) => (
    <TableCell
      className={cn(
        "w-10 font-display text-lg tabular-nums",
        entry.rank === 1
          ? "text-chart-1"
          : entry.rank == null && "text-muted-foreground",
      )}
    >
      {entry.rank ?? "–"}
    </TableCell>
  );
  const modelCell = (entry: RankedRow) => (
    <TableCell>
      <ModelIdentity
        configuration={entry.row.configuration}
        name={nameOf(entry.row)}
        showRuntime={(twins.get(twinKey(entry.row.configuration)) ?? 0) > 1}
      >
        {view === "table" && entry.row.status !== "comparable" ? (
          <div className="mt-1">
            <StateBadge state={entry.row.status} />
          </div>
        ) : null}
      </ModelIdentity>
    </TableCell>
  );
  const detailsCell = (entry: RankedRow) => (
    <TableCell className="w-10 text-right">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("leaderboard.open", { model: nameOf(entry.row) })}
        onClick={(event) => {
          event.stopPropagation();
          setSelected(rowKey(entry.row));
        }}
      >
        <IconChevronRight />
      </Button>
    </TableCell>
  );
  const row = (entry: RankedRow, cells: ReactNode) => (
    <MotionRow
      key={rowKey(entry.row)}
      layout="position"
      transition={transition}
      className="cursor-pointer"
      onClick={() => setSelected(rowKey(entry.row))}
    >
      {rankCell(entry)}
      {modelCell(entry)}
      {cells}
      {detailsCell(entry)}
    </MotionRow>
  );
  const unrankedDisclosure =
    unranked.length > 0 && rankedRows.length > 0 ? (
      <DisclosureButton
        type="button"
        aria-expanded={unrankedOpen}
        onClick={() => setUnrankedOpen((open) => !open)}
      >
        {unrankedOpen
          ? t("leaderboard.hideUnranked")
          : t("leaderboard.showUnranked", { count: unranked.length })}
      </DisclosureButton>
    ) : null;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <FilterMenu
            label={t("filters.suite")}
            value={scope.versionId}
            options={suiteOptions}
            onChange={(versionId) => onScopeChange({ ...scope, versionId })}
          />
          <FilterMenu
            label={t("filters.run")}
            value={scope.runId}
            options={runOptions}
            onChange={(runId) => onScopeChange({ ...scope, runId })}
          />
          {facet(
            t("filters.provider"),
            provider,
            setProvider,
            distinct(rows.map((entry) => entry.configuration.providerId)),
          )}
          {facet(
            t("filters.effort"),
            effort,
            setEffort,
            distinct(rows.map((entry) => entry.configuration.effort)),
          )}
          {facet(
            t("filters.fastMode"),
            fast,
            setFast,
            distinct(
              rows.map((entry) =>
                entry.configuration.fastMode == null
                  ? null
                  : String(entry.configuration.fastMode),
              ),
            ),
            (value) => (value === "true" ? t("enabled") : t("disabled")),
          )}
          {facet(
            t("filters.track"),
            track,
            setTrack,
            distinct(rows.map((entry) => entry.configuration.executionProfile)),
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <SearchBar
            size="small"
            value={query}
            onChange={setQuery}
            placeholder={t("filters.searchModels")}
            aria-label={t("filters.searchModels")}
            className="w-56"
          />
          <ToggleGroup
            type="single"
            size="sm"
            className="shrink-0"
            value={view}
            onValueChange={(value) => {
              if (value === "table" || value === "chart") setView(value);
            }}
          >
            <ToggleGroupItem value="chart">
              {t("filters.chart")}
            </ToggleGroupItem>
            <ToggleGroupItem value="table">
              {t("filters.table")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {cohort
          ? [
              t("leaderboard.summary", {
                scored,
                cases: cohort.versionIds.length,
                repetitions: cohort.repetitions,
                seconds: cohort.timeoutSeconds,
              }),
              measuredAt == null
                ? null
                : t("leaderboard.measuredOn", {
                    date: formatDate(measuredAt, { dateStyle: "medium" }),
                  }),
            ]
              .filter(Boolean)
              .join(" · ")
          : t("leaderboard.description")}
      </p>
      <Tabs
        value={board.id}
        onValueChange={(value) => setBoardId(value as BoardId)}
      >
        <TabsList variant="buttons" className="flex-wrap justify-start">
          {boards.map((entry) => (
            <TabsTrigger
              key={entry.id}
              value={entry.id}
              variant="buttons"
              className="flex-none"
            >
              {boardLabel(entry)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {view === "table"
            ? t("leaderboard.tableHint")
            : boardDescription(board)}
        </span>
        <span>{t("leaderboard.shown", { count: shown.length })}</span>
      </div>
      {loading ? (
        <BenchmarkEmpty title={t("loading")} compact />
      ) : visible.length === 0 ? (
        <BenchmarkEmpty
          title={t("leaderboard.empty")}
          description={t("leaderboard.emptyHint")}
        />
      ) : view === "chart" ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.rank")}</TableHead>
              <TableHead>{t("fields.model")}</TableHead>
              <TableHead className="w-[38%]">{boardLabel(board)}</TableHead>
              <TableHead className="text-right" />
              <TableHead>{t("leaderboard.allAxes")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((entry) =>
              row(
                entry,
                <>
                  <TableCell>
                    {entry.rank != null && entry.share != null ? (
                      <ScoreBar
                        share={entry.share}
                        leading={entry.rank === 1}
                        label={t("leaderboard.chartLabel", {
                          model: nameOf(entry.row),
                          value: formatValue(board, entry.value),
                        })}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <StateBadge state={entry.row.status} />
                        <span className="text-xs text-muted-foreground">
                          {t("leaderboard.measured", {
                            scored: entry.row.scored,
                            planned: entry.row.planned,
                          })}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-display text-lg font-semibold tabular-nums",
                      entry.rank === 1 && "text-chart-1",
                      entry.value == null && "text-muted-foreground",
                    )}
                  >
                    {formatValue(board, entry.value)}
                  </TableCell>
                  <TableCell>
                    <AxisBars
                      muted={entry.rank == null}
                      items={boards.map((axis) => ({
                        id: axis.id,
                        label: `${boardLabel(axis)}: ${formatValue(axis, axis.value(entry.row))}`,
                        share:
                          shares.get(axis.id)?.get(rowKey(entry.row)) ?? null,
                      }))}
                    />
                  </TableCell>
                </>,
              ),
            )}
          </TableBody>
        </Table>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.rank")}</TableHead>
              <TableHead className="min-w-44">{t("fields.model")}</TableHead>
              {boards.map((entry) => (
                <TableHead key={entry.id} className="px-1 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-auto max-w-28 whitespace-normal text-right leading-tight"
                    aria-pressed={entry.id === board.id}
                    rightIcon={
                      entry.id === board.id ? <IconChevronDown /> : undefined
                    }
                    onClick={() => setBoardId(entry.id)}
                  >
                    {boardLabel(entry)}
                  </Button>
                </TableHead>
              ))}
              <TableHead className="px-1 text-right">
                {t("fields.measuredAt")}
              </TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((entry) =>
              row(
                entry,
                <>
                  {boards.map((axis) => {
                    const value = axis.value(entry.row);
                    return (
                      <TableCell
                        key={axis.id}
                        className={cn(
                          "px-1 text-right text-xs tabular-nums",
                          axis.id === board.id && "font-semibold",
                          axis.id === board.id &&
                            entry.rank === 1 &&
                            "text-chart-1",
                          value == null && "text-muted-foreground",
                        )}
                      >
                        {formatValue(axis, value)}
                      </TableCell>
                    );
                  })}
                  <TableCell className="px-1 text-right text-xs tabular-nums">
                    {entry.row.scored} / {entry.row.planned}
                  </TableCell>
                </>,
              ),
            )}
          </TableBody>
        </Table>
      )}
      {unrankedDisclosure}
      <BenchmarkPager
        page={page}
        pageSize={pageSize}
        count={rows.length}
        onPageChange={onPageChange}
      />
      {selectedRow ? (
        <BenchmarkConfigurationDialog
          row={selectedRow}
          name={nameOf(selectedRow)}
          versions={versions}
          onEvidence={onEvidence}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
