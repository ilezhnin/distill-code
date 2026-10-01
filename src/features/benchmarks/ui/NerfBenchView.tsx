import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import type { Comparison } from "../types";
import { BenchmarkNotice } from "./BenchmarkFields";
import { BenchmarkEvidenceLinks } from "./BenchmarkEvidenceLinks";

export function NerfBenchView({
  comparisons,
  onEvidence,
}: {
  comparisons: Comparison[];
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("nerf.description")}</p>
      {comparisons.length === 0 ? (
        <BenchmarkNotice>{t("nerf.empty")}</BenchmarkNotice>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "configuration",
                "qualityChange",
                "retainedQuality",
                "durationChange",
                "tokenChange",
                "interval",
                "status",
              ].map((key) => (
                <TableHead key={key}>{t(`fields.${key}`)}</TableHead>
              ))}
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
                </TableCell>
                <TableCell>
                  {row.retainedQualityPercent == null
                    ? t("unknown")
                    : `${row.retainedQualityPercent.toFixed(1)}%`}
                </TableCell>
                <TableCell>
                  {row.durationChangePercent == null
                    ? t("unknown")
                    : `${row.durationChangePercent.toFixed(1)}%`}
                </TableCell>
                <TableCell>
                  {row.tokenChangePercent == null
                    ? t("unknown")
                    : `${row.tokenChangePercent.toFixed(1)}%`}
                </TableCell>
                <TableCell>
                  {row.intervalLow == null || row.intervalHigh == null
                    ? t("unknown")
                    : `${(row.intervalLow * 100).toFixed(1)}% … ${(row.intervalHigh * 100).toFixed(1)}%`}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div>
                    {t(`states.${row.status}`, { defaultValue: row.status })}
                  </div>
                  <p className="max-w-80 text-xs text-muted-foreground">
                    {row.reason}
                  </p>
                  <p className="max-w-80 break-words text-xs text-muted-foreground">
                    {row.method}
                  </p>
                </TableCell>
                <TableCell>
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
    </section>
  );
}
