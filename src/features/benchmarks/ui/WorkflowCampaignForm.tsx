import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listProviderAccounts } from "@/features/providers/api/providerAccounts";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import {
  selectorTaskGroup,
  type SelectorFitArtifact,
} from "../lib/benchmarkLearning";
import type {
  WorkflowCampaign,
  WorkflowCampaignRequest,
} from "../lib/workflowCampaign";
import type { BenchmarkVersion } from "../types";
import { BenchmarkAlert, Field, SelectField } from "./BenchmarkPrimitives";

export function WorkflowCampaignForm({
  artifact,
  versions,
  onFrozen,
  onReservationPendingChange,
}: {
  artifact: SelectorFitArtifact;
  versions: BenchmarkVersion[];
  onFrozen: (campaign: WorkflowCampaign) => void;
  onReservationPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const prefix = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const [persona, setPersona] = useState("none");
  const [repetitions, setRepetitions] = useState(3);
  const [minQuality, setMinQuality] = useState(0.5);
  const [pending, setPending] = useState<WorkflowCampaignRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const inFlight = useRef(false);
  const accountQuery = useQuery({
    queryKey: ["benchmark-run-accounts"],
    queryFn: listProviderAccounts,
  });
  const capabilities = useQuery({
    queryKey: ["benchmarks", "capabilities"],
    queryFn: benchmarkApi.getCapabilities,
  });
  const candidates = artifact.model.candidates;
  const bindings = candidates.map((candidate) => {
    const configuration = candidate.configuration;
    const capability = capabilities.data?.find(
      (c) =>
        c.providerId === configuration.providerId &&
        c.executionProfile === configuration.executionProfile,
    );
    const options =
      accountQuery.data?.accounts
        .filter((a) => a.enabled && a.providerId === configuration.providerId)
        .map((a) => ({ value: a.id, label: a.label })) ?? [];
    const cli = capability?.cliAccountId;
    if (cli && !options.some((o) => o.value === cli))
      options.push({ value: cli, label: t("campaign.cliAccount") });
    return { candidate, capability, options };
  });
  const eligible = versions.filter(
    (v) =>
      v.manifest.workflow &&
      v.manifest.split === "held_out" &&
      v.manifest.workClassId === artifact.model.workClassId &&
      !artifact.model.trainingFamilies.includes(v.manifest.taskFamily) &&
      !artifact.model.trainingGroups.includes(selectorTaskGroup(v.manifest)),
  );
  const chosen = eligible.filter((v) => selected.includes(v.id));
  const groups = new Set(chosen.map((v) => selectorTaskGroup(v.manifest))).size;
  const policies = candidates.length + 3;
  const executions =
    chosen.reduce(
      (sum, v) => sum + (v.manifest.workflow?.steps.length ?? 0),
      0,
    ) *
    policies *
    repetitions;
  const timeoutSeconds = Math.max(
    1,
    ...chosen.map((v) => v.manifest.limits.timeoutSeconds),
  );
  const locked = busy || pending !== null;
  const valid =
    chosen.length >= 8 &&
    chosen.length <= 256 &&
    groups >= 4 &&
    candidates.length >= 2 &&
    bindings.every(
      ({ candidate, capability, options }) =>
        capability?.supported &&
        options.some((o) => o.value === accounts[candidate.candidateKey]),
    ) &&
    candidates.some((c) => c.candidateKey === persona) &&
    Number.isInteger(repetitions) &&
    repetitions >= Math.max(3, ...chosen.map((v) => v.manifest.repetitions)) &&
    repetitions <= 20 &&
    chosen.length * policies * repetitions <= 10000 &&
    executions <= 100000 &&
    timeoutSeconds <= 3600 &&
    Number.isFinite(minQuality) &&
    minQuality >= 0 &&
    minQuality <= 1;
  const freeze = async () => {
    if (inFlight.current || (!pending && !valid)) return;
    inFlight.current = true;
    const request = pending ?? {
      requestKey: crypto.randomUUID(),
      modelId: artifact.model.id,
      versionIds: chosen.map((v) => v.id),
      candidates: candidates.map((c) => ({
        ...c.configuration,
        id: c.candidateKey,
        accountId: accounts[c.candidateKey],
      })),
      personaPriorIds: [
        persona,
        ...candidates
          .map((c) => c.candidateKey)
          .filter((key) => key !== persona),
      ],
      minQuality,
      repetitions,
      timeoutSeconds,
      maxExecutions: executions,
    };
    setPending(request);
    onReservationPendingChange?.(true);
    setBusy(true);
    setError(null);
    setRejected(false);
    try {
      const saved = await benchmarkApi.freezeWorkflowCampaign(request);
      onFrozen(saved);
      setPending(null);
      onReservationPendingChange?.(false);
      setSelected([]);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
      // This code also covers post-commit reads, so only known validation
      // failures prove that changing inputs cannot abandon a reservation.
      if (failure && typeof failure === "object" && "code" in failure) {
        setRejected(
          failure.code === "invalid_workflow_policy" ||
            (failure.code === "invalid_workflow_campaign" &&
              "message" in failure &&
              [
                "Campaign requires distinct held-out cases, a request key and bounded repetitions, time and executions",
                "Campaign version is not in the current pool",
                "Campaign requires objective workflows",
                "Campaign needs unused held-out workflow families in the fitted scope and all required repetitions/budgets",
                "Campaign requires four independent declared groups",
                "Campaign execution budget does not cover all policies and repetitions",
                "Campaign is limited to 10000 trajectories",
                "Historical family relations join declared independent groups",
                "Related campaign families cross dataset splits",
                "Campaign version disappeared",
                "Campaign version changed during reservation",
                "Campaign family already appeared in a run plan",
                "Campaign family already has an attempt",
                "Family is reserved by another evaluation",
              ].includes(String(failure.message))),
        );
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4 rounded border p-4">
      <h3 className="text-sm font-medium">{t("campaign.new")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("campaign.requirements")}
      </p>
      {[error, accountQuery.error, capabilities.error]
        .filter(Boolean)
        .map((failure) => (
          <BenchmarkAlert key={benchmarkErrorMessage(failure)}>
            {benchmarkErrorMessage(failure)}
          </BenchmarkAlert>
        ))}
      <fieldset disabled={locked} className="space-y-2">
        <legend className="text-sm">
          {t("learning.holdout.selected", { cases: chosen.length, groups })}
        </legend>
        <div className="max-h-44 space-y-2 overflow-y-auto">
          {eligible.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("campaign.noCases")}
            </p>
          ) : null}
          {eligible.map((v) => (
            <label
              key={v.id}
              htmlFor={`${prefix}-${v.id}`}
              className="flex items-start gap-2 text-sm"
            >
              <Checkbox
                id={`${prefix}-${v.id}`}
                disabled={locked}
                checked={selected.includes(v.id)}
                onCheckedChange={(checked) =>
                  setSelected(
                    checked
                      ? [...selected, v.id]
                      : selected.filter((id) => id !== v.id),
                  )
                }
              />
              <span>{v.manifest.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {bindings.map(({ candidate, capability, options }) => {
        const configuration = candidate.configuration;
        return (
          <Field
            key={candidate.candidateKey}
            label={`${configurationLabel(configuration)} · ${t("fields.account")}`}
            hint={
              capability?.supported === false
                ? capability.reason
                : accountQuery.isSuccess &&
                    capabilities.isSuccess &&
                    options.length === 0
                  ? t("campaign.noAccounts")
                  : undefined
            }
          >
            {(id) => (
              <SelectField
                id={id}
                value={accounts[candidate.candidateKey] ?? "none"}
                disabled={locked}
                options={[
                  { value: "none", label: t("campaign.chooseAccount") },
                  ...options,
                ]}
                onChange={(value) =>
                  setAccounts({
                    ...accounts,
                    [candidate.candidateKey]: value === "none" ? "" : value,
                  })
                }
              />
            )}
          </Field>
        );
      })}
      <Field label={t("learning.holdout.persona")}>
        {(id) => (
          <SelectField
            id={id}
            value={persona}
            onChange={setPersona}
            disabled={locked}
            options={[
              { value: "none", label: t("learning.holdout.chooseCandidate") },
              ...candidates.map((c) => ({
                value: c.candidateKey,
                label: configurationLabel(c.configuration),
              })),
            ]}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.repetitions")}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={3}
              max={20}
              value={repetitions}
              disabled={locked}
              onChange={(e) => setRepetitions(Number(e.target.value))}
            />
          )}
        </Field>
        <Field label={t("campaign.minQuality")}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minQuality}
              disabled={locked}
              onChange={(e) => setMinQuality(Number(e.target.value))}
            />
          )}
        </Field>
      </div>
      <p className="text-sm">
        {t("campaign.budget", {
          policies,
          trajectories: chosen.length * policies * repetitions,
          executions,
          timeout: timeoutSeconds,
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("campaign.freezeNotice")}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy || (!pending && !valid)}
          onClick={() => void freeze()}
        >
          {t(pending ? "learning.holdout.retry" : "campaign.freeze")}
        </Button>
        {pending && !busy && rejected ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPending(null);
              onReservationPendingChange?.(false);
              setError(null);
            }}
          >
            {t("learning.holdout.edit")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
