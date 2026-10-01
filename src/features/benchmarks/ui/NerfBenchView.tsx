import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import type { Comparison } from "../types";
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
  comparisons: Comparison[];
  loading: boolean;
  scope: ResultScope;
  onScopeChange: (scope: ResultScope) => void;
  suiteOptions: Option[];
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

export function NerfBenchView({
  comparisons,
  loading,
  scope,
  onScopeChange,
  suiteOptions,
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
  const percent = (value: number | null, digits = 1) =>
    value == null
      ? t("unknown")
      : t("percent", { value: value.toFixed(digits) });
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
      <p className="text-xs text-muted-foreground">{t("nerf.description")}</p>
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
              <TableHead>{t("fields.qualityChange")}</TableHead>
              <TableHead>{t("fields.durationChange")}</TableHead>
              <TableHead>{t("fields.tokenChange")}</TableHead>
              <TableHead>{t("fields.interval")}</TableHead>
              <TableHead>{t("fields.status")}</TableHead>
              <TableHead>{t("evidence.title")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comparisons.map((row) => (
              <TableRow key={`${row.baselineId}-${row.configurationId}`}>
                <TableCell>{row.configurationId}</TableCell>
                <TableCell>
                  {row.qualityChange == null
                    ? t("unknown")
                    : t("percentagePoints", {
                        value: (row.qualityChange * 100).toFixed(1),
                      })}
                  {row.retainedQualityPercent != null ? (
                    <div className="text-xs text-muted-foreground">
                      {t("fields.retainedQualityValue", {
                        value: row.retainedQualityPercent.toFixed(1),
                      })}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>{percent(row.durationChangePercent)}</TableCell>
                <TableCell>{percent(row.tokenChangePercent)}</TableCell>
                <TableCell>
                  {row.intervalLow == null || row.intervalHigh == null
                    ? t("unknown")
                    : t("fields.intervalValue", {
                        low: (row.intervalLow * 100).toFixed(1),
                        high: (row.intervalHigh * 100).toFixed(1),
                      })}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <StateBadge state={row.status} />
                  <p
                    className="mt-1 max-w-56 text-xs text-muted-foreground"
                    title={row.method}
                  >
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
        count={comparisons.length}
        onPageChange={onPageChange}
      />
    </section>
  );
}
