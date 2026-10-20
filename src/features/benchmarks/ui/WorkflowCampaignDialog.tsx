import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { campaignIdForRun } from "../lib/benchmarkActivity";
import {
  shortId,
  workClassLabel,
  workflowResultReason,
} from "../lib/benchmarkLabels";
import type { WorkflowCampaign } from "../lib/workflowCampaign";
import type { BenchmarkVersionSummary, RunSummary } from "../types";
import {
  BenchmarkAlert,
  Field,
  SelectField,
  StateBadge,
} from "./BenchmarkPrimitives";
import { WorkflowCampaignForm } from "./WorkflowCampaignForm";
import { WorkflowPromotionPanel } from "./WorkflowPromotionPanel";

const campaignKey = ["benchmarks", "workflow-campaigns"];
type PendingOwner = "reservation" | "governance" | "control";

export function WorkflowCampaignDialog({
  versions,
  currentVersions,
  onClose,
  onEvidence,
  initialCampaignId,
  initialWorkClassId,
  showGovernance = false,
  runs = [],
  onOpenRun,
}: {
  versions: BenchmarkVersionSummary[];
  currentVersions: BenchmarkVersionSummary[];
  onClose: () => void;
  onEvidence: (id: string) => void;
  initialCampaignId?: string;
  initialWorkClassId?: string;
  showGovernance?: boolean;
  runs?: RunSummary[];
  onOpenRun?: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const [fitId, setFitId] = useState("none");
  const [selected, setSelected] = useState(initialCampaignId ?? "none");
  const [controlError, setControlError] = useState<string | null>(null);
  const [pendingOwners, setPendingOwners] = useState({
    reservation: false,
    governance: false,
    control: false,
  });
  const pendingRef = useRef(pendingOwners);
  const pending = Object.values(pendingOwners).some(Boolean);
  const changePending = (owner: PendingOwner, active: boolean): boolean => {
    if (
      active &&
      Object.entries(pendingRef.current).some(
        ([key, value]) => key !== owner && value,
      )
    )
      return false;
    const next = { ...pendingRef.current, [owner]: active };
    pendingRef.current = next;
    setPendingOwners(next);
    return true;
  };
  const close = () => {
    if (!Object.values(pendingRef.current).some(Boolean)) onClose();
  };
  const fits = useQuery({
    queryKey: ["benchmarks", "learned-fits"],
    queryFn: benchmarkApi.listSelectorFits,
    enabled: !initialCampaignId,
  });
  const artifact = useQuery({
    queryKey: ["benchmarks", "learned-fit", fitId],
    queryFn: () => benchmarkApi.getSelectorFit(fitId),
    enabled: fitId !== "none",
  });
  const campaigns = useQuery({
    queryKey: campaignKey,
    queryFn: benchmarkApi.listWorkflowCampaigns,
    refetchInterval: (query) =>
      query.state.data?.some(
        (c) =>
          c.state === "running" ||
          c.state === "pausing" ||
          c.state === "paused",
      )
        ? 2000
        : false,
  });
  const campaign = campaigns.data?.find((c) => c.plan.id === selected);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent size="xl" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {t(initialCampaignId ? "activity.campaign" : "campaign.title")}
          </DialogTitle>
          <DialogDescription
            className={initialCampaignId ? "sr-only" : undefined}
          >
            {t(
              initialCampaignId
                ? "campaign.detailsDescription"
                : "campaign.description",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {[fits.error, artifact.error, campaigns.error]
            .filter(Boolean)
            .map((failure) => (
              <BenchmarkAlert key={benchmarkErrorMessage(failure)}>
                {benchmarkErrorMessage(failure)}
              </BenchmarkAlert>
            ))}
          {controlError ? (
            <BenchmarkAlert>{controlError}</BenchmarkAlert>
          ) : null}
          {!initialCampaignId ? (
            <Field label={t("campaign.saved")}>
              {(id) => (
                <SelectField
                  id={id}
                  value={selected}
                  onChange={(value) => {
                    if (!Object.values(pendingRef.current).some(Boolean)) {
                      setSelected(value);
                      setControlError(null);
                    }
                  }}
                  disabled={pending}
                  options={[
                    {
                      value: "none",
                      label: t(
                        campaigns.isPending ? "loading" : "campaign.choose",
                      ),
                    },
                    ...(campaigns.data ?? []).map((c) => ({
                      value: c.plan.id,
                      label: `${formatDate(c.plan.createdAt, { dateStyle: "short", timeStyle: "medium" })} · ${t(`campaign.states.${c.state}`)} · ${c.nextCell}/${c.plan.cells.length}`,
                    })),
                  ]}
                />
              )}
            </Field>
          ) : null}
          {campaign ? (
            <CampaignResult
              key={campaign.plan.id}
              campaign={campaign}
              versions={versions}
              showPromotion={showGovernance || !initialCampaignId}
              evidenceDisabled={pending}
              promotionDisabled={
                pendingOwners.reservation || pendingOwners.control
              }
              onPendingChange={(active) => changePending("governance", active)}
              onEvidence={(id) => {
                if (!Object.values(pendingRef.current).some(Boolean))
                  onEvidence(id);
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("campaign.empty")}
            </p>
          )}
          {campaign && onOpenRun ? (
            <section
              className="space-y-2"
              aria-label={t("campaign.recentWorkflows")}
            >
              <h3 className="text-sm font-medium">
                {t("campaign.recentWorkflows")}
              </h3>
              <div className="max-h-64 divide-y overflow-auto">
                {runs
                  .filter((run) => campaignIdForRun(run) === campaign.plan.id)
                  .map((run) => {
                    const cell =
                      campaign.plan.cells[
                        Number(run.request.requestKey.split(":").at(-1))
                      ];
                    const versionId =
                      run.request.versionIds[0] ??
                      (cell
                        ? campaign.plan.cases[cell.caseIndex]?.versionId
                        : undefined);
                    const finished =
                      run.attemptCount > 0 &&
                      run.settledCount === run.attemptCount;
                    const result = run.workflowResult ?? run.attention;
                    const outcome =
                      result?.outcome ??
                      (finished &&
                      run.state !== "needs_attention" &&
                      run.state !== "cancelled"
                        ? "terminal"
                        : run.state);
                    const reason = workflowResultReason(t, result);
                    return (
                      <div
                        key={run.id}
                        className="flex items-center justify-between gap-3 py-2"
                      >
                        <div className="min-w-0 space-y-1">
                          <p className="truncate text-sm">
                            {versions.find(
                              (version) => version.id === versionId,
                            )?.manifest.name ??
                              (cell
                                ? t("campaign.workflow", {
                                    number: cell.caseIndex + 1,
                                  })
                                : t("activity.campaign"))}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {run.request.workflowPolicy ? (
                              <span>
                                {t(
                                  `activity.policies.${run.request.workflowPolicy.mode}`,
                                )}
                              </span>
                            ) : null}
                            {cell ? (
                              <span>
                                {t("campaign.repeat", {
                                  number: cell.repetition + 1,
                                })}
                              </span>
                            ) : null}
                            <StateBadge state={outcome} />
                            {run.state === "cancelled" &&
                            outcome !== "cancelled" ? (
                              <StateBadge state="cancelled" />
                            ) : null}
                          </div>
                          {reason ? (
                            <p className="break-words text-xs text-muted-foreground">
                              {reason}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={pending}
                          onClick={() => onOpenRun(run.id)}
                        >
                          {t("actions.inspect")}
                        </Button>
                      </div>
                    );
                  })}
              </div>
            </section>
          ) : null}
          {!initialCampaignId ? (
            <details className="border-t pt-4">
              <summary className="cursor-pointer text-sm font-medium">
                {t("campaign.new")}
              </summary>
              <div className="space-y-4 pt-4">
                <Field label={t("learning.saved")}>
                  {(id) => (
                    <SelectField
                      id={id}
                      value={fitId}
                      onChange={(value) => {
                        if (!Object.values(pendingRef.current).some(Boolean))
                          setFitId(value);
                      }}
                      disabled={pending}
                      options={[
                        { value: "none", label: t("learning.chooseFit") },
                        ...(fits.data ?? [])
                          .filter(
                            (fit) =>
                              !initialWorkClassId ||
                              fit.workClassId === initialWorkClassId,
                          )
                          .map((fit) => ({
                            value: fit.id,
                            label: `${workClassLabel(t, fit.workClassId)} · ${shortId(fit.id)}`,
                          })),
                      ]}
                    />
                  )}
                </Field>
                {fits.data?.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("campaign.noFits")}
                  </p>
                ) : null}
                {artifact.data ? (
                  <WorkflowCampaignForm
                    key={artifact.data.model.id}
                    artifact={artifact.data}
                    versions={currentVersions}
                    disabled={pendingOwners.governance || pendingOwners.control}
                    onReservationPendingChange={(active) =>
                      changePending("reservation", active)
                    }
                    onFrozen={(saved) => {
                      client.setQueryData<WorkflowCampaign[]>(
                        campaignKey,
                        (previous) => [
                          saved,
                          ...(previous ?? []).filter(
                            (c) => c.plan.id !== saved.plan.id,
                          ),
                        ],
                      );
                      if (
                        !pendingRef.current.governance &&
                        !pendingRef.current.control
                      )
                        setSelected(saved.plan.id);
                    }}
                  />
                ) : null}
              </div>
            </details>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {campaign ? (
            <CampaignControls
              key={campaign.plan.id}
              campaign={campaign}
              disabled={pending}
              onPendingChange={(active) => changePending("control", active)}
              onError={setControlError}
            />
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={close}
          >
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CampaignControls({
  campaign,
  disabled,
  onPendingChange,
  onError,
}: {
  campaign: WorkflowCampaign;
  disabled: boolean;
  onPendingChange: (pending: boolean) => boolean;
  onError: (error: string | null) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const control = async (action: "start" | "pause" | "resume" | "cancel") => {
    if (inFlight.current || disabled || !onPendingChange(true)) return;
    inFlight.current = true;
    setBusy(true);
    onError(null);
    try {
      const saved = await benchmarkApi.controlWorkflowCampaign(
        campaign.plan.id,
        action,
      );
      client.setQueryData<WorkflowCampaign[]>(campaignKey, (previous) =>
        previous?.map((c) => (c.plan.id === saved.plan.id ? saved : c)),
      );
    } catch (failure) {
      onError(benchmarkErrorMessage(failure));
    } finally {
      await client.invalidateQueries({ queryKey: campaignKey });
      onPendingChange(false);
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (campaign.state === "completed" || campaign.state === "cancelled")
    return null;
  return (
    <>
      {campaign.state === "reserved" ? (
        <Button
          type="button"
          disabled={busy || disabled}
          onClick={() => void control("start")}
        >
          {t("campaign.start")}
        </Button>
      ) : null}
      {campaign.state === "running" ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void control("pause")}
        >
          {t("campaign.pause")}
        </Button>
      ) : null}
      {campaign.state === "paused" ? (
        <Button
          type="button"
          disabled={busy || disabled}
          onClick={() => void control("resume")}
        >
          {t("campaign.resume")}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        destructive
        disabled={busy || disabled}
        onClick={() => void control("cancel")}
      >
        {t("campaign.cancel")}
      </Button>
    </>
  );
}

function CampaignResult({
  campaign,
  versions,
  showPromotion,
  evidenceDisabled,
  promotionDisabled,
  onPendingChange,
  onEvidence,
}: {
  campaign: WorkflowCampaign;
  versions: BenchmarkVersionSummary[];
  showPromotion: boolean;
  evidenceDisabled: boolean;
  promotionDisabled: boolean;
  onPendingChange: (pending: boolean) => boolean | undefined;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const report = useQuery({
    queryKey: ["benchmarks", "workflow-campaign-report", campaign.plan.id],
    queryFn: () => benchmarkApi.workflowCampaignReport(campaign.plan.id),
    enabled: campaign.state === "completed",
    retry: false,
  });
  const candidate = (key: string) => {
    const c = campaign.plan.request.candidates.find(
      (c) => c.id === key.replace(/^worker:/, ""),
    );
    return c ? configurationLabel(c) : key;
  };
  const policy = (key: string): string => {
    if (key.startsWith("fixed:")) return candidate(key.slice(6));
    if (key.startsWith("worker:")) return candidate(key);
    switch (key) {
      case "learned":
        return t("learning.report.learned");
      case "aggregate":
        return t("learning.report.aggregate");
      case "persona":
        return t("learning.report.persona");
      case "best_fixed":
        return t("learning.report.bestFixed");
      case "oracle":
        return t("learning.report.oracle");
      default:
        return key;
    }
  };
  return (
    <section className="space-y-3" aria-label={t("campaign.result")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {t(`campaign.states.${campaign.state}`)}
        </h3>
        <p className="text-sm">
          {t("campaign.progress", {
            done: campaign.nextCell,
            total: campaign.plan.cells.length,
          })}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("campaign.planSummary", {
          cases: campaign.plan.cases.length,
          policies: campaign.plan.policies.length,
          repetitions: campaign.plan.request.repetitions,
          executions: campaign.plan.request.maxExecutions,
        })}
      </p>
      {campaign.stateReason ? (
        <BenchmarkAlert tone="warning">{campaign.stateReason}</BenchmarkAlert>
      ) : null}
      {campaign.state === "paused" &&
      campaign.plan.orderAlgorithm ===
        "sha256-campaign-cell-bounded-refill-v2" ? (
        <p className="text-xs text-muted-foreground">
          {t("campaign.originalTiming")}
        </p>
      ) : null}
      {campaign.plan.orderAlgorithm ===
      "sha256-campaign-cell-reserved-workers-v3" ? (
        <p className="text-xs text-muted-foreground">
          {t("campaign.reservedPool")}
        </p>
      ) : null}
      {campaign.plan.orderAlgorithm ===
      "sha256-campaign-cell-step-admission-v4" ? (
        <p className="text-xs text-muted-foreground">
          {t("campaign.stepAdmission", {
            slots: campaign.plan.request.accountSlots ?? 4,
          })}
        </p>
      ) : null}
      {report.error ? (
        <BenchmarkAlert>{benchmarkErrorMessage(report.error)}</BenchmarkAlert>
      ) : null}
      {campaign.state !== "completed" && campaign.state !== "cancelled" ? (
        <p className="text-xs text-muted-foreground">
          {t(showPromotion ? "campaign.startNotice" : "campaign.controlsHint")}
        </p>
      ) : null}
      {campaign.state === "completed" && report.isPending ? (
        <p className="text-sm">{t("loading")}</p>
      ) : null}
      {report.data ? (
        <>
          <p className="text-xs">
            {t("learning.report.coverage", {
              groups: report.data.groups,
              fallbacks: report.data.cases.filter((entry) => entry.usedFallback)
                .length,
            })}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  {[
                    "policy",
                    "quality",
                    "utility",
                    "duration",
                    "cost",
                    "gain",
                  ].map((column) => (
                    <th key={column} className="p-2 font-medium">
                      {t(`learning.report.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.data.policies.map((row) => (
                  <tr key={row.policy} className="border-t">
                    <th scope="row" className="p-2 font-normal">
                      {policy(row.policy)}
                      {row.selectedFixedKey ? (
                        <span className="block text-muted-foreground">
                          {candidate(row.selectedFixedKey)}
                        </span>
                      ) : null}
                    </th>
                    <td className="p-2">{row.quality.toFixed(3)}</td>
                    <td className="p-2">
                      {row.utility.toFixed(3)}
                      <span className="block text-muted-foreground">
                        [{row.utilityInterval.lower.toFixed(3)},{" "}
                        {row.utilityInterval.upper.toFixed(3)}]
                      </span>
                    </td>
                    <td className="p-2">
                      {row.meanDurationMs === null
                        ? t("learning.report.unknown", {
                            count: row.missingDurationCases,
                          })
                        : `${(row.meanDurationMs / 1000).toFixed(2)} s`}
                    </td>
                    <td className="p-2">
                      {row.meanCost === null
                        ? t("learning.report.unknown", {
                            count: row.missingCostCases,
                          })
                        : `$${row.meanCost.toFixed(4)}`}
                    </td>
                    <td className="p-2">
                      {row.learnedUtilityGain.toFixed(3)}
                      <span className="block text-muted-foreground">
                        [{row.learnedGainInterval.lower.toFixed(3)},{" "}
                        {row.learnedGainInterval.upper.toFixed(3)}]
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("learning.report.intervals")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("campaign.research")}
          </p>
          {report.data.limitations.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm">
                {t("campaign.reportLimitations")}
              </summary>
              <ul className="list-disc space-y-1 pt-2 pl-5 text-xs text-muted-foreground">
                {report.data.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm">
              {t("campaign.attempts")}
            </summary>
            <div className="max-h-64 space-y-3 overflow-auto pt-3">
              {report.data.cases.map((entry) => (
                <div key={entry.versionId} className="rounded border p-3">
                  <h4 className="text-sm font-medium">
                    {versions.find((v) => v.id === entry.versionId)?.manifest
                      .name ?? shortId(entry.versionId)}
                  </h4>
                  {entry.cells.map((cell) => (
                    <div
                      key={cell.candidateKey}
                      className="flex flex-wrap items-center gap-2 text-xs"
                    >
                      <span>{policy(cell.candidateKey)}</span>
                      {cell.repeats.map((repeat) => (
                        <Button
                          key={repeat.attemptId}
                          type="button"
                          variant="link"
                          size="sm"
                          disabled={evidenceDisabled}
                          onClick={() => onEvidence(repeat.attemptId)}
                        >
                          {t("campaign.attempt", {
                            repetition: repeat.repetition + 1,
                            quality: repeat.quality.toFixed(3),
                          })}
                        </Button>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        </>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs">
          {t("campaign.plan")}
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(
            {
              plan: campaign.plan,
              planHash: campaign.planHash,
              report: report.data,
            },
            null,
            2,
          )}
        </pre>
      </details>
      {showPromotion ? (
        <WorkflowPromotionPanel
          campaign={campaign}
          disabled={promotionDisabled}
          onPendingChange={onPendingChange}
        />
      ) : null}
    </section>
  );
}
