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
import { Spinner } from "@/shared/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import {
  modelNameKey,
  useModelCatalog,
  useModelNames,
} from "../hooks/useBenchmarks";
import {
  boardsFor,
  rankRows,
  type Board,
  type BoardId,
  type RankedRow,
} from "../lib/benchmarkBoards";
import { reportModels, modelActivity, modelKey } from "../lib/benchmarkModels";
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
  LeaderboardReport,
  LeaderboardRow,
  RunSummary,
} from "../types";
import {
  AxisBars,
  BenchmarkEmpty,
  BenchmarkPager,
  BenchmarkToolbar,
  BoardIcon,
  AttentionMark,
  ModelIdentity,
  RatingValue,
  StateBadge,
} from "./BenchmarkPrimitives";
import { ModelFilter } from "./ModelFilter";

interface Props {
  report: LeaderboardReport | undefined;
  /** Runs whose open cells mark the rows they still measure. */
  runs?: RunSummary[];
  /** Opens a run from a row's warning. */
  onOpenRun?: (id: string) => void;
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** A row opened as its own page, by row key. */
  onOpen: (key: string) => void;
  /** The page actions, last in the boards row. */
  actions?: ReactNode;
}

const MotionRow = motion.create(TableRow);

export function LeaderboardView({
  report,
  runs = [],
  onOpenRun,
  loading,
  page,
  pageSize,
  onPageChange,
  onOpen,
  actions,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const reduceMotion = useReducedMotion();
  const names = useModelNames();
  const catalog = useModelCatalog();
  // Chosen models stand side by side; nothing chosen means every model.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<"chart" | "table">("chart");
  const [boardId, setBoardId] = useState<BoardId>("overall");
  const models = useMemo(() => reportModels(report), [report]);
  const rows = useMemo(() => models.map((model) => model.row), [models]);
  const modelOf = (row: LeaderboardRow) =>
    models.find((model) => model.key === modelKey(row.configuration)) ?? {
      key: modelKey(row.configuration),
      row,
      configurations: [row],
    };
  const cohort = report?.cohort;
  const boards = useMemo(() => boardsFor(cohort), [cohort]);
  const board = boards.find((entry) => entry.id === boardId) ?? boards[0];
  // Vendor facts as they stood when each row was measured.
  const facts = useMemo(
    () =>
      new Map(
        rows.map((row) => [
          modelKey(row.configuration),
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
    facts.get(modelKey(row.configuration)) ?? null;
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
      chosen.size === 0
        ? rows
        : rows.filter((row) => chosen.has(modelKey(row.configuration))),
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
                results.map((result) => [
                  modelKey(result.row.configuration),
                  result,
                ]),
              ),
            },
          ] as const;
        }),
      ),
    [boards, visible],
  );
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
  const modelCell = (entry: RankedRow) => {
    const activity = modelActivity(modelOf(entry.row), runs);
    const attention = activity.attention;
    return (
      <TableCell className={cn("min-w-72", pinned("left-10"))}>
        <ModelIdentity
          configuration={entry.row.configuration}
          name={nameOf(entry.row)}
          vendor={vendorOf(entry.row)}
          wrap={false}
          showSettings={false}
          mark={
            attention.length > 0 ? (
              <AttentionMark
                runs={attention}
                onOpen={(id) => onOpenRun?.(id)}
              />
            ) : null
          }
        >
          {entry.row.status !== "comparable" &&
          entry.row.status !== "preliminary" ? (
            <div className="mt-1">
              <StateBadge state={entry.row.status} />
            </div>
          ) : null}
          {activity.open > 0 ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              {activity.running > 0 ? (
                <Spinner decorative className="size-3 text-chart-1" />
              ) : null}
              {t(activity.running > 0 ? "activity.running" : "activity.left")}
            </div>
          ) : null}
        </ModelIdentity>
      </TableCell>
    );
  };
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
          onOpen(modelKey(entry.row.configuration));
        }}
      >
        <IconChevronRight />
      </Button>
    </TableCell>
  );
  const row = (entry: RankedRow, cells: ReactNode) => (
    <MotionRow
      key={modelKey(entry.row.configuration)}
      layout="position"
      transition={transition}
      className="cursor-pointer"
      onClick={() => onOpen(modelKey(entry.row.configuration))}
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
      {/* Boards on the left; the model filter, the view switch and the page
          actions on the right. */}
      <BenchmarkToolbar
        actions={actions}
        trailing={
          <>
            <ModelFilter
              options={rows.map((entry) => ({
                key: modelKey(entry.configuration),
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
          </>
        }
      >
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
      </BenchmarkToolbar>
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
              <TableHead className="w-[32%]">{t("fields.model")}</TableHead>
              <TableHead className="w-20 text-right">
                {t("leaderboard.score")}
              </TableHead>
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
                  <TableCell className="text-right">
                    <RatingValue
                      points={entry.points}
                      row={entry.row}
                      board={board}
                      className={cn(
                        "font-display text-lg font-semibold tabular-nums",
                        entry.rank === 1 && "text-chart-1",
                        entry.points == null && "text-muted-foreground",
                      )}
                    />
                  </TableCell>
                  <TableCell>
                    <AxisBars
                      muted={entry.rank == null}
                      activeId={board.id}
                      items={boards
                        .filter((axis) => axis.workClass != null)
                        .map((axis) => ({
                          id: axis.id,
                          label: boardLabel(axis),
                          points:
                            standings
                              .get(axis.id)
                              ?.rows.get(modelKey(entry.row.configuration))
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
                    standings
                      .get(axis.id)
                      ?.rows.get(modelKey(entry.row.configuration))?.points ??
                    null;
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
                      <RatingValue
                        points={points}
                        row={entry.row}
                        board={axis}
                      />
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
