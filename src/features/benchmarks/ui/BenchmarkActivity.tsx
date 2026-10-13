import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { Progress } from "@/shared/ui/progress";
import { Spinner } from "@/shared/ui/spinner";
import {
  modelNameKey,
  useModelNames,
  useWorkflowCampaigns,
} from "../hooks/useBenchmarks";
import {
  activeRuns,
  activeCampaigns,
  campaignIdForRun,
  rowAttention,
  runProgress,
  workingConfigurations,
} from "../lib/benchmarkActivity";
import { explicitEffort } from "../lib/benchmarkEffort";
import { attentionLabel, modelDisplayName } from "../lib/benchmarkLabels";
import { runWindowCloses } from "../lib/benchmarkPlan";
import type { LeaderboardRow, RunSummary } from "../types";
import { StateBadge } from "./BenchmarkPrimitives";
import { BenchmarkWorkflowProgress } from "./BenchmarkWorkflowProgress";

/** The models one run names before the rest are counted. */
const SHOWN_MODELS = 3;

/**
 * Runs that dispatch, each with the models it is working on and its progress,
 * and, on a model's own page, the line of its runs that wait for the
 * operator. A list page shows a warning on the row it belongs to instead;
 * nothing here names another model's trouble.
 */
export function BenchmarkActivity({
  runs,
  onOpenRun,
  onOpenCampaign,
  attentionFor = null,
}: {
  runs: RunSummary[];
  onOpenRun: (id: string) => void;
  onOpenCampaign?: (id: string) => void;
  /** The row whose stalled runs the line names; none on a list page. */
  attentionFor?: LeaderboardRow | null;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const names = useModelNames();
  const campaigns = activeCampaigns(useWorkflowCampaigns().data ?? []).filter(
    (campaign) =>
      runs.some((run) => campaignIdForRun(run) === campaign.plan.id),
  );
  const active = activeRuns(runs);
  const stalled = attentionFor ? rowAttention(attentionFor, runs) : [];
  if (active.length === 0 && stalled.length === 0 && campaigns.length === 0)
    return null;
  return (
    <section aria-label={t("activity.title")} className="flex flex-col gap-2">
      {campaigns.map((campaign) => (
        <button
          key={campaign.plan.id}
          type="button"
          onClick={() => onOpenCampaign?.(campaign.plan.id)}
          className="space-y-2 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">{t("activity.campaign")}</span>
            <StateBadge state={campaign.state} />
            <span className="inline-flex items-center gap-2 tabular-nums">
              {t("activity.campaignProgress", {
                settled: campaign.nextCell,
                total: campaign.plan.cells.length,
              })}
              <ChevronRight aria-hidden="true" className="size-4" />
            </span>
          </div>
          <Progress
            value={
              campaign.plan.cells.length
                ? (campaign.nextCell / campaign.plan.cells.length) * 100
                : 0
            }
            aria-label={t("activity.campaign")}
          />
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("activity.campaignCreated", {
              date: formatDate(campaign.plan.createdAt, {
                dateStyle: "short",
                timeStyle: "medium",
              }),
            })}
          </p>
          {campaign.state === "pausing" ? (
            <p className="text-xs text-muted-foreground">
              {t("activity.draining")}
            </p>
          ) : null}
          {campaign.stateReason ? (
            <p className="break-words text-xs text-muted-foreground">
              {campaign.stateReason}
            </p>
          ) : null}
        </button>
      ))}
      {active.some((run) => run.request.workflowPolicy) ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
          {active
            .filter((run) => run.request.workflowPolicy)
            .map((run) => (
              <button
                key={run.id}
                type="button"
                className="min-w-0 rounded-md border border-muted-foreground/30 px-3 py-2 text-left transition-colors hover:bg-muted"
                onClick={() => onOpenRun(run.id)}
              >
                <BenchmarkWorkflowProgress
                  runId={run.id}
                  showPauseReason={false}
                  title={t(
                    `activity.policies.${run.request.workflowPolicy?.mode}`,
                  )}
                />
              </button>
            ))}
        </div>
      ) : null}
      {active
        .filter((run) => !run.request.workflowPolicy)
        .map((run) => {
          const { settled, total } = runProgress([run]);
          const models = workingConfigurations(run);
          return (
            <button
              key={run.id}
              type="button"
              className="flex w-full flex-col gap-2 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-muted/50"
              onClick={() => onOpenRun(run.id)}
            >
              <span className="flex w-full flex-wrap items-center gap-3">
                {run.state === "running" ? (
                  <Spinner
                    decorative
                    className="size-4 shrink-0 text-chart-1"
                  />
                ) : (
                  <StateBadge state={run.state} />
                )}
                <span className="flex min-w-0 items-center gap-3">
                  {models.slice(0, SHOWN_MODELS).map((entry) => {
                    const effort = explicitEffort(entry.effort);
                    return (
                      <span
                        key={entry.id}
                        className="flex min-w-0 items-center gap-1.5"
                      >
                        <span className="shrink-0">
                          {getProviderIcon(entry.providerId, "size-4")}
                        </span>
                        <span className="truncate text-sm font-medium">
                          {modelDisplayName(
                            entry,
                            names.get(modelNameKey(entry)),
                          )}
                        </span>
                        {effort ? (
                          <Badge variant="outline">{effort}</Badge>
                        ) : null}
                        {entry.fastMode ? (
                          <Badge variant="outline">{t("fastMode")}</Badge>
                        ) : null}
                      </span>
                    );
                  })}
                  {models.length > SHOWN_MODELS ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("activity.more", {
                        count: models.length - SHOWN_MODELS,
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  {t("activity.progress", { settled, total })}
                </span>
                <Progress
                  value={total === 0 ? 0 : (settled / total) * 100}
                  aria-label={t("runs.progressLabel")}
                  className="h-1.5 w-32 shrink-0"
                />
              </span>
            </button>
          );
        })}
      {stalled.map((run) => (
        <button
          key={run.id}
          type="button"
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-left text-sm transition-colors hover:bg-destructive/10"
          onClick={() => onOpenRun(run.id)}
        >
          <StateBadge state="needs_attention" />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDate(run.createdAt, {
              dateStyle: "short",
              timeStyle: "short",
            })}
            {" · "}
            {t("activity.progress", {
              settled: run.settledCount,
              total: run.attemptCount,
            })}
          </span>
          <span className="min-w-0 flex-1">
            {attentionLabel(
              t,
              run,
              formatDate(runWindowCloses(run), {
                dateStyle: "short",
                timeStyle: "short",
              }),
            )}
          </span>
        </button>
      ))}
    </section>
  );
}
