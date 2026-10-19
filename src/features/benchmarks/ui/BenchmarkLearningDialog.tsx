import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
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
import { configurationKey } from "../lib/benchmarkBoards";
import { configurationLabel } from "../lib/benchmarkDraft";
import { shortId, workClassLabel } from "../lib/benchmarkLabels";
import {
  publicSelectorTask,
  selectorTaskGroup,
  type SelectorPrediction,
} from "../lib/benchmarkLearning";
import type { BenchmarkVersionSummary } from "../types";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  SelectField,
} from "./BenchmarkPrimitives";

function SelectionCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <span className="break-words">{children}</span>
    </label>
  );
}

export function BenchmarkLearningDialog({
  versions,
  onClose,
  initialWorkClassId,
  initialFitId,
}: {
  initialWorkClassId?: string;
  initialFitId?: string;
  versions: BenchmarkVersionSummary[];
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const classes = [
    ...new Set([
      ...versions.map((v) => v.manifest.workClassId),
      ...(initialWorkClassId ? [initialWorkClassId] : []),
    ]),
  ].sort();
  const [workClass, setWorkClass] = useState(
    initialWorkClassId ?? classes[0] ?? "general",
  );
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [weightPercentages, setWeightPercentages] = useState({
    quality: "85",
    speed: "15",
    cost: "0",
  });
  const [fitId, setFitId] = useState(initialFitId ?? "none");
  const [targetId, setTargetId] = useState("none");
  const [available, setAvailable] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SelectorPrediction | null>(null);
  const fits = useQuery({
    queryKey: ["benchmarks", "learned-fits"],
    queryFn: benchmarkApi.listSelectorFits,
  });
  const artifact = useQuery({
    queryKey: ["benchmarks", "learned-fit", fitId],
    queryFn: () => benchmarkApi.getSelectorFit(fitId),
    enabled: fitId !== "none",
  });
  const board = useQuery({
    queryKey: ["benchmarks", "learning-candidates"],
    queryFn: () =>
      benchmarkApi.getLeaderboard({
        runId: null,
        versionIds: null,
        limit: 500,
      }),
  });
  const candidates = (board.data?.rows ?? [])
    .filter((r) => r.configuration.inventoryRevision)
    .map((r) => r.configuration);
  const train = versions.filter(
    (v) =>
      v.manifest.workClassId === workClass &&
      v.manifest.split === "train" &&
      !v.manifest.workflow,
  );
  const targets = versions.filter(
    (v) =>
      v.manifest.workClassId === artifact.data?.model.workClassId &&
      !v.manifest.workflow,
  );
  const target = targets.find((v) => v.id === targetId);
  const weights = {
    quality: Number(weightPercentages.quality) / 100,
    speed: Number(weightPercentages.speed) / 100,
    cost: Number(weightPercentages.cost) / 100,
  };
  const validWeights =
    Object.values(weightPercentages).every((value) => value.trim() !== "") &&
    Object.values(weights).every(
      (value) => Number.isFinite(value) && value >= 0,
    ) &&
    weights.quality >= 0.5 &&
    Math.abs(weights.quality + weights.speed + weights.cost - 1) <= 1e-9;
  const toggle = (values: string[], value: string) =>
    values.includes(value)
      ? values.filter((id) => id !== value)
      : [...values, value];
  const trainModel = async () => {
    if (!validWeights) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fit = await benchmarkApi.fitSelector({
        workClassId: workClass,
        versionIds: selectedVersions,
        configurations: candidates.filter((c) =>
          selectedCandidates.includes(configurationKey(c)),
        ),
        cutoffAt: Date.now(),
        weights,
      });
      await fits.refetch();
      setFitId(fit.id);
      setAvailable([]);
      setTargetId("none");
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const predict = async () => {
    if (!target || !artifact.data) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // The list carries no task contents; read the one target's manifest.
      const full = await benchmarkApi.getVersion(target.id);
      setResult(
        await benchmarkApi.predictSelector(fitId, {
          task: publicSelectorTask(full.manifest),
          targetFamily: target.manifest.taskFamily,
          targetGroup: selectorTaskGroup(target.manifest),
          minQuality: 0.5,
          hardCandidateKey: null,
          candidates: artifact.data.model.candidates.map((trained) => ({
            configuration:
              candidates.find(
                (c) =>
                  configurationKey(c) ===
                  configurationKey(trained.configuration),
              ) ?? trained.configuration,
            available: available.includes(trained.candidateKey),
            reason: null,
          })),
        }),
      );
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("learning.title")}</DialogTitle>
          <DialogDescription>{t("learning.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {[
            ...new Set(
              [error, fits.error, artifact.error, board.error]
                .filter(Boolean)
                .map(benchmarkErrorMessage),
            ),
          ].map((message) => (
            <BenchmarkAlert key={message}>{message}</BenchmarkAlert>
          ))}
          <p className="text-sm text-muted-foreground">{t("learning.gate")}</p>
          <Field label={t("learning.workClass")}>
            {(id) => (
              <SelectField
                id={id}
                value={workClass}
                disabled={busy}
                onChange={(value) => {
                  setWorkClass(value);
                  setSelectedVersions([]);
                  setSelectedCandidates([]);
                }}
                options={classes.map((value) => ({
                  value,
                  label: workClassLabel(t, value),
                }))}
              />
            )}
          </Field>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="text-sm font-medium">
              {t("learning.cases", { count: selectedVersions.length })}
            </legend>
            <div className="max-h-44 space-y-2 overflow-y-auto">
              {train.length ? (
                train.map((v) => (
                  <SelectionCheckbox
                    key={v.id}
                    checked={selectedVersions.includes(v.id)}
                    onChange={() =>
                      setSelectedVersions(toggle(selectedVersions, v.id))
                    }
                  >
                    {v.manifest.name}
                  </SelectionCheckbox>
                ))
              ) : (
                <BenchmarkEmpty title={t("learning.noCases")} />
              )}
            </div>
          </fieldset>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="text-sm font-medium">
              {t("learning.candidates")}
            </legend>
            <div className="max-h-36 space-y-2 overflow-y-auto">
              {candidates.map((c) => (
                <SelectionCheckbox
                  key={configurationKey(c)}
                  checked={selectedCandidates.includes(configurationKey(c))}
                  onChange={() =>
                    setSelectedCandidates(
                      toggle(selectedCandidates, configurationKey(c)),
                    )
                  }
                >
                  {configurationLabel(c)}
                </SelectionCheckbox>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-muted-foreground">
            {t("learning.requirements")}
          </p>
          <fieldset disabled={busy} className="space-y-3">
            <legend className="text-sm font-medium">
              {t("learning.weights.title")}
            </legend>
            <div className="grid grid-cols-3 gap-3">
              {(["quality", "speed", "cost"] as const).map((dimension) => (
                <Field
                  key={dimension}
                  label={t(`learning.weights.${dimension}`)}
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={dimension === "quality" ? 50 : 0}
                      max={100}
                      step={1}
                      value={weightPercentages[dimension]}
                      onChange={(event) =>
                        setWeightPercentages((current) => ({
                          ...current,
                          [dimension]: event.target.value,
                        }))
                      }
                    />
                  )}
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("learning.weights.hint")}
            </p>
            {!validWeights ? (
              <BenchmarkAlert>{t("learning.weights.invalid")}</BenchmarkAlert>
            ) : null}
          </fieldset>
          <Button
            type="button"
            disabled={
              busy ||
              selectedVersions.length < 8 ||
              selectedCandidates.length < 2 ||
              !validWeights
            }
            onClick={() => void trainModel()}
          >
            {t("learning.fit")}
          </Button>
          <Field label={t("learning.saved")}>
            {(id) => (
              <SelectField
                id={id}
                value={fitId}
                disabled={busy}
                onChange={(value) => {
                  setFitId(value);
                  setTargetId("none");
                  setAvailable([]);
                  setResult(null);
                }}
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
          {artifact.data ? (
            <section className="space-y-4">
              <p className="text-sm">
                {t("learning.coverage", {
                  cases: artifact.data.model.commonCases,
                  groups: artifact.data.model.trainingGroups.length,
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("learning.weights.saved", {
                  quality: artifact.data.snapshot.request.weights.quality * 100,
                  speed: artifact.data.snapshot.request.weights.speed * 100,
                  cost: artifact.data.snapshot.request.weights.cost * 100,
                })}
              </p>
              <details className="text-sm">
                <summary className="cursor-pointer">
                  {t("learning.trainingEvidence")}
                </summary>
                <div className="max-h-52 space-y-2 overflow-y-auto pt-2">
                  {artifact.data.snapshot.examples.map((example) => (
                    <div key={example.versionId} className="rounded border p-2">
                      <p className="line-clamp-2">{example.task.prompt}</p>
                      <p className="text-xs text-muted-foreground">
                        {example.family} · {example.evaluatorRevision}
                      </p>
                      {example.targets.map((target) => {
                        const configuration =
                          artifact.data?.model.candidates.find(
                            (c) => c.candidateKey === target.candidateKey,
                          )?.configuration;
                        return (
                          <p key={target.candidateKey} className="text-xs">
                            {configuration
                              ? configurationLabel(configuration)
                              : shortId(target.candidateKey)}
                            :{" "}
                            {target.reward == null
                              ? t("unknown")
                              : Math.round(target.reward * 1000)}
                          </p>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </details>
              <Field label={t("learning.target")}>
                {(id) => (
                  <SelectField
                    id={id}
                    value={targetId}
                    disabled={busy}
                    onChange={(value) => {
                      setTargetId(value);
                      setResult(null);
                    }}
                    options={[
                      { value: "none", label: t("learning.chooseTarget") },
                      ...targets.map((v) => ({
                        value: v.id,
                        label: v.manifest.name,
                      })),
                    ]}
                  />
                )}
              </Field>
              <fieldset disabled={busy} className="space-y-2">
                <legend className="text-sm font-medium">
                  {t("learning.availability")}
                </legend>
                <p className="text-xs text-muted-foreground">
                  {t("learning.availabilityHint")}
                </p>
                {artifact.data.model.candidates.map((c) => (
                  <SelectionCheckbox
                    key={c.candidateKey}
                    checked={available.includes(c.candidateKey)}
                    onChange={() => {
                      setAvailable(toggle(available, c.candidateKey));
                      setResult(null);
                    }}
                  >
                    {configurationLabel(c.configuration)}
                  </SelectionCheckbox>
                ))}
              </fieldset>
              <Button
                type="button"
                disabled={busy || !target}
                onClick={() => void predict()}
              >
                {t("learning.predict")}
              </Button>
              {result ? (
                <div className="space-y-2 rounded border p-3 text-sm">
                  <p>
                    {t(`learning.reasons.${result.reason}`, {
                      defaultValue: result.reason,
                    })}
                  </p>
                  {result.chosen ? (
                    <p className="font-medium">
                      {configurationLabel(result.chosen)}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {t("learning.estimates")}
                  </p>
                  {result.scores.map((score) => (
                    <p key={score.candidateKey}>
                      {configurationLabel(score.configuration)} ·{" "}
                      {t("learning.score", {
                        quality: Math.round(score.quality * 1000),
                        utility: Math.round(score.utility * 1000),
                      })}
                    </p>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            {t("actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
