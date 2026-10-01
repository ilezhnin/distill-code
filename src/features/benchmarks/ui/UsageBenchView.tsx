import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
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
import type { UsageComparison, UsageSample } from "../types";
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
  samples: UsageSample[];
  comparisons: UsageComparison[];
  loading: boolean;
  scope: ResultScope;
  onScopeChange: (scope: ResultScope) => void;
  runOptions: Option[];
  baselineId: string;
  baselineOptions: Option[];
  onBaselineChange: (id: string) => void;
  onCreateBaseline: () => void;
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
  baselineId,
  baselineOptions,
  onBaselineChange,
  onCreateBaseline,
  page,
  pageSize,
  onPageChange,
  onEvidence,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const metric = (value: number | null) =>
    value == null ? t("unknown") : value.toFixed(2);
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
      <p className="text-xs text-muted-foreground">{t("usage.description")}</p>
      {baselineId === "none" ? (
        <p className="text-xs text-muted-foreground">
          {t("usage.comparisonEmpty")}
        </p>
      ) : comparisons.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {comparisons.map((comparison) => (
            <div
              key={`${comparison.accountScope}-${comparison.windowId}`}
              className="space-y-2 rounded-md bg-card p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{comparison.windowId}</h3>
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
              </p>
              <p className="text-xs text-muted-foreground">
                {comparison.reason}
              </p>
            </div>
          ))}
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
                <TableHead>{t("fields.before")}</TableHead>
                <TableHead>{t("fields.after")}</TableHead>
                <TableHead>{t("fields.quotaDelta")}</TableHead>
                <TableHead>{t("fields.completed")}</TableHead>
                <TableHead>{t("fields.attribution")}</TableHead>
                <TableHead>{t("fields.status")}</TableHead>
                <TableHead>{t("evidence.title")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {samples.map((sample) => (
                <TableRow key={sample.id}>
                  <TableCell>
                    <div>{sample.windowId}</div>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(sample.capturedAt, {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </p>
                  </TableCell>
                  <TableCell>{metric(sample.beforeUsedPercent)}</TableCell>
                  <TableCell>{metric(sample.afterUsedPercent)}</TableCell>
                  <TableCell>{metric(sample.usedPercentagePoints)}</TableCell>
                  <TableCell>{sample.completedTasks}</TableCell>
                  <TableCell>
                    {t(`attribution.${sample.attribution}`, {
                      defaultValue: sample.attribution,
                    })}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <StateBadge state={sample.status} />
                    <p className="mt-1 max-w-72 text-xs text-muted-foreground">
                      {sample.reason}
                    </p>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <BenchmarkEvidenceLinks
                      attemptIds={sample.attemptIds}
                      onEvidence={onEvidence}
                    />
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
    </section>
  );
}
