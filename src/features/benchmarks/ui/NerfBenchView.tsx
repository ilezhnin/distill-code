import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronRight, IconPlus } from "@tabler/icons-react";
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
import { modelNameKey, useModelNames } from "../hooks/useBenchmarks";
import {
  formatChange,
  modelDisplayName,
  providerVendor,
} from "../lib/benchmarkLabels";
import type { Baseline, BenchmarkVersion, Comparison } from "../types";
import { BenchmarkAttemptsDialog } from "./BenchmarkAttemptsDialog";
import {
  BenchmarkEmpty,
  BenchmarkPager,
  FilterMenu,
  ModelIdentity,
  StateBadge,
  type Option,
} from "./BenchmarkPrimitives";
import type { ResultScope } from "./BenchmarksView";

interface Props {
  comparisons: Comparison[];
  loading: boolean;
  scope: ResultScope;
  onScopeChange: (scope: ResultScope) => void;
  suiteOptions: Option[];
  runOptions: Option[];
  baseline: Baseline | null;
  baselineId: string;
  baselineOptions: Option[];
  onBaselineChange: (id: string) => void;
  onCreateBaseline: () => void;
  versions: BenchmarkVersion[];
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onEvidence: (id: string) => void;
}

export function NerfBenchView({
  comparisons,
  loading,
  scope,
  onScopeChange,
  suiteOptions,
  runOptions,
  baseline,
  baselineId,
  baselineOptions,
  onBaselineChange,
  onCreateBaseline,
  versions,
  page,
  pageSize,
  onPageChange,
  onEvidence,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const [selected, setSelected] = useState<Comparison | null>(null);
  const names = useModelNames();
  const nameOf = (row: Comparison) =>
    modelDisplayName(
      row.configuration,
      names.get(modelNameKey(row.configuration)),
    );
  const points = (value: number) => {
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return t("percentagePoints", {
      value: `${sign}${Math.abs(value * 100).toFixed(1)}`,
    });
  };
  const date = (value: number | null) =>
    value == null
      ? t("unknown")
      : formatDate(value, { dateStyle: "medium", timeStyle: "short" });
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <FilterMenu
            label={t("filters.baseline")}
            value={baselineId}
            options={baselineOptions}
            onChange={onBaselineChange}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<IconPlus />}
            onClick={onCreateBaseline}
          >
            {t("baseline.create")}
          </Button>
        </div>
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
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {baseline
          ? t("nerf.summary", {
              name: baseline.name,
              date: formatDate(baseline.createdAt, { dateStyle: "medium" }),
              threshold: (baseline.threshold * 100).toFixed(0),
            })
          : t("nerf.description")}
      </p>
      {baselineId === "none" ? (
        <BenchmarkEmpty
          title={t("nerf.empty")}
          description={t("nerf.emptyHint")}
        />
      ) : loading ? (
        <BenchmarkEmpty title={t("loading")} compact />
      ) : comparisons.length === 0 ? (
        <BenchmarkEmpty title={t("leaderboard.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.configuration")}</TableHead>
              <TableHead>{t("fields.retainedQuality")}</TableHead>
              <TableHead className="text-right">
                {t("fields.durationChange")}
              </TableHead>
              <TableHead className="text-right">
                {t("fields.tokenChange")}
              </TableHead>
              <TableHead>{t("fields.status")}</TableHead>
              <TableHead>{t("fields.measuredAt")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {comparisons.map((row) => (
              <TableRow
                key={`${row.baselineId}-${row.configurationId}`}
                className="cursor-pointer"
                onClick={() => setSelected(row)}
              >
                <TableCell>
                  <ModelIdentity
                    configuration={row.configuration}
                    name={nameOf(row)}
                    vendor={providerVendor(row.configuration.providerId)}
                    showRuntime
                  />
                </TableCell>
                <TableCell className="whitespace-normal">
                  {row.retainedQualityPercent != null &&
                  row.qualityChange != null ? (
                    <>
                      <div
                        className={cn(
                          "font-display text-base tabular-nums",
                          row.status === "confirmed_change" &&
                            "text-destructive",
                        )}
                      >
                        {t("percent", {
                          value: row.retainedQualityPercent.toFixed(1),
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {points(row.qualityChange)}
                        {row.intervalLow != null && row.intervalHigh != null
                          ? ` · ${t("fields.intervalValue", {
                              low: (row.intervalLow * 100).toFixed(1),
                              high: (row.intervalHigh * 100).toFixed(1),
                            })}`
                          : ""}
                      </p>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {row.reason}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatChange(t, row.durationChangePercent)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatChange(t, row.tokenChangePercent)}
                </TableCell>
                <TableCell>
                  <StateBadge state={row.status} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {date(row.measuredAt)}
                </TableCell>
                <TableCell className="w-10 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("leaderboard.open", {
                      model: nameOf(row),
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelected(row);
                    }}
                  >
                    <IconChevronRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <BenchmarkPager
        page={page}
        pageSize={pageSize}
        count={comparisons.length}
        onPageChange={onPageChange}
      />
      {selected ? (
        <BenchmarkAttemptsDialog
          title={nameOf(selected)}
          description={`${selected.reason} · ${selected.method}`}
          attemptIds={selected.attemptIds}
          versions={versions}
          onEvidence={onEvidence}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
