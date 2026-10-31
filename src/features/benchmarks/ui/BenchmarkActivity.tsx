import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Pause, Play, X } from "lucide-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import { Button, type ButtonFeedbackState } from "@/shared/ui/button";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { Progress } from "@/shared/ui/progress";
import { Spinner } from "@/shared/ui/spinner";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import {
  benchmarkKeys,
  modelNameKey,
  useModelNames,
  useWorkflowCampaigns,
} from "../hooks/useBenchmarks";
import {
  cellProgress,
  activeRuns,
  activeCampaigns,
  campaignIdForRun,
  pausedRuns,
  runProgress,
} from "../lib/benchmarkActivity";
import { explicitEffort } from "../lib/benchmarkEffort";
import { modelActivity, modelKey, workingModels } from "../lib/benchmarkModels";
import { attentionLabel, modelDisplayName } from "../lib/benchmarkLabels";
import { runWindowCloses } from "../lib/benchmarkPlan";
import type { LeaderboardRow, RunSummary } from "../types";
import { StateBadge } from "./BenchmarkPrimitives";
import {
  BenchmarkWorkflowActivity,
  BenchmarkWorkflowProgress,
} from "./BenchmarkWorkflowProgress";

/** The models one run names before the rest are counted. */
const SHOWN_MODELS = 3;

/** Run states a Resume takes up again. */
const RESUMABLE = new Set(["paused", "needs_attention", "planned"]);

/**
 * Runs that dispatch, each with the models it is working on and its progress,
 * and, on a model's own page, the line of its runs that wait for the
 * operator. Failures remain visible while the run continues other work.
 */
export function BenchmarkActivity({
  runs,
  onOpenRun,
  onOpenCampaign,
  attentionFor = null,
  poolVersionIds,
}: {
  runs: RunSummary[];
  onOpenRun: (id: string) => void;
  onOpenCampaign?: (id: string) => void;
  /** The row whose stalled runs the line names; none on a list page. */
  attentionFor?: LeaderboardRow | null;
  poolVersionIds?: readonly string[];
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const names = useModelNames();
  const client = useQueryClient();
  // The run being steered from its row and how its control is doing. A
  // refusal marks the control as a warning, never as a second Cancel, and the
  // row says why under the run.
  const [steering, setSteering] = useState<{
    runId: string;
    state: ButtonFeedbackState;
    refusal?: string;
  } | null>(null);
  const steer = async (
    runId: string,
    act: (id: string) => Promise<unknown>,
  ) => {
    setSteering({ runId, state: "loading" });
    try {
      await act(runId);
      setSteering(null);
      void client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setSteering({
        runId,
        state: "error",
        refusal: benchmarkErrorMessage(failure),
      });
    }
  };
  const feedbackFor = (runId: string): ButtonFeedbackState =>
    steering?.runId === runId ? steering.state : "idle";
  const campaigns = activeCampaigns(useWorkflowCampaigns().data ?? []).filter(
    (campaign) =>
      runs.some((run) => campaignIdForRun(run) === campaign.plan.id),
  );
  // A paused run keeps its row, so it can be taken up again from here.
  const active = [...activeRuns(runs), ...pausedRuns(runs)];
  const stalled = attentionFor
    ? modelActivity(
        {
          key: modelKey(attentionFor.configuration),
          row: attentionFor,
          configurations: [],
        },
        runs,
        poolVersionIds,
      ).attention
    : [];
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
          const models = workingModels(run);
          const feedback = feedbackFor(run.id);
          const busy = feedback === "loading";
          const resumable = RESUMABLE.has(run.state);
          return (
            <div
              key={run.id}
              className="flex w-full items-center gap-2 rounded-lg border border-border pr-2 transition-colors hover:bg-muted/50"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2 text-left"
                onClick={() => onOpenRun(run.id)}
              >
                <span className="flex w-full flex-wrap items-center gap-3">
                  {run.state === "running" ? (
                    <Spinner
                      decorative
                      className="size-4 shrink-0 text-chart-1"
                    />
                  ) : run.state === "paused" ? null : (
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
                {run.attention ? (
                  <span
                    className="flex items-start gap-2 text-xs text-destructive"
                    title={run.attention.reason}
                  >
                    <AlertTriangle
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    {attentionLabel(t, run)}
                  </span>
                ) : null}
                {steering?.runId === run.id && steering.refusal ? (
                  <span
                    className="flex items-start gap-2 text-xs text-destructive"
                    title={steering.refusal}
                  >
                    <AlertTriangle
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    {t(
                      steering.refusal.includes("Linux text policy proof")
                        ? "activity.policyCheckMissing"
                        : "activity.actionRefused",
                    )}
                  </span>
                ) : null}
                {run.workflowActivity?.length ? (
                  <BenchmarkWorkflowActivity run={run} compact />
                ) : null}
              </button>
              {/* Steering without opening the run: Pause while it runs,
                  Resume once it stands, and Cancel always last. */}
              <span className="flex shrink-0 items-center gap-1">
                {resumable ? (
                  <Button
                    type="button"
                    variant="subtle"
                    tone="success"
                    size="icon-xs"
                    aria-label={t("actions.resume")}
                    tooltip={t("actions.resume")}
                    feedbackState={feedback}
                    loadingVisual="spinner"
                    errorLabel={<AlertTriangle aria-hidden="true" />}
                    onClick={() => void steer(run.id, benchmarkApi.resumeRun)}
                  >
                    <Play aria-hidden="true" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="subtle"
                    tone="warning"
                    size="icon-xs"
                    aria-label={t("actions.pause")}
                    tooltip={t("actions.pause")}
                    disabled={run.state !== "running"}
                    feedbackState={feedback}
                    loadingVisual="spinner"
                    errorLabel={<AlertTriangle aria-hidden="true" />}
                    onClick={() => void steer(run.id, benchmarkApi.pauseRun)}
                  >
                    <Pause aria-hidden="true" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  destructive
                  size="icon-xs"
                  aria-label={t("actions.cancelRun")}
                  tooltip={t("actions.cancelRun")}
                  disabled={busy || run.state === "cancelling"}
                  onClick={() => void steer(run.id, benchmarkApi.cancelRun)}
                >
                  <X aria-hidden="true" />
                </Button>
              </span>
            </div>
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
            {t("activity.progress", cellProgress(run))}
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
