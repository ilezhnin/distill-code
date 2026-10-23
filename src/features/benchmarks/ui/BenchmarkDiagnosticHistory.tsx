import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconChevronDown } from "@tabler/icons-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { BenchmarkAlert } from "./BenchmarkPrimitives";

// Only fixed infrastructure labels are safe before identity is revealed.
// Arbitrary provider messages, codes and context may name the candidate.
const BLIND_STAGES = new Set([
  "attempt_reason",
  "judge_preflight",
  "judge_session",
  "judge_dispatch",
  "judge_events",
  "judge_status",
  "judge_cleanup",
  "judge_parse",
  "judge_panel",
  "judge_render",
]);
const BLIND_CODES = new Set([
  "resource_busy",
  "account_busy",
  "judge_preparation_timeout",
  "judge_admission_wait",
  "judge_quota_wait",
  "quota_wait",
  "rate_limited",
  "dispatch_uncertain",
  "budget_timeout",
  "capability_missing",
  "selection_changed",
  "reason_changed",
]);

export function BenchmarkDiagnosticHistory({
  attemptId,
  blind,
  onReveal,
}: {
  attemptId: string;
  blind: boolean;
  onReveal: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const queryKey = [...benchmarkKeys, "diagnostics", attemptId];
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      benchmarkApi.listDiagnostics(attemptId, pageParam, 50),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    enabled: open,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const date = (at: number) =>
    formatDate(at, { dateStyle: "medium", timeStyle: "medium" });
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          rightIcon={<IconChevronDown />}
        >
          {t("diagnostics.title")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("diagnostics.description")}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={query.isFetching}
            onClick={() => void client.resetQueries({ queryKey, exact: true })}
          >
            {t("diagnostics.refresh")}
          </Button>
        </div>
        {blind ? (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>{t("diagnostics.blindNotice")}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onReveal}
            >
              {t("diagnostics.reveal")}
            </Button>
          </div>
        ) : null}
        {query.error ? (
          <BenchmarkAlert>
            {t("diagnostics.failed")}
            {!blind ? ` ${benchmarkErrorMessage(query.error)}` : null}
            <Button
              type="button"
              variant="alert"
              size="xs"
              disabled={query.isFetching}
              onClick={() =>
                void (query.isFetchNextPageError
                  ? query.fetchNextPage()
                  : query.refetch())
              }
            >
              {t("diagnostics.retry")}
            </Button>
          </BenchmarkAlert>
        ) : null}
        {query.isPending ? (
          <p className="text-xs text-muted-foreground">{t("loading")}</p>
        ) : query.isSuccess && items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("diagnostics.empty")}
          </p>
        ) : null}
        <ol
          aria-label={t("diagnostics.entries")}
          className="divide-y divide-border"
        >
          {items.map((item) => (
            <li key={item.sequence} className="space-y-2 py-3 text-xs">
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-medium">
                <span>
                  {t("diagnostics.stage")}:{" "}
                  {blind && !BLIND_STAGES.has(item.stage)
                    ? t("diagnostics.hiddenLabel")
                    : item.stage}
                </span>
                <span>
                  {t("diagnostics.code")}:{" "}
                  {blind && !BLIND_CODES.has(item.code)
                    ? t("diagnostics.hiddenLabel")
                    : item.code}
                </span>
              </div>
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                <div>
                  <dt className="inline">{t("diagnostics.first")}: </dt>
                  <dd className="inline">
                    <time dateTime={new Date(item.firstAt).toISOString()}>
                      {date(item.firstAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("diagnostics.last")}: </dt>
                  <dd className="inline">
                    <time dateTime={new Date(item.lastAt).toISOString()}>
                      {date(item.lastAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("diagnostics.count")}: </dt>
                  <dd className="inline">{item.occurrences}</dd>
                </div>
              </dl>
              {!blind ? (
                <>
                  <p className="whitespace-pre-wrap break-words">
                    {item.message}
                  </p>
                  {item.judge ? (
                    <p className="text-muted-foreground">
                      {t("diagnostics.judge", {
                        provider: item.judge.providerId,
                        model: item.judge.modelId,
                      })}
                    </p>
                  ) : null}
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      {t("diagnostics.context")}
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3">
                      {JSON.stringify(
                        {
                          phase: item.phase,
                          candidate: item.candidate,
                          judge: item.judge,
                          context: item.context,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </>
              ) : null}
            </li>
          ))}
        </ol>
        {query.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? t("loading") : t("diagnostics.older")}
          </Button>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
