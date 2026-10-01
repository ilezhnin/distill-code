import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import type { LeaderboardRow } from "../types";
import { configurationLabel } from "../lib/benchmarkDraft";
import { BenchmarkEvidenceLinks } from "./BenchmarkEvidenceLinks";
import {
  BenchmarkField,
  BenchmarkNotice,
  BenchmarkSelect,
} from "./BenchmarkFields";

export function LeaderboardView({
  rows,
  onEvidence,
}: {
  rows: LeaderboardRow[];
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [effort, setEffort] = useState("all");
  const [fast, setFast] = useState("all");
  const [track, setTrack] = useState("all");
  const [chart, setChart] = useState(false);
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          configurationLabel(row.configuration)
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (provider === "all" || row.configuration.providerId === provider) &&
          (effort === "all" ||
            (row.configuration.effort ?? "none") === effort) &&
          (fast === "all" || String(row.configuration.fastMode) === fast) &&
          (track === "all" || row.configuration.executionProfile === track),
      ),
    [rows, query, provider, effort, fast, track],
  );
  const options = (values: string[]) => [
    { value: "all", label: t("all") },
    ...[...new Set(values)].map((value) => ({ value, label: value })),
  ];
  return (
    <section className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {t("leaderboard.description")}
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <BenchmarkField label={t("fields.model")}>
          {(id) => (
            <Input
              id={id}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("fields.provider")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={provider}
              onChange={setProvider}
              options={options(rows.map((row) => row.configuration.providerId))}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("fields.effort")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={effort}
              onChange={setEffort}
              options={options(
                rows.map((row) => row.configuration.effort ?? "none"),
              )}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("fields.fastMode")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={fast}
              onChange={setFast}
              options={[
                { value: "all", label: t("all") },
                { value: "true", label: t("enabled") },
                { value: "false", label: t("disabled") },
                { value: "null", label: t("unsupported") },
              ]}
            />
          )}
        </BenchmarkField>
        <BenchmarkField label={t("fields.executionProfile")}>
          {(id) => (
            <BenchmarkSelect
              id={id}
              value={track}
              onChange={setTrack}
              options={options(
                rows.map((row) => row.configuration.executionProfile),
              )}
            />
          )}
        </BenchmarkField>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="xs"
          variant={chart ? "ghost" : "subtle"}
          onClick={() => setChart(false)}
        >
          {t("leaderboard.table")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant={chart ? "subtle" : "ghost"}
          onClick={() => setChart(true)}
        >
          {t("leaderboard.chart")}
        </Button>
      </div>
      {visible.length === 0 ? (
        <BenchmarkNotice>{t("leaderboard.empty")}</BenchmarkNotice>
      ) : chart ? (
        <div className="space-y-4">
          {visible.map((row) => (
            <div key={JSON.stringify(row.configuration)} className="space-y-1">
              <div className="flex justify-between gap-4 text-sm">
                <span>{configurationLabel(row.configuration)}</span>
                <span>
                  {row.quality == null
                    ? t("unknown")
                    : `${(100 * row.quality).toFixed(1)}%`}
                </span>
              </div>
              <svg
                viewBox="0 0 100 3"
                role="img"
                aria-label={t("leaderboard.chartLabel", {
                  model: row.configuration.modelId,
                  value:
                    row.quality == null
                      ? t("unknown")
                      : (row.quality * 100).toFixed(1),
                })}
                className="h-4 w-full"
              >
                <title>{configurationLabel(row.configuration)}</title>
                <rect width="100" height="3" fill="var(--muted)" />
                {row.quality !== null && (
                  <rect
                    width={Math.max(0, Math.min(100, row.quality * 100))}
                    height="3"
                    fill="var(--primary)"
                  />
                )}
              </svg>
              <p className="text-xs text-muted-foreground">
                {t(`states.${row.status}`, { defaultValue: row.status })}:{" "}
                {row.reason}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "configuration",
                "success",
                "coverage",
                "duration",
                "cost",
                "status",
              ].map((key) => (
                <TableHead key={key}>{t(`fields.${key}`)}</TableHead>
              ))}
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
                  {row.quality == null
                    ? t("unknown")
                    : `${(row.quality * 100).toFixed(1)}%`}
                  <div className="text-xs text-muted-foreground">
                    {row.passed} / {row.attempted}
                  </div>
                </TableCell>
                <TableCell>
                  {row.attempted} / {row.planned}
                </TableCell>
                <TableCell>
                  {row.medianDurationMs == null
                    ? t("unknown")
                    : t("seconds", {
                        value: (row.medianDurationMs / 1000).toFixed(2),
                      })}
                </TableCell>
                <TableCell>
                  {row.cost == null ? t("unknown") : row.cost.toFixed(4)}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div>
                    {t(`states.${row.status}`, { defaultValue: row.status })}
                  </div>
                  <p className="max-w-64 text-xs text-muted-foreground">
                    {row.reason}
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
