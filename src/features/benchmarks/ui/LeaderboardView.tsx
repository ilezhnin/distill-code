import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import {
  modelNameKey,
  useModelCatalog,
  useModelNames,
} from "../hooks/useBenchmarks";
import {
  boardsFor,
  rankRows,
  rowKey,
  type Board,
  type BoardId,
  type RankedRow,
} from "../lib/benchmarkBoards";
import {
  boardDescription,
  boardTitle,
  modelDisplayName,
  providerVendor,
} from "../lib/benchmarkLabels";
import {
  formatContext,
  formatPrice,
  resolveCatalogEntry,
} from "../lib/modelCatalog";
import type {
  CatalogEntry,
  Configuration,
  LeaderboardReport,
  LeaderboardRow,
} from "../types";
import {
  AxisBars,
  BenchmarkEmpty,
  BenchmarkPager,
  BoardIcon,
  ModelIdentity,
  ScoreBar,
  StateBadge,
} from "./BenchmarkPrimitives";
import { ModelFilter } from "./ModelFilter";

interface Props {
  report: LeaderboardReport | undefined;
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** A row opened as its own page, by row key. */
  onOpen: (key: string) => void;
}

const MotionRow = motion.create(TableRow);

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
  page,
  pageSize,
  onPageChange,
  onOpen,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const reduceMotion = useReducedMotion();
  const names = useModelNames();
  const catalog = useModelCatalog();
  // Chosen models stand side by side; nothing chosen means every model.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<"chart" | "table">("chart");
  const [boardId, setBoardId] = useState<BoardId>("overall");
  const rows = useMemo(() => report?.rows ?? [], [report]);
  const cohort = report?.cohort;
  const boards = useMemo(() => boardsFor(cohort), [cohort]);
  const board = boards.find((entry) => entry.id === boardId) ?? boards[0];
  // Vendor facts as they stood when each row was measured.
  const facts = useMemo(
    () =>
      new Map(
        rows.map((row) => [
          rowKey(row),
          resolveCatalogEntry(
            catalog,
            row.configuration,
            row.configuration.modelName ??
              names.get(modelNameKey(row.configuration)),
            row.measuredAt ?? cohort?.newestRunAt,
          ),
        ]),
      ),
    [rows, catalog, names, cohort],
  );
  const factOf = (row: LeaderboardRow): CatalogEntry | null =>
    facts.get(rowKey(row)) ?? null;
  const nameOf = (row: LeaderboardRow) =>
    factOf(row)?.displayName ??
    modelDisplayName(
      row.configuration,
      names.get(modelNameKey(row.configuration)),
    );
  const vendorOf = (row: LeaderboardRow) =>
    factOf(row)?.vendor ?? providerVendor(row.configuration.providerId);
  const visible = useMemo(
    () =>
      chosen.size === 0 ? rows : rows.filter((row) => chosen.has(rowKey(row))),
    [rows, chosen],
  );
  const ranked = useMemo(() => rankRows(visible, board), [visible, board]);
  // Every model is listed; rows without a rank follow the ranked ones.
  const listed = ranked;
  // Ranks are placed over every row; only the rendered list is paged. A list
  // that shrank (another board ranks fewer rows) shows its last page.
  const lastPage = Math.max(0, Math.ceil(listed.length / pageSize) - 1);
  const current = Math.min(page, lastPage);
  const shown = listed.slice(current * pageSize, (current + 1) * pageSize);
  const hasMore = listed.length > (current + 1) * pageSize;
  // Another board is another ranking, read from its top.
  const chooseBoard = (id: BoardId) => {
    if (id === board.id) return;
    setBoardId(id);
    onPageChange(0);
  };
  // Every board's standing per row: points for the profile bars, place for the dialog.
  const standings = useMemo(
    () =>
      new Map(
        boards.map((entry) => {
          const results = rankRows(visible, entry);
          return [
            entry.id,
            {
              of: results.filter((result) => result.rank != null).length,
              rows: new Map(
                results.map((result) => [rowKey(result.row), result]),
              ),
            },
          ] as const;
        }),
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
  const transition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 38 };
  const boardLabel = (entry: Board) => boardTitle(t, entry);
  // In table mode the rank and model stay put while the boards scroll.
  const pinned = (offset: string) =>
    view === "table" && `sticky ${offset} z-10 bg-background`;
  const rankCell = (entry: RankedRow) => (
    <TableCell
      className={cn(
        "w-8 px-1 font-display text-lg tabular-nums",
        pinned("left-0"),
        entry.rank === 1
          ? "text-chart-1"
          : entry.rank == null && "text-muted-foreground",
      )}
    >
      {entry.rank ?? "–"}
    </TableCell>
  );
  const modelCell = (entry: RankedRow) => (
    <TableCell className={cn(pinned("left-10"))}>
      <ModelIdentity
        configuration={entry.row.configuration}
        name={nameOf(entry.row)}
        vendor={vendorOf(entry.row)}
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
  const factCells = (entry: RankedRow) => {
    const fact = factOf(entry.row);
    const compact = view === "table" && "px-1 text-xs";
    return (
      <>
        <TableCell className={cn("text-right tabular-nums", compact)}>
          {formatPrice(fact) ?? "–"}
        </TableCell>
        <TableCell className={cn("text-right tabular-nums", compact)}>
          {formatContext(fact?.contextTokens) ?? "–"}
        </TableCell>
      </>
    );
  };
  const detailsCell = (entry: RankedRow) => (
    <TableCell className="w-8 px-1 text-right">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("leaderboard.open", { model: nameOf(entry.row) })}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(rowKey(entry.row));
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
      onClick={() => onOpen(rowKey(entry.row))}
    >
      {rankCell(entry)}
      {modelCell(entry)}
      {cells}
      {factCells(entry)}
      {detailsCell(entry)}
    </MotionRow>
  );
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ModelFilter
          options={rows.map((entry) => ({
            key: rowKey(entry),
            name: nameOf(entry),
            vendor: vendorOf(entry),
            terms: `${entry.configuration.modelId} ${entry.configuration.providerId}`,
          }))}
          selected={chosen}
          onChange={(next) => {
            setChosen(next);
            onPageChange(0);
          }}
        />
        <div className="flex min-w-0 items-center gap-2">
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
      <Tabs
        value={board.id}
        onValueChange={(value) => chooseBoard(value as BoardId)}
      >
        <TabsList variant="buttons" className="flex-wrap justify-start">
          {boards.map((entry) => (
            <Tooltip key={entry.id} delayDuration={TOOLTIP_DELAY.held}>
              <TooltipTrigger asChild>
                <TabsTrigger
                  value={entry.id}
                  variant="buttons"
                  className="size-8 flex-none px-0 data-[state=active]:bg-chart-1/15 data-[state=active]:text-chart-1"
                  aria-label={boardLabel(entry)}
                >
                  <BoardIcon board={entry} className="size-4" />
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64">
                <p className="font-medium">{boardLabel(entry)}</p>
                <p className="opacity-80">{boardDescription(t, entry)}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </TabsList>
      </Tabs>
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
              <TableHead className="w-[34%]">{boardLabel(board)}</TableHead>
              <TableHead className="text-right" />
              <TableHead>{t("leaderboard.allAxes")}</TableHead>
              <TableHead className="text-right">
                {t("leaderboard.price")}
              </TableHead>
              <TableHead className="text-right">
                {t("leaderboard.context")}
              </TableHead>
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
                          value: entry.points ?? "–",
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
                  <TableCell className="text-right">
                    <div
                      className={cn(
                        "font-display text-lg font-semibold tabular-nums",
                        entry.rank === 1 && "text-chart-1",
                        entry.points == null && "text-muted-foreground",
                      )}
                    >
                      {entry.points ?? "–"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <AxisBars
                      muted={entry.rank == null}
                      activeId={board.id}
                      items={boards.map((axis) => ({
                        id: axis.id,
                        label: boardLabel(axis),
                        points:
                          standings.get(axis.id)?.rows.get(rowKey(entry.row))
                            ?.points ?? null,
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
              <TableHead className="sticky left-0 z-10 bg-background">
                {t("fields.rank")}
              </TableHead>
              <TableHead className="sticky left-10 z-10 min-w-40 bg-background">
                {t("fields.model")}
              </TableHead>
              {boards.map((entry) => (
                <TableHead key={entry.id} className="px-1 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-auto max-w-32 whitespace-normal text-right leading-tight"
                    aria-pressed={entry.id === board.id}
                    rightIcon={
                      entry.id === board.id ? <IconChevronDown /> : undefined
                    }
                    onClick={() => chooseBoard(entry.id)}
                  >
                    {boardLabel(entry)}
                  </Button>
                </TableHead>
              ))}
              <TableHead className="px-1 text-right text-xs">
                {t("leaderboard.priceShort")}
              </TableHead>
              <TableHead className="px-1 text-right text-xs">
                {t("leaderboard.context")}
              </TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((entry) =>
              row(
                entry,
                boards.map((axis) => {
                  const points =
                    standings.get(axis.id)?.rows.get(rowKey(entry.row))
                      ?.points ?? null;
                  return (
                    <TableCell
                      key={axis.id}
                      className={cn(
                        "px-1 text-right text-xs tabular-nums",
                        axis.id === board.id && "font-semibold",
                        axis.id === board.id &&
                          entry.rank === 1 &&
                          "text-chart-1",
                        points == null && "text-muted-foreground",
                      )}
                    >
                      {points ?? "–"}
                    </TableCell>
                  );
                }),
              ),
            )}
          </TableBody>
        </Table>
      )}
      <BenchmarkPager
        page={current}
        pageSize={pageSize}
        count={hasMore ? pageSize : 0}
        onPageChange={onPageChange}
      />
    </section>
  );
}
