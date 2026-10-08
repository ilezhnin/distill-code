import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import { shortId, workClassLabel } from "../lib/benchmarkLabels";
import type { WorkflowCampaign } from "../lib/workflowCampaign";
import type { BenchmarkVersion } from "../types";
import { BenchmarkAlert, Field, SelectField } from "./BenchmarkPrimitives";
import { WorkflowCampaignForm } from "./WorkflowCampaignForm";

const campaignKey = ["benchmarks", "workflow-campaigns"];

export function WorkflowCampaignDialog({
  versions,
  currentVersions,
  onClose,
  onEvidence,
}: {
  versions: BenchmarkVersion[];
  currentVersions: BenchmarkVersion[];
  onClose: () => void;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [fitId, setFitId] = useState("none");
  const [selected, setSelected] = useState("none");
  const [reservationPending, setReservationPending] = useState(false);
  const fits = useQuery({
    queryKey: ["benchmarks", "learned-fits"],
    queryFn: benchmarkApi.listSelectorFits,
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
        (c) => c.state === "running" || c.state === "paused",
      )
        ? 2000
        : false,
  });
  const campaign = campaigns.data?.find((c) => c.plan.id === selected);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !reservationPending) onClose();
      }}
    >
      <DialogContent size="xl" showCloseButton={!reservationPending}>
        <DialogHeader>
          <DialogTitle>{t("campaign.title")}</DialogTitle>
          <DialogDescription>{t("campaign.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {[fits.error, artifact.error, campaigns.error]
            .filter(Boolean)
            .map((failure) => (
              <BenchmarkAlert key={benchmarkErrorMessage(failure)}>
                {benchmarkErrorMessage(failure)}
              </BenchmarkAlert>
            ))}
          <Field label={t("campaign.saved")}>
            {(id) => (
              <SelectField
                id={id}
                value={selected}
                onChange={setSelected}
                options={[
                  {
                    value: "none",
                    label: t(
                      campaigns.isPending ? "loading" : "campaign.choose",
                    ),
                  },
                  ...(campaigns.data ?? []).map((c) => ({
                    value: c.plan.id,
                    label: `${shortId(c.plan.id)} · ${t(`campaign.states.${c.state}`)} · ${c.nextCell}/${c.plan.cells.length}`,
                  })),
                ]}
              />
            )}
          </Field>
          {campaign ? (
            <CampaignResult
              key={campaign.plan.id}
              campaign={campaign}
              versions={versions}
              evidenceDisabled={reservationPending}
              onEvidence={(id) => {
                if (!reservationPending) onEvidence(id);
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("campaign.empty")}
            </p>
          )}
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
                    onChange={setFitId}
                    disabled={reservationPending}
                    options={[
                      { value: "none", label: t("learning.chooseFit") },
                      ...(fits.data ?? []).map((fit) => ({
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
                  onReservationPendingChange={setReservationPending}
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
                    setSelected(saved.plan.id);
                  }}
                />
              ) : null}
            </div>
          </details>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={reservationPending}
            onClick={onClose}
          >
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CampaignResult({
  campaign,
  versions,
  evidenceDisabled,
  onEvidence,
}: {
  campaign: WorkflowCampaign;
  versions: BenchmarkVersion[];
  evidenceDisabled: boolean;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const report = useQuery({
    queryKey: ["benchmarks", "workflow-campaign-report", campaign.plan.id],
    queryFn: () => benchmarkApi.workflowCampaignReport(campaign.plan.id),
    enabled: campaign.state === "completed",
    retry: false,
  });
  const control = async (action: "start" | "pause" | "resume" | "cancel") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await benchmarkApi.controlWorkflowCampaign(
        campaign.plan.id,
        action,
      );
      client.setQueryData<WorkflowCampaign[]>(campaignKey, (previous) =>
        previous?.map((c) => (c.plan.id === saved.plan.id ? saved : c)),
      );
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      await client.invalidateQueries({ queryKey: campaignKey });
      inFlight.current = false;
      setBusy(false);
    }
  };
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
        <BenchmarkAlert>{campaign.stateReason}</BenchmarkAlert>
      ) : null}
      {error || report.error ? (
        <BenchmarkAlert>
          {error ?? benchmarkErrorMessage(report.error)}
        </BenchmarkAlert>
      ) : null}
      {campaign.state !== "completed" && campaign.state !== "cancelled" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("campaign.startNotice")}
          </p>
          <div className="flex flex-wrap gap-2">
            {campaign.state === "reserved" ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void control("start")}
              >
                {t("campaign.start")}
              </Button>
            ) : null}
            {campaign.state === "running" ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void control("pause")}
              >
                {t("campaign.pause")}
              </Button>
            ) : null}
            {campaign.state === "paused" ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void control("resume")}
              >
                {t("campaign.resume")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void control("cancel")}
            >
              {t("campaign.cancel")}
            </Button>
          </div>
        </>
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
    </section>
  );
}
