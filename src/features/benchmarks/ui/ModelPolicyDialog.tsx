import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Textarea } from "@/shared/ui/textarea";
import { benchmarkGovernanceApi } from "../api/benchmarkGovernance";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { useBenchmarkDefinitions } from "../hooks/useBenchmarks";
import type { BenchmarkLocation } from "../lib/benchmarkNavigation";
import { shortId, workClassLabel } from "../lib/benchmarkLabels";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  StateBadge,
} from "./BenchmarkPrimitives";
import { BenchmarkLearningDialog } from "./BenchmarkLearningDialog";
import { WorkflowCampaignDialog } from "./WorkflowCampaignDialog";

/**
 * Revokes a certificate in place, whatever made it: a holdout certificate has
 * no campaign to manage it from, and revocation is the safety valve for every
 * certificate steering a class. A reason is required, as in the campaign view.
 */
function CertificateRevoke({ id }: { id: string }) {
  const { t } = useTranslation("benchmarks");
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const revoke = useMutation({
    mutationFn: () => benchmarkGovernanceApi.revokePromotion(id, reason.trim()),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["benchmarks", "promotions"] }),
  });
  return (
    <div className="space-y-2">
      <Field label={t("governance.revocationReason")}>
        {(fieldId) => (
          <Textarea
            id={fieldId}
            maxLength={16384}
            value={reason}
            disabled={revoke.isPending}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      {revoke.error ? (
        <BenchmarkAlert>{benchmarkErrorMessage(revoke.error)}</BenchmarkAlert>
      ) : null}
      <Button
        type="button"
        size="xs"
        variant="outline"
        destructive
        disabled={revoke.isPending || !reason.trim()}
        onClick={() => revoke.mutate()}
      >
        {t("promotion.revoke")}
      </Button>
    </div>
  );
}

/** One entry point to the existing qualification, fitting and promotion tools. */
export function ModelPolicyDialog({
  classId,
  onClose,
  onNavigate,
}: {
  classId: string;
  onClose: () => void;
  onNavigate?: (location: BenchmarkLocation) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const [tab, setTab] = useState("certificates");
  const [tool, setTool] = useState<{
    kind: "learning" | "campaign";
    id?: string;
  } | null>(null);
  const definitions = useBenchmarkDefinitions();
  const fits = useQuery({
    queryKey: ["benchmarks", "learned-fits"],
    queryFn: benchmarkApi.listSelectorFits,
  });
  const campaigns = useQuery({
    queryKey: ["benchmarks", "workflow-campaigns"],
    queryFn: benchmarkApi.listWorkflowCampaigns,
  });
  const promotions = useQuery({
    queryKey: ["benchmarks", "promotions"],
    queryFn: benchmarkGovernanceApi.listPromotions,
  });
  const queryClient = useQueryClient();
  const previewLearned = useMutation({
    mutationFn: () =>
      benchmarkGovernanceApi.previewLearnedClass({ workClassId: classId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["benchmarks", "class-policies"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["benchmarks", "learned-fits"],
      });
    },
  });
  const versions = definitions.data?.flatMap((d) => d.versions) ?? [];
  const currentVersions = (definitions.data ?? [])
    .filter((d) => !d.archived)
    .flatMap((d) =>
      [...d.versions].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 1),
    );
  const cases = (definitions.data ?? []).filter(
    (d) =>
      d.draft.workClassId === classId ||
      d.versions.some((v) => v.manifest.workClassId === classId),
  );
  const classFits = (fits.data ?? []).filter(
    (fit) => fit.workClassId === classId,
  );
  const classCampaigns = (campaigns.data ?? []).filter(
    (campaign) =>
      classFits.some((fit) => fit.id === campaign.plan.request.modelId) ||
      Boolean(campaign.plan.request.classModelIds?.[classId]) ||
      campaign.plan.cases.some((c) =>
        versions.some(
          (v) => v.id === c.versionId && v.manifest.workClassId === classId,
        ),
      ),
  );
  const certificates = (promotions.data ?? []).filter(
    ({ certificate }) =>
      certificate.contract.workClassId === classId ||
      certificate.trajectory?.steps.some(
        (s) => s.contract.workClassId === classId,
      ),
  );
  const navigate = (location: BenchmarkLocation) => {
    if (onNavigate) {
      onClose();
      onNavigate(location);
    }
  };
  const ready = !definitions.isPending && !definitions.error;
  const date = (time: number) =>
    formatDate(time, { dateStyle: "short", timeStyle: "short" });
  if (tool?.kind === "learning")
    return (
      <BenchmarkLearningDialog
        versions={currentVersions}
        initialWorkClassId={classId}
        initialFitId={tool.id}
        onClose={() => setTool(null)}
      />
    );
  if (tool?.kind === "campaign")
    return (
      <WorkflowCampaignDialog
        versions={versions}
        currentVersions={currentVersions}
        initialWorkClassId={classId}
        initialCampaignId={tool.id}
        showGovernance
        onClose={() => setTool(null)}
        onEvidence={(attemptId) =>
          navigate({ section: "leaderboard", attemptId })
        }
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            {t("policyManager.title", { category: workClassLabel(t, classId) })}
          </DialogTitle>
          <DialogDescription>
            {t("policyManager.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {[definitions.error, fits.error, campaigns.error, promotions.error]
            .filter(Boolean)
            .map((failure) => (
              <BenchmarkAlert key={benchmarkErrorMessage(failure)}>
                {benchmarkErrorMessage(failure)}
              </BenchmarkAlert>
            ))}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList variant="buttons" aria-label={t("policyManager.stages")}>
              {(
                ["cases", "training", "comparisons", "certificates"] as const
              ).map((stage) => (
                <TabsTrigger key={stage} value={stage} variant="buttons">
                  {t(`policyManager.${stage}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="cases" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t("policyManager.casesHint")}
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!onNavigate}
                onClick={() => navigate({ section: "development" })}
              >
                {t("policyManager.editCases")}
              </Button>
              {definitions.isPending ? (
                <p>{t("loading")}</p>
              ) : !definitions.error && !cases.length ? (
                <BenchmarkEmpty compact title={t("policyManager.noCases")} />
              ) : null}
              <div className="divide-y">
                {cases.map((definition) => (
                  <div
                    key={definition.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm">{definition.draft.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("policyManager.caseVersions", {
                          count: definition.versions.filter(
                            (v) => v.manifest.workClassId === classId,
                          ).length,
                        })}
                        {definition.archived
                          ? ` · ${t("policyManager.archived")}`
                          : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={!onNavigate}
                      onClick={() =>
                        navigate({
                          section: "development",
                          benchmarkId: definition.id,
                        })
                      }
                    >
                      {t("policyManager.reviewCase")}
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="training" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t("policyManager.trainingHint")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!ready}
                  onClick={() => setTool({ kind: "learning" })}
                >
                  {t("policyManager.prepareFit")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={previewLearned.isPending}
                  onClick={() => previewLearned.mutate()}
                >
                  {previewLearned.isPending
                    ? t("policyManager.previewRunning")
                    : t("policyManager.previewLearned")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("policyManager.previewHint")}
              </p>
              {previewLearned.error ? (
                <BenchmarkAlert>
                  {benchmarkErrorMessage(previewLearned.error)}
                </BenchmarkAlert>
              ) : null}
              {previewLearned.data ? (
                <p className="text-xs" role="status">
                  {t("policyManager.previewSaved", {
                    cases: previewLearned.data.cases.length,
                  })}
                </p>
              ) : null}
              {fits.isPending ? (
                <p>{t("loading")}</p>
              ) : !fits.error && !classFits.length ? (
                <BenchmarkEmpty compact title={t("policyManager.noFits")} />
              ) : null}
              <div className="divide-y">
                {classFits.map((fit) => (
                  <div
                    key={fit.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="space-y-1">
                      <p className="text-sm">
                        {date(fit.createdAt)} · {shortId(fit.id)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("policyManager.fitSummary", {
                          groups: fit.groups,
                          candidates: fit.candidates,
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={!ready}
                      onClick={() => setTool({ kind: "learning", id: fit.id })}
                    >
                      {t("actions.inspect")}
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="comparisons" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t("policyManager.comparisonsHint")}
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={
                  !ready ||
                  fits.isPending ||
                  Boolean(fits.error) ||
                  !classFits.length
                }
                onClick={() => setTool({ kind: "campaign" })}
              >
                {t("policyManager.prepareComparison")}
              </Button>
              {campaigns.isPending ||
              fits.isPending ||
              definitions.isPending ? (
                <p>{t("loading")}</p>
              ) : !campaigns.error &&
                !fits.error &&
                !definitions.error &&
                !classCampaigns.length ? (
                <BenchmarkEmpty
                  compact
                  title={t("policyManager.noComparisons")}
                />
              ) : null}
              <div className="divide-y">
                {classCampaigns.map((campaign) => (
                  <div
                    key={campaign.plan.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="space-y-1">
                      <p className="text-sm">
                        {date(campaign.plan.createdAt)} ·{" "}
                        {shortId(campaign.plan.id)}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <StateBadge state={campaign.state} />
                        <span>
                          {t("policyManager.progress", {
                            done: campaign.nextCell,
                            total: campaign.plan.cells.length,
                          })}
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={!ready}
                      onClick={() =>
                        setTool({ kind: "campaign", id: campaign.plan.id })
                      }
                    >
                      {t("policyManager.reportAndRule")}
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="certificates" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t("policyManager.scopeHint")}
              </p>
              {promotions.isPending ? (
                <p>{t("loading")}</p>
              ) : !promotions.error && !certificates.length ? (
                <div className="space-y-3">
                  <BenchmarkEmpty
                    compact
                    title={t("policyManager.noCertificates")}
                  />
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setTab("comparisons")}
                  >
                    {t("policyManager.viewComparisons")}
                  </Button>
                </div>
              ) : null}
              <div className="divide-y">
                {certificates.map(
                  ({ certificate, revokedAt, revocationReason }) => (
                    <div key={certificate.id} className="space-y-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm">
                          {date(certificate.createdAt)} ·{" "}
                          {shortId(certificate.id)}
                        </p>
                        <Badge
                          variant={revokedAt === null ? "secondary" : "outline"}
                        >
                          {t(
                            revokedAt === null
                              ? "policyManager.issued"
                              : "policyManager.revoked",
                          )}
                        </Badge>
                      </div>
                      <p className="text-xs">
                        {t("policyManager.certificateSummary", {
                          groups: certificate.assessment.groups,
                          quality: Math.round(
                            certificate.assessment.observedQuality * 100,
                          ),
                          floor: Math.round(
                            certificate.minPredictionQuality * 100,
                          ),
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("policyManager.contract", {
                          role:
                            certificate.contract.roleId ??
                            t("policyManager.noRole"),
                          runtime: certificate.contract.executionProfile,
                          seconds: certificate.contract.limits.timeoutSeconds,
                          steps: certificate.trajectory?.steps.length ?? 1,
                        })}
                      </p>
                      {revocationReason ? (
                        <BenchmarkAlert>{revocationReason}</BenchmarkAlert>
                      ) : null}
                      <details>
                        <summary className="cursor-pointer text-xs">
                          {t("promotion.certificate")}
                        </summary>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {JSON.stringify(certificate, null, 2)}
                        </pre>
                      </details>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={
                          !ready ||
                          campaigns.isPending ||
                          Boolean(campaigns.error) ||
                          !classCampaigns.some(
                            (c) => c.plan.id === certificate.campaignId,
                          )
                        }
                        onClick={() =>
                          setTool({
                            kind: "campaign",
                            id: certificate.campaignId,
                          })
                        }
                      >
                        {t("policyManager.manageCertificate")}
                      </Button>
                      {revokedAt === null ? (
                        <CertificateRevoke id={certificate.id} />
                      ) : null}
                    </div>
                  ),
                )}
              </div>
            </TabsContent>
          </Tabs>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
