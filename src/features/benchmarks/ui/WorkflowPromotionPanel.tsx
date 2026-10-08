import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import {
  type DeploymentContract,
  type PromotionRegistration,
  type PromotionState,
  type RegisteredPromotionRule,
  rolesWavesCannotName,
} from "../lib/benchmarkGovernance";
import type { WorkflowCampaign } from "../lib/workflowCampaign";
import { BenchmarkAlert, Field } from "./BenchmarkPrimitives";

const promotionsKey = ["benchmarks", "promotions"];

function contractIdentity(contract: DeploymentContract) {
  return [
    contract.workClassId,
    contract.roleId,
    contract.rolePrompt,
    contract.executionProfile,
    contract.entryPresent,
    contract.permissions.context,
    contract.permissions.network,
    [...new Set(contract.permissions.tools)].sort(),
    contract.limits.timeoutSeconds,
    contract.limits.maxTurns,
    contract.limits.maxArtifactBytes,
    contract.budgetRecipe ?? null,
    contract.repositoryRecipe ?? null,
  ];
}

function registrationIdentity(request: PromotionRegistration): string {
  const { rule, contract, trajectory } = request;
  // Native registration canonicalizes only these sets; every other field is exact.
  return JSON.stringify([
    request.requestKey,
    request.campaignId,
    request.operator,
    rule.recipe,
    rule.alpha,
    rule.minimumGroupUtilityGain,
    rule.minimumObservedQuality,
    contractIdentity(contract),
    trajectory
      ? [trajectory.rootBudgetSeconds, trajectory.steps.map(contractIdentity)]
      : null,
    [...request.qualificationIds].sort(),
  ]);
}

function matchesRegistration(
  saved: RegisteredPromotionRule,
  request: PromotionRegistration,
  campaign: WorkflowCampaign,
): boolean {
  return (
    saved.request.campaignId === campaign.plan.id &&
    saved.planHash === campaign.planHash &&
    registrationIdentity(saved.request) === registrationIdentity(request)
  );
}

export function WorkflowPromotionPanel({
  campaign,
  onPendingChange,
  disabled = false,
}: {
  campaign: WorkflowCampaign;
  onPendingChange: (pending: boolean) => boolean | undefined;
  disabled?: boolean;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [operator, setOperator] = useState("");
  const [alpha, setAlpha] = useState("");
  const [gain, setGain] = useState("");
  const [quality, setQuality] = useState("");
  const [qualificationIds, setQualificationIds] = useState("");
  const [submitted, setSubmitted] = useState<PromotionRegistration | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [registrationPending, setRegistrationPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const ruleKey = ["benchmarks", "promotion-rule", campaign.plan.id];
  const rule = useQuery({
    queryKey: ruleKey,
    queryFn: () => api.getPromotionRule(campaign.plan.id),
    retry: false,
  });
  const promotions = useQuery({
    queryKey: promotionsKey,
    queryFn: api.listPromotions,
    retry: false,
  });
  const confirmedRule =
    rule.data &&
    rule.data.request.campaignId === campaign.plan.id &&
    rule.data.planHash === campaign.planHash &&
    (!submitted || matchesRegistration(rule.data, submitted, campaign))
      ? rule.data
      : null;
  useEffect(() => {
    if (
      registrationPending &&
      !inFlight.current &&
      !rule.isFetching &&
      !rule.isError &&
      rule.data &&
      submitted &&
      matchesRegistration(rule.data, submitted, campaign)
    ) {
      setRegistrationPending(false);
      setError(null);
      onPendingChange(false);
    }
  }, [
    registrationPending,
    rule.isFetching,
    rule.isError,
    rule.data,
    submitted,
    campaign,
    onPendingChange,
  ]);
  const promotion = promotions.data?.find(
    (p) => p.certificate.campaignId === campaign.plan.id,
  );
  const pristine = campaign.state === "reserved" && campaign.nextCell === 0;
  // The exact contract or trajectory the campaign evaluated, computed
  // natively from its frozen cases; the renderer never assembles it.
  const deployment = useQuery({
    queryKey: ["benchmarks", "campaign-deployment", campaign.plan.id],
    queryFn: () => api.campaignDeployment(campaign.plan.id),
    enabled: pristine && rule.data === null,
    retry: false,
  });
  const contract = deployment.data?.contract ?? null;
  const trajectory = deployment.data?.trajectory ?? null;
  const unusableRoles = trajectory
    ? rolesWavesCannotName(trajectory.steps.map((step) => step.roleId))
    : [];
  const ids = qualificationIds.split(/[\s,]+/).filter(Boolean);
  const valid =
    Boolean(contract) &&
    operator.trim() !== "" &&
    ids.length > 0 &&
    new Set(ids).size === ids.length &&
    alpha.trim() !== "" &&
    Number.isFinite(Number(alpha)) &&
    Number(alpha) > 0 &&
    Number(alpha) <= 0.05 &&
    gain.trim() !== "" &&
    Number.isFinite(Number(gain)) &&
    Number(gain) >= 0 &&
    Number(gain) < 1 &&
    quality.trim() !== "" &&
    Number.isFinite(Number(quality)) &&
    Number(quality) >= 0 &&
    Number(quality) <= 1;
  const register = async () => {
    if (
      disabled ||
      inFlight.current ||
      !contract ||
      (!submitted && !valid) ||
      onPendingChange(true) === false
    )
      return;
    const request = submitted ?? {
      requestKey: crypto.randomUUID(),
      campaignId: campaign.plan.id,
      operator: operator.trim(),
      rule: {
        recipe: "independent-group-sign-holm-v1" as const,
        alpha: Number(alpha),
        minimumGroupUtilityGain: Number(gain),
        minimumObservedQuality: Number(quality),
      },
      contract,
      qualificationIds: ids,
      ...(trajectory ? { trajectory } : {}),
    };
    setSubmitted(request);
    setRegistrationPending(true);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let nativeSaved = false;
    try {
      const saved = await api.registerPromotionRule(request);
      client.setQueryData(ruleKey, saved);
      nativeSaved = matchesRegistration(saved, request, campaign);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      const checked = await rule.refetch();
      // An unreadable registration reply cannot race the first campaign start.
      const unresolved =
        !nativeSaved &&
        (checked.isError ||
          (checked.data !== null &&
            (!checked.data ||
              !matchesRegistration(checked.data, request, campaign))));
      setRegistrationPending(unresolved);
      onPendingChange(unresolved);
      inFlight.current = false;
      setBusy(false);
    }
  };
  const operate = async (operation: () => Promise<PromotionState>) => {
    if (
      disabled ||
      registrationPending ||
      inFlight.current ||
      onPendingChange(true) === false
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await operation();
      client.setQueryData<PromotionState[]>(promotionsKey, (previous) => [
        saved,
        ...(previous ?? []).filter(
          (p) => p.certificate.id !== saved.certificate.id,
        ),
      ]);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      await promotions.refetch();
      onPendingChange(false);
      inFlight.current = false;
      setBusy(false);
    }
  };
  const numberField = (
    label: string,
    value: string,
    set: (value: string) => void,
    max: number,
  ) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={0}
          max={max}
          step="any"
          value={value}
          disabled={disabled || busy || Boolean(submitted)}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );
  return (
    <section
      className="space-y-3 border-t pt-3"
      aria-label={t("promotion.title")}
    >
      <h4 className="text-sm font-medium">{t("promotion.title")}</h4>
      <p className="text-xs text-muted-foreground">{t("promotion.notice")}</p>
      {[error, rule.error, promotions.error, deployment.error]
        .filter(Boolean)
        .map((failure) => (
          <BenchmarkAlert key={benchmarkErrorMessage(failure)}>
            {benchmarkErrorMessage(failure)}
          </BenchmarkAlert>
        ))}
      {rule.isPending ? <p className="text-sm">{t("loading")}</p> : null}
      {confirmedRule ? (
        <>
          <p role="status" className="text-sm">
            {t("promotion.registered")}
          </p>
          <p className="text-xs">
            {t("promotion.operator")}: {confirmedRule.request.operator}
          </p>
          <details>
            <summary className="cursor-pointer text-xs">
              {t("promotion.ruleEvidence")}
            </summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(confirmedRule, null, 2)}
            </pre>
          </details>
        </>
      ) : rule.data === null ? (
        <>
          <p className="text-xs">
            {t(pristine ? "promotion.researchStart" : "promotion.tooLate")}
          </p>
          {pristine ? (
            <details>
              <summary className="cursor-pointer text-sm">
                {t("promotion.prepare")}
              </summary>
              <div className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">
                  {t("promotion.ruleHint")}
                </p>
                <Field label={t("promotion.operator")}>
                  {(id) => (
                    <Input
                      id={id}
                      maxLength={256}
                      value={operator}
                      disabled={disabled || busy || Boolean(submitted)}
                      onChange={(event) => setOperator(event.target.value)}
                    />
                  )}
                </Field>
                <div className="grid gap-3 md:grid-cols-3">
                  {numberField(t("promotion.alpha"), alpha, setAlpha, 0.05)}
                  {numberField(t("promotion.gain"), gain, setGain, 1)}
                  {numberField(t("promotion.quality"), quality, setQuality, 1)}
                </div>
                <Field
                  label={t("promotion.qualifications")}
                  hint={t("promotion.qualificationsHint")}
                >
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={4}
                      value={qualificationIds}
                      disabled={disabled || busy || Boolean(submitted)}
                      onChange={(event) =>
                        setQualificationIds(event.target.value)
                      }
                    />
                  )}
                </Field>
                <p className="text-xs">{t("promotion.scopeHint")}</p>
                {unusableRoles.length ? (
                  <Alert>
                    <AlertDescription>
                      {t("campaign.unusableWaveRoles", {
                        roles: unusableRoles.join(", "),
                      })}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {trajectory ? (
                  <p className="text-xs">
                    {t("promotion.trajectoryScope", {
                      count: trajectory.steps.length,
                      seconds: trajectory.rootBudgetSeconds,
                    })}
                  </p>
                ) : null}
                {deployment.data ? (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(trajectory ?? contract, null, 2)}
                  </pre>
                ) : deployment.isPending ? (
                  <p className="text-sm">{t("loading")}</p>
                ) : null}
                {submitted ? (
                  <p className="text-xs">{t("promotion.immutableRetry")}</p>
                ) : null}
                {submitted && error && !rule.error ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || busy}
                    onClick={() => {
                      setSubmitted(null);
                      setRegistrationPending(false);
                      setError(null);
                      onPendingChange(false);
                    }}
                  >
                    {t("governance.changeUnregistered")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  disabled={disabled || busy || (!submitted && !valid)}
                  onClick={() => void register()}
                >
                  {t(submitted ? "promotion.retry" : "promotion.register")}
                </Button>
              </div>
            </details>
          ) : null}
        </>
      ) : null}
      {registrationPending && submitted && rule.data && !confirmedRule ? (
        <div className="space-y-2">
          <p className="text-xs">{t("promotion.immutableRetry")}</p>
          <Button
            type="button"
            disabled={disabled || busy}
            onClick={() => void register()}
          >
            {t("promotion.retry")}
          </Button>
        </div>
      ) : null}
      {confirmedRule && !promotion && campaign.state === "completed" ? (
        <>
          <p className="text-xs">{t("promotion.activateNotice")}</p>
          <Button
            type="button"
            disabled={
              disabled ||
              busy ||
              promotions.isPending ||
              Boolean(promotions.error)
            }
            onClick={() =>
              void operate(() => api.promoteSelector(campaign.plan.id))
            }
          >
            {t("promotion.activate")}
          </Button>
        </>
      ) : null}
      {promotion ? (
        <>
          <p role="status" className="text-sm">
            {t(
              promotion.revokedAt === null
                ? "promotion.issued"
                : "promotion.revoked",
            )}
          </p>
          <code className="block break-all text-xs">
            {promotion.certificate.id}
          </code>
          <p className="text-xs text-muted-foreground">
            {t("promotion.dispatchNotice")}
          </p>
          {promotion.certificate.trajectory ? (
            <p className="text-xs">
              {t("promotion.trajectoryCertificate", {
                count: promotion.certificate.trajectory.steps.length,
              })}
            </p>
          ) : null}
          <p className="text-xs">
            {t("promotion.fallback", {
              keys: promotion.certificate.priorKeys.join(", "),
              quality: promotion.certificate.minPredictionQuality,
            })}
          </p>
          {promotion.revocationReason ? (
            <BenchmarkAlert>{promotion.revocationReason}</BenchmarkAlert>
          ) : null}
          {promotion.certificate.assessment.limitations.map((limitation) => (
            <p key={limitation} className="text-xs text-muted-foreground">
              {limitation}
            </p>
          ))}
          <details>
            <summary className="cursor-pointer text-xs">
              {t("promotion.certificate")}
            </summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(promotion, null, 2)}
            </pre>
          </details>
          {promotion.revokedAt === null ? (
            <div className="space-y-2">
              <Field label={t("governance.revocationReason")}>
                {(id) => (
                  <Textarea
                    id={id}
                    maxLength={16384}
                    value={reason}
                    disabled={disabled || busy}
                    onChange={(event) => setReason(event.target.value)}
                  />
                )}
              </Field>
              <Button
                type="button"
                variant="outline"
                disabled={disabled || busy || !reason.trim()}
                onClick={() =>
                  void operate(() =>
                    api.revokePromotion(
                      promotion.certificate.id,
                      reason.trim(),
                    ),
                  )
                }
              >
                {t("promotion.revoke")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
