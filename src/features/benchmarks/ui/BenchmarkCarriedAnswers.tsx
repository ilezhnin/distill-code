import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";

/** While an evaluation runs, its count is read again this often. */
const RUNNING_REFRESH_MS = 5_000;

/**
 * A version that keeps an earlier version's measured answers: how many of
 * them its check has evaluated, and the action that evaluates the rest. The
 * evaluation runs in the background and calls no model.
 */
export function BenchmarkCarriedAnswers({ versionId }: { versionId: string }) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const queryKey = [...benchmarkKeys, "carry", versionId];
  const { data: status } = useQuery({
    queryKey,
    queryFn: () => benchmarkApi.carryStatus(versionId),
    refetchInterval: (query) =>
      query.state.data?.running ? RUNNING_REFRESH_MS : false,
  });
  if (!status || status.total === 0) return null;
  const stopped = error ?? status.lastError;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-2">
        <span className="tabular-nums">
          {t("detail.carried", {
            evaluated: status.evaluated,
            total: status.total,
          })}
        </span>
        {status.running ? (
          <span role="status">{t("detail.carriedRunning")}</span>
        ) : status.evaluated < status.total ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              setError(null);
              void benchmarkApi
                .evaluateCarried(versionId)
                .then((next) => client.setQueryData(queryKey, next))
                .catch((failure) => setError(benchmarkErrorMessage(failure)));
            }}
          >
            {t("detail.carriedEvaluate")}
          </Button>
        ) : null}
      </p>
      {stopped && !status.running ? (
        <p role="alert">{t("detail.carriedStopped", { reason: stopped })}</p>
      ) : null}
    </div>
  );
}
