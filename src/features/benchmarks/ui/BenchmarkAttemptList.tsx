import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import {
  formatSeconds,
  formatTokens,
  formatUsd,
  shortId,
  workClassLabel,
} from "../lib/benchmarkLabels";
import type { BenchmarkVersion, ResultQuery } from "../types";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  BenchmarkPager,
  StateBadge,
} from "./BenchmarkPrimitives";

const PAGE_SIZE = 50;

/** Paged attempt rows for one query: case, outcome, duration, tokens, cost, evidence. */
export function BenchmarkAttemptList({
  query,
  versions,
  showModel = false,
  onEvidence,
}: {
  query: ResultQuery;
  versions: BenchmarkVersion[];
  showModel?: boolean;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const [page, setPage] = useState(0);
  const paged = { ...query, offset: page * PAGE_SIZE, limit: PAGE_SIZE };
  const attempts = useQuery({
    queryKey: [...benchmarkKeys, "attempts", paged],
    queryFn: () => benchmarkApi.listAttempts(paged),
  });
  const rows = attempts.data ?? [];
  const version = (id: string) => versions.find((entry) => entry.id === id);
  return (
    <div className="space-y-3">
      {attempts.error ? (
        <BenchmarkAlert>{benchmarkErrorMessage(attempts.error)}</BenchmarkAlert>
      ) : null}
      {attempts.isPending ? (
        <BenchmarkEmpty title={t("loading")} compact />
      ) : rows.length === 0 ? (
        <BenchmarkEmpty title={t("results.empty")} compact />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.case")}</TableHead>
              {showModel ? <TableHead>{t("fields.model")}</TableHead> : null}
              <TableHead>{t("fields.status")}</TableHead>
              <TableHead className="text-right">
                {t("fields.durationShort")}
              </TableHead>
              <TableHead className="text-right">
                {t("fields.tokensOut")}
              </TableHead>
              <TableHead className="text-right">
                {t("fields.costShort")}
              </TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const manifest = version(row.versionId)?.manifest;
              return (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-normal">
                    <div>{manifest?.name ?? shortId(row.versionId)}</div>
                    <p className="text-xs text-muted-foreground">
                      {[
                        manifest
                          ? workClassLabel(t, manifest.workClassId)
                          : null,
                        row.repetition > 0
                          ? t("fields.repetitionValue", {
                              value: row.repetition + 1,
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </TableCell>
                  {showModel ? <TableCell>{row.modelId}</TableCell> : null}
                  <TableCell>
                    <StateBadge state={row.outcome ?? row.phase} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSeconds(t, row.durationMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(t, row.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(t, row.cost)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => onEvidence(row.id)}
                    >
                      {t("actions.inspect")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <BenchmarkPager
        page={page}
        pageSize={PAGE_SIZE}
        count={rows.length}
        busy={attempts.isFetching}
        onPageChange={setPage}
      />
    </div>
  );
}
