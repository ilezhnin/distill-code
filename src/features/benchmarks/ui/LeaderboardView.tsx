import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useLocaleFormatting } from "@/shared/i18n";
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
import { explicitEffort } from "../lib/benchmarkEffort";
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
  BenchmarkClassTabs,
  AttentionMark,
  ModelIdentity,
  RatingValue,
  StateBadge,
} from "./BenchmarkPrimitives";
import { JudgeFlagFilter, type JudgeFlag } from "./JudgeFlagFilter";
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
  /** Judge panel marks whose scores the board leaves out. */
  hiddenJudgeFlags?: readonly JudgeFlag[];
  onHiddenJudgeFlagsChange?: (hidden: JudgeFlag[]) => void;
}

const MotionRow = motion.create(TableRow);

/**
 * When a row covered its measurement suite: a date only while every suite
 * case has a complete cell today. A row short of it shows a dash and its
 * coverage, the leaderboard's complete-cell count, whatever it covered
 * before the suite grew.
 */
function FullyTested({ row }: { row: LeaderboardRow }) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const planned = row.suitePlanned;
  if (planned == null || planned === 0)
    return <span className="text-muted-foreground">–</span>;
  const complete = row.suiteComplete ?? 0;
  const at = row.fullyTestedAt ?? null;
  if (complete === planned && at != null)
    return <span>{formatDate(at, { dateStyle: "medium" })}</span>;
  return (
    <span className="text-muted-foreground">
      <span className="block">–</span>
      <span className="block text-xs">
        {t("leaderboard.fullyTestedCoverage", { complete, planned })}
      </span>
    </span>
  );
}

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
  hiddenJudgeFlags = [],
  onHiddenJudgeFlagsChange,
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
  // Rows of one model differ by effort and fast mode only.
  const labelOf = (row: LeaderboardRow) =>
    [
      nameOf(row),
      explicitEffort(row.configuration.effort),
      row.configuration.fastMode ? t("fastMode") : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const visible = useMemo(
    () =>
      chosen.size === 0
        ? rows
        : rows.filter((row) => chosen.has(modelKey(row.configuration))),
    [rows, chosen],
  );
  const ranked = useMemo(() => rankRows(visible, board), [visible, board]);
  // Every model is listed by the selected board's score, including preliminary scores.
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
    const activity = modelActivity(
      modelOf(entry.row),
      runs,
      cohort?.versionIds,
    );
    const attention = activity.attention;
    return (
      <TableCell className={cn("min-w-72", pinned("left-10"))}>
        <ModelIdentity
          configuration={entry.row.configuration}
          name={nameOf(entry.row)}
          vendor={vendorOf(entry.row)}
          wrap={false}
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
  const fullyTestedCell = (entry: RankedRow) => (
    <TableCell
      className={cn(
        "whitespace-nowrap text-right tabular-nums",
        view === "table" && "px-1 text-xs",
      )}
    >
      <FullyTested row={entry.row} />
    </TableCell>
  );
  const detailsCell = (entry: RankedRow) => (
    <TableCell className="w-8 px-1 text-right">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("leaderboard.open", { model: labelOf(entry.row) })}
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
      {fullyTestedCell(entry)}
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
                name: labelOf(entry),
                vendor: vendorOf(entry),
                terms: `${entry.configuration.modelId} ${entry.configuration.providerId}`,
              }))}
              selected={chosen}
              onChange={(next) => {
                setChosen(next);
                onPageChange(0);
              }}
            />
            {onHiddenJudgeFlagsChange ? (
              <JudgeFlagFilter
                hidden={hiddenJudgeFlags}
                onChange={onHiddenJudgeFlagsChange}
              />
            ) : null}
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
        <BenchmarkClassTabs
          value={board.id}
          onChange={(value) => chooseBoard(value as BoardId)}
          options={boards.map((entry) => ({
            ...entry,
            label: boardLabel(entry),
            description: boardDescription(t, entry),
          }))}
        />
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
                {t("leaderboard.fullyTested")}
              </TableHead>
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
                        // A partial score reads, but never as comparable.
                        entry.rank == null && "text-muted-foreground",
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
                {t("leaderboard.fullyTested")}
              </TableHead>
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
                  const standing = standings
                    .get(axis.id)
                    ?.rows.get(modelKey(entry.row.configuration));
                  const points = standing?.points ?? null;
                  return (
                    <TableCell
                      key={axis.id}
                      className={cn(
                        "px-1 text-right text-xs tabular-nums",
                        axis.id === board.id && "font-semibold",
                        axis.id === board.id &&
                          entry.rank === 1 &&
                          "text-chart-1",
                        // Each board's own rank decides whether its
                        // score reads as comparable.
                        (points == null || standing?.rank == null) &&
                          "text-muted-foreground",
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
