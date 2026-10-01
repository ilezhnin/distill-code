import { useTranslation } from "react-i18next";
import { BenchmarkEvidenceLinks } from "./BenchmarkEvidenceLinks";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import type { UsageSample, UsageComparison } from "../types";
import { BenchmarkNotice } from "./BenchmarkFields";

export function UsageBenchView({
  samples,
  comparisons,
  onEvidence,
}: {
  comparisons: UsageComparison[];
  samples: UsageSample[];
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const metric = (value: number | null) =>
    value == null ? t("unknown") : value.toFixed(2);
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("usage.description")}</p>
      <BenchmarkNotice>{t("usage.attribution")}</BenchmarkNotice>
      {comparisons.length === 0 ? (
        <BenchmarkNotice>{t("usage.comparisonEmpty")}</BenchmarkNotice>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {comparisons.map((comparison) => (
            <section
              key={`${comparison.accountScope}-${comparison.windowId}`}
              className="space-y-2 rounded-md border border-border p-4"
            >
              <h3 className="text-sm font-medium">{comparison.windowId}</h3>
              <p className="text-2xl">
                {comparison.retainedPercent == null
                  ? t("unknown")
                  : `${comparison.retainedPercent.toFixed(1)}%`}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("fields.retainedAllowance")}
              </p>
              <svg
                viewBox="0 0 200 16"
                role="img"
                aria-label={t("fields.retainedAllowance")}
                className="h-8 w-full"
              >
                <title>{t("fields.retainedAllowance")}</title>
                <line
                  x1="100"
                  y1="0"
                  x2="100"
                  y2="16"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="2 2"
                />
                {comparison.retainedPercent != null && (
                  <circle
                    cx={Math.max(0, Math.min(200, comparison.retainedPercent))}
                    cy="8"
                    r="3"
                    fill="var(--primary)"
                  />
                )}
                {comparison.intervalLow != null &&
                  comparison.intervalHigh != null && (
                    <line
                      x1={Math.max(0, comparison.intervalLow)}
                      x2={Math.min(200, comparison.intervalHigh)}
                      y1="8"
                      y2="8"
                      stroke="var(--primary)"
                    />
                  )}
              </svg>
              <p className="text-sm">
                {t(`states.${comparison.status}`, {
                  defaultValue: comparison.status,
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {comparison.reason}
              </p>
              {comparison.intervalLow != null &&
                comparison.intervalHigh != null && (
                  <p className="text-xs">
                    {t("fields.interval")}: {comparison.intervalLow.toFixed(1)}%
                    … {comparison.intervalHigh.toFixed(1)}%
                  </p>
                )}
            </section>
          ))}
        </div>
      )}
      {samples.length === 0 ? (
        <BenchmarkNotice>{t("usage.empty")}</BenchmarkNotice>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "window",
                "before",
                "after",
                "quotaDelta",
                "completed",
                "attribution",
                "status",
              ].map((key) => (
                <TableHead key={key}>{t(`fields.${key}`)}</TableHead>
              ))}
              <TableHead>{t("evidence.title")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {samples.map((sample) => (
              <TableRow key={sample.id}>
                <TableCell>
                  <div>{sample.windowId}</div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(sample.capturedAt).toLocaleString()}
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
                <TableCell>
                  <div>
                    {t(`states.${sample.status}`, {
                      defaultValue: sample.status,
                    })}
                  </div>
                  <p className="max-w-72 text-xs text-muted-foreground">
                    {sample.reason}
                  </p>
                </TableCell>
                <TableCell>
                  <details>
                    <summary>{t("actions.inspect")}</summary>
                    <pre className="max-h-48 max-w-80 overflow-auto whitespace-pre-wrap text-xs">
                      {JSON.stringify(sample.evidence, null, 2)}
                    </pre>
                    <BenchmarkEvidenceLinks
                      attemptIds={sample.attemptIds}
                      onEvidence={onEvidence}
                    />
                  </details>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
