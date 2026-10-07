import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { configurationKey } from "../lib/benchmarkBoards";
import { shortId } from "../lib/benchmarkLabels";
import { personaPrior } from "../lib/benchmarkSelector";
import {
  selectorTaskGroup,
  type SelectorFitArtifact,
  type SelectorHoldoutRequest,
} from "../lib/benchmarkLearning";
import type { BenchmarkVersion } from "../types";
import { BenchmarkAlert, Field, SelectField } from "./BenchmarkPrimitives";

/** Register decisions only. This form has no run or promotion action. */
export function SelectorHoldoutForm({
  artifact,
  versions,
}: {
  artifact: SelectorFitArtifact;
  versions: BenchmarkVersion[];
}) {
  const { t } = useTranslation("benchmarks");
  const checkboxPrefix = useId();
  const candidates = artifact.model.candidates;
  const preferred = personaPrior(
    artifact.model.workClassId,
    candidates.map((c) => c.configuration),
  )[0];
  const preferredKey =
    candidates.find(
      (c) =>
        preferred &&
        configurationKey(c.configuration) === configurationKey(preferred),
    )?.candidateKey ?? "none";
  const [persona, setPersona] = useState(preferredKey);
  const [fallback, setFallback] = useState(preferredKey);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingRequest, setPendingRequest] =
    useState<SelectorHoldoutRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({
    queryKey: ["benchmarks", "selector-holdouts", artifact.model.id],
    queryFn: () => benchmarkApi.listSelectorHoldouts(artifact.model.id),
  });
  const eligible = versions.filter(
    (v) =>
      v.manifest.workClassId === artifact.model.workClassId &&
      v.manifest.split === "held_out" &&
      !v.manifest.workflow &&
      !artifact.model.trainingFamilies.includes(v.manifest.taskFamily) &&
      !artifact.model.trainingGroups.includes(selectorTaskGroup(v.manifest)),
  );
  const groups = new Set(
    eligible
      .filter((v) => selected.includes(v.id))
      .map((v) => selectorTaskGroup(v.manifest)),
  );
  const options = [
    { value: "none", label: t("learning.holdout.chooseCandidate") },
    ...candidates.map((c) => ({
      value: c.candidateKey,
      label: configurationLabel(c.configuration),
    })),
  ];
  const freeze = async () => {
    const request = pendingRequest ?? {
      requestKey: crypto.randomUUID(),
      modelId: artifact.model.id,
      versionIds: selected,
      personaPrior: [
        persona,
        ...candidates
          .map((c) => c.candidateKey)
          .filter((key) => key !== persona),
      ],
      fallbackKey: fallback,
      minQuality: 0.5,
    };
    setPendingRequest(request);
    setBusy(true);
    setError(null);
    try {
      await benchmarkApi.freezeSelectorHoldout(request);
      await plans.refetch();
      setPendingRequest(null);
      setSelected([]);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">{t("learning.holdout.title")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("learning.holdout.description")}
      </p>
      {error || plans.error ? (
        <BenchmarkAlert>
          {error ?? benchmarkErrorMessage(plans.error)}
        </BenchmarkAlert>
      ) : null}
      <fieldset
        disabled={busy || pendingRequest !== null}
        className="max-h-44 space-y-2 overflow-y-auto"
      >
        <legend className="text-sm">
          {t("learning.holdout.selected", {
            cases: selected.length,
            groups: groups.size,
          })}
        </legend>
        {eligible.map((version) => (
          <label
            key={version.id}
            htmlFor={`${checkboxPrefix}-${version.id}`}
            className="flex items-start gap-2 text-sm"
          >
            <Checkbox
              id={`${checkboxPrefix}-${version.id}`}
              checked={selected.includes(version.id)}
              onCheckedChange={(checked) =>
                setSelected(
                  checked
                    ? [...selected, version.id]
                    : selected.filter((id) => id !== version.id),
                )
              }
            />
            <span>{version.manifest.name}</span>
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("learning.holdout.persona")}>
          {(id) => (
            <SelectField
              id={id}
              value={persona}
              onChange={setPersona}
              options={options}
              disabled={busy || pendingRequest !== null}
            />
          )}
        </Field>
        <Field label={t("learning.holdout.fallback")}>
          {(id) => (
            <SelectField
              id={id}
              value={fallback}
              onChange={setFallback}
              options={options}
              disabled={busy || pendingRequest !== null}
            />
          )}
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("learning.holdout.reservation")}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={
            busy ||
            selected.length < 8 ||
            groups.size < 4 ||
            persona === "none" ||
            fallback === "none"
          }
          onClick={() => void freeze()}
        >
          {t(
            pendingRequest
              ? "learning.holdout.retry"
              : "learning.holdout.freeze",
          )}
        </Button>
        {pendingRequest && !busy ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPendingRequest(null);
              setError(null);
            }}
          >
            {t("learning.holdout.edit")}
          </Button>
        ) : null}
      </div>
      {(plans.data ?? []).map((plan) => (
        <details key={plan.id} className="rounded border p-3 text-sm">
          <summary className="cursor-pointer">
            {t("learning.holdout.plan", {
              id: shortId(plan.id),
              count: plan.cases.length,
            })}
          </summary>
          <p className="py-2 text-xs text-muted-foreground">
            {t("learning.holdout.pending")}
          </p>
          {plan.cases.map((entry) => (
            <p key={entry.versionId} className="text-xs">
              {entry.family} ·{" "}
              {t("learning.holdout.choice", {
                learned: configurationLabel(
                  plan.configurations.find((c) => c.id === entry.learnedKey) ??
                    plan.configurations[0],
                ),
                aggregate: configurationLabel(
                  plan.configurations.find(
                    (c) => c.id === entry.aggregateKey,
                  ) ?? plan.configurations[0],
                ),
              })}
              {entry.learnedAbstention
                ? ` · ${t("learning.holdout.usedFallback")}`
                : ""}
            </p>
          ))}
        </details>
      ))}
    </section>
  );
}
