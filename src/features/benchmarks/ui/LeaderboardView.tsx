import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChartBar, IconTable } from "@tabler/icons-react";
import { Progress } from "@/shared/ui/progress";
import { SearchBar } from "@/shared/ui/SearchBar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { configurationLabel } from "../lib/benchmarkDraft";
import {
  formatCost,
  formatQuality,
  formatSeconds,
} from "../lib/benchmarkLabels";
import type { LeaderboardReport, LeaderboardRow } from "../types";
import { BenchmarkEvidenceLinks } from "./BenchmarkEvidenceLinks";
import {
  BenchmarkEmpty,
  BenchmarkPager,
  FilterMenu,
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
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onEvidence: (id: string) => void;
}

function distinct(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => value ?? "none"))];
}

export function LeaderboardView({
  report,
  loading,
  scope,
  onScopeChange,
  suiteOptions,
  runOptions,
  page,
  pageSize,
  onPageChange,
  onEvidence,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [effort, setEffort] = useState("all");
  const [fast, setFast] = useState("all");
  const [track, setTrack] = useState("all");
  const [view, setView] = useState<"table" | "chart">("table");
  const rows = useMemo(() => report?.rows ?? [], [report]);
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          configurationLabel(row.configuration)
            .toLowerCase()
            .includes(query.trim().toLowerCase()) &&
          (provider === "all" || row.configuration.providerId === provider) &&
          (effort === "all" ||
            (row.configuration.effort ?? "none") === effort) &&
          (fast === "all" || String(row.configuration.fastMode) === fast) &&
          (track === "all" || row.configuration.executionProfile === track),
      ),
    [rows, query, provider, effort, fast, track],
  );
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
  const cohort = report?.cohort;
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
            distinct(rows.map((row) => row.configuration.providerId)),
          )}
          {facet(
            t("filters.effort"),
            effort,
            setEffort,
            distinct(rows.map((row) => row.configuration.effort)),
            (value) => (value === "none" ? t("unknown") : value),
          )}
          {facet(
            t("filters.fastMode"),
            fast,
            setFast,
            distinct(rows.map((row) => String(row.configuration.fastMode))),
            (value) =>
              value === "true"
                ? t("enabled")
                : value === "false"
                  ? t("disabled")
                  : t("unknown"),
          )}
          {facet(
            t("filters.track"),
            track,
            setTrack,
            distinct(rows.map((row) => row.configuration.executionProfile)),
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
            <ToggleGroupItem value="table" aria-label={t("filters.table")}>
              <IconTable />
            </ToggleGroupItem>
            <ToggleGroupItem value="chart" aria-label={t("filters.chart")}>
              <IconChartBar />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {cohort
          ? t("leaderboard.cohort", {
              runs: cohort.runIds.length,
              cases: cohort.versionIds.length,
              repetitions: cohort.repetitions,
              seconds: cohort.timeoutSeconds,
            })
          : t("leaderboard.description")}
      </p>
      {loading ? (
        <BenchmarkEmpty title={t("loading")} compact />
      ) : visible.length === 0 ? (
        <BenchmarkEmpty
          title={t("leaderboard.empty")}
          description={t("leaderboard.emptyHint")}
        />
      ) : view === "chart" ? (
        <ChartRows rows={visible} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.configuration")}</TableHead>
              <TableHead>{t("fields.success")}</TableHead>
              <TableHead>{t("fields.coverage")}</TableHead>
              <TableHead>{t("fields.duration")}</TableHead>
              <TableHead>{t("fields.cost")}</TableHead>
              <TableHead>{t("fields.status")}</TableHead>
              <TableHead>{t("evidence.title")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={JSON.stringify(row.configuration)}>
                <TableCell>
                  <div>{row.configuration.modelId}</div>
                  <p className="text-xs text-muted-foreground">
                    {configurationLabel(row.configuration)}
                  </p>
                </TableCell>
                <TableCell>
                  {formatQuality(t, row.quality)}
                  <div className="text-xs text-muted-foreground">
                    {row.passed} / {row.attempted}
                  </div>
                </TableCell>
                <TableCell>
                  {row.attempted} / {row.planned}
                </TableCell>
                <TableCell>{formatSeconds(t, row.medianDurationMs)}</TableCell>
                <TableCell>{formatCost(t, row.cost)}</TableCell>
                <TableCell className="whitespace-normal">
                  <StateBadge state={row.status} />
                  <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                    {row.reason}
                  </p>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <BenchmarkEvidenceLinks
                    attemptIds={row.attemptIds}
                    onEvidence={onEvidence}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <BenchmarkPager
        page={page}
        pageSize={pageSize}
        count={rows.length}
        onPageChange={onPageChange}
      />
    </section>
  );
}

function ChartRows({ rows }: { rows: LeaderboardRow[] }) {
  const { t } = useTranslation("benchmarks");
  return (
    <ul className="space-y-4">
      {rows.map((row) => (
        <li key={JSON.stringify(row.configuration)} className="space-y-1.5">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="truncate">
              {configurationLabel(row.configuration)}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatQuality(t, row.quality)}
            </span>
          </div>
          <Progress
            value={row.quality == null ? 0 : row.quality * 100}
            aria-label={t("leaderboard.chartLabel", {
              model: row.configuration.modelId,
              value:
                row.quality == null
                  ? t("unknown")
                  : (row.quality * 100).toFixed(1),
            })}
          />
          <p className="text-xs text-muted-foreground">
            <StateBadge state={row.status} /> {row.reason}
          </p>
        </li>
      ))}
    </ul>
  );
}
