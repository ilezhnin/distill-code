import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { quotaWindowLabel } from "../lib/benchmarkLabels";
import type {
  Baseline,
  BenchmarkVersion,
  UsageComparison,
  UsageSample,
} from "../types";
import { BenchmarkAttemptsDialog } from "./BenchmarkAttemptsDialog";
import {
  BenchmarkEmpty,
  BenchmarkPager,
  FilterMenu,
  StateBadge,
  type Option,
} from "./BenchmarkPrimitives";
import type { ResultScope } from "./BenchmarksView";

interface Props {
  samples: UsageSample[];
  comparisons: UsageComparison[];
  loading: boolean;
  scope: ResultScope;
  onScopeChange: (scope: ResultScope) => void;
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

export function UsageBenchView({
  samples,
  comparisons,
  loading,
  scope,
  onScopeChange,
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
  const [selected, setSelected] = useState<UsageSample | null>(null);
  const metric = (value: number | null) =>
    value == null ? t("unknown") : value.toFixed(1);
  const date = (value: number) =>
    formatDate(value, { dateStyle: "medium", timeStyle: "short" });
  const latestSample = (comparison: UsageComparison) =>
    samples
      .filter(
        (sample) =>
          sample.accountScope === comparison.accountScope &&
          sample.windowId === comparison.windowId,
      )
      .reduce<number | null>(
        (latest, sample) =>
          latest == null || sample.capturedAt > latest
            ? sample.capturedAt
            : latest,
        null,
      );
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
        <FilterMenu
          label={t("filters.run")}
          value={scope.runId}
          options={runOptions}
          onChange={(runId) => onScopeChange({ ...scope, runId })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {baseline
          ? t("usage.summary", {
              name: baseline.name,
              date: formatDate(baseline.createdAt, { dateStyle: "medium" }),
            })
          : t("usage.description")}
      </p>
      {baselineId === "none" ? (
        <p className="text-xs text-muted-foreground">
          {t("usage.comparisonEmpty")}
        </p>
      ) : comparisons.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {comparisons.map((comparison) => {
            const latest = latestSample(comparison);
            return (
              <div
                key={`${comparison.accountScope}-${comparison.windowId}`}
                className="space-y-2 rounded-md bg-card p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {quotaWindowLabel(t, comparison.windowId)}
                  </h3>
                  <StateBadge state={comparison.status} />
                </div>
                <p className="font-display text-2xl tabular-nums">
                  {comparison.retainedPercent == null
                    ? t("unknown")
                    : t("percent", {
                        value: comparison.retainedPercent.toFixed(1),
                      })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {comparison.intervalLow != null &&
                  comparison.intervalHigh != null
                    ? t("usage.intervalValue", {
                        low: comparison.intervalLow.toFixed(1),
                        high: comparison.intervalHigh.toFixed(1),
                      })
                    : t("fields.retainedAllowance")}
                  {" · "}
                  {latest == null
                    ? t("usage.noMeasurement")
                    : t("usage.latestMeasurement", { date: date(latest) })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {comparison.reason}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
      {loading ? (
        <BenchmarkEmpty title={t("loading")} compact />
      ) : samples.length === 0 ? (
        <BenchmarkEmpty
          title={t("usage.empty")}
          description={t("usage.emptyHint")}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("fields.window")}</TableHead>
                <TableHead className="text-right">
                  {t("fields.usedRange")}
                </TableHead>
                <TableHead className="text-right">
                  {t("fields.quotaDelta")}
                </TableHead>
                <TableHead className="text-right">
                  {t("fields.completed")}
                </TableHead>
                <TableHead>{t("fields.attribution")}</TableHead>
                <TableHead>{t("fields.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {samples.map((sample) => (
                <TableRow
                  key={sample.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(sample)}
                >
                  <TableCell>
                    <div className="font-medium">
                      {quotaWindowLabel(t, sample.windowId)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {date(sample.capturedAt)}
                    </p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {metric(sample.beforeUsedPercent)} →{" "}
                    {metric(sample.afterUsedPercent)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {metric(sample.usedPercentagePoints)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sample.completedTasks}
                  </TableCell>
                  <TableCell>
                    {t(`attribution.${sample.attribution}`, {
                      defaultValue: sample.attribution,
                    })}
                  </TableCell>
                  <TableCell>
                    <StateBadge state={sample.status} />
                  </TableCell>
                  <TableCell className="w-10 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("leaderboard.open", {
                        model: quotaWindowLabel(t, sample.windowId),
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelected(sample);
                      }}
                    >
                      <IconChevronRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            {t("usage.attribution")}
          </p>
        </>
      )}
      <BenchmarkPager
        page={page}
        pageSize={pageSize}
        count={samples.length}
        onPageChange={onPageChange}
      />
      {selected ? (
        <BenchmarkAttemptsDialog
          title={quotaWindowLabel(t, selected.windowId)}
          description={`${date(selected.capturedAt)} · ${selected.reason}`}
          attemptIds={selected.attemptIds}
          versions={versions}
          onEvidence={onEvidence}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
