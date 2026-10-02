import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import {
  configurationDetails,
  formatQuality,
  formatSeconds,
  formatTokens,
  formatUsd,
  workClassLabel,
} from "../lib/benchmarkLabels";
import type { BenchmarkVersion, LeaderboardRow } from "../types";
import { BenchmarkAttemptsDialog } from "./BenchmarkAttemptsDialog";
import { Metric, SectionHeading, StateBadge } from "./BenchmarkPrimitives";

/** One leaderboard row opened: every measurement, the per-class split and the attempts. */
export function BenchmarkConfigurationDialog({
  row,
  name,
  versions,
  onEvidence,
  onClose,
}: {
  row: LeaderboardRow;
  name: string;
  versions: BenchmarkVersion[];
  onEvidence: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  return (
    <BenchmarkAttemptsDialog
      title={name}
      description={configurationDetails(t, row.configuration)}
      attemptIds={row.attemptIds}
      versions={versions}
      onEvidence={onEvidence}
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={row.status} />
        <span className="text-xs text-muted-foreground">{row.reason}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Metric
          label={t("leaderboard.boards.overall")}
          value={formatQuality(t, row.quality)}
        />
        <Metric
          label={t("fields.coverage")}
          value={`${row.scored} / ${row.planned}`}
        />
        <Metric
          label={t("fields.duration")}
          value={formatSeconds(t, row.medianDurationMs)}
        />
        <Metric
          label={t("fields.tokensOut")}
          value={formatTokens(t, row.medianOutputTokens)}
        />
        <Metric label={t("fields.cost")} value={formatUsd(t, row.cost)} />
        <Metric
          label={t("fields.measuredAt")}
          value={
            row.measuredAt == null
              ? t("unknown")
              : formatDate(row.measuredAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
          }
        />
      </dl>
      {row.axes.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading title={t("leaderboard.axesTitle")} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("fields.workClass")}</TableHead>
                <TableHead className="text-right">
                  {t("fields.success")}
                </TableHead>
                <TableHead className="text-right">
                  {t("fields.coverage")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {row.axes.map((axis) => (
                <TableRow key={axis.id}>
                  <TableCell>{workClassLabel(t, axis.id)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQuality(t, axis.quality)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {axis.scored} / {axis.planned}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </BenchmarkAttemptsDialog>
  );
}
