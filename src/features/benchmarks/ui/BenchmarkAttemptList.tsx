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

/** Whether `next` keeps every attempt of `previous`; no list keeps only a list. */
function keepsEvery(previous: string[] | null, next: string[] | null) {
  if (previous === null || next === null) return previous === next;
  const kept = new Set(next);
  return previous.every((id) => kept.has(id));
}

/**
 * Paged attempt rows for one query: case, outcome, duration, tokens, cost,
 * evidence. `resetKey` names what the reader chose to list; a new choice or
 * filter starts on the first page, an attempt set that only grows does not.
 */
export function BenchmarkAttemptList({
  query,
  versions,
  showModel = false,
  resetKey,
  onEvidence,
}: {
  query: ResultQuery;
  versions: BenchmarkVersion[];
  showModel?: boolean;
  resetKey?: string;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  // With a reset key the caller owns the scope; a point that moves forward
  // with its run keeps the page as long as its attempts only grow.
  const scope = resetKey ?? JSON.stringify({ ...query, attemptIds: undefined });
  const ids = query.attemptIds ?? null;
  const [paging, setPaging] = useState({ scope, ids, page: 0 });
  const lastPage =
    ids === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.ceil(ids.length / PAGE_SIZE) - 1);
  const page =
    paging.scope === scope && keepsEvery(paging.ids, ids)
      ? Math.min(paging.page, lastPage)
      : 0;
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
        onPageChange={(next) => setPaging({ scope, ids, page: next })}
      />
    </div>
  );
}
