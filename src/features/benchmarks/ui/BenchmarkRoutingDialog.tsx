import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { formatQuality, shortId } from "../lib/benchmarkLabels";
import type {
  BenchmarkVersion,
  Configuration,
  RoutingEvidence,
  RoutingEvidenceQuery,
  RunSummary,
} from "../types";
import { BenchmarkEvidenceLinks } from "./BenchmarkEvidenceLinks";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  SelectField,
  StateBadge,
} from "./BenchmarkPrimitives";

interface Candidate {
  configuration: Configuration;
  available: boolean;
}

function candidatesFor(
  version: BenchmarkVersion | undefined,
  runs: RunSummary[],
): Candidate[] {
  if (!version) return [];
  const unique = new Map<string, Configuration>();
  for (const run of runs) {
    if (!run.request.versionIds.includes(version.id)) continue;
    for (const configuration of run.request.configurations) {
      unique.set(configuration.id, configuration);
    }
  }
  return [...unique.values()].map((configuration) => ({
    configuration,
    available: false,
  }));
}

/** Form over the read-only selector-evidence contract. Availability is the
 * caller's claim, so every candidate starts unavailable. */
export function BenchmarkRoutingDialog({
  versions,
  runs,
  onClose,
  onEvidence,
}: {
  versions: BenchmarkVersion[];
  runs: RunSummary[];
  onClose: () => void;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "none");
  const [mode, setMode] = useState<"exact" | "class">("exact");
  const [purpose, setPurpose] = useState<"analysis" | "selector">("analysis");
  const [objective, setObjective] = useState<"quality" | "latency" | "cost">(
    "quality",
  );
  const [minQuality, setMinQuality] = useState(0);
  const [maxAgeDays, setMaxAgeDays] = useState(30);
  const version = versions.find((entry) => entry.id === versionId);
  const [candidates, setCandidates] = useState<Candidate[]>(() =>
    candidatesFor(versions[0], runs),
  );
  const [result, setResult] = useState<RoutingEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo<RoutingEvidenceQuery | null>(() => {
    if (!version) return null;
    return {
      schemaVersion: 1,
      mode,
      purpose,
      targetVersionId: version.id,
      targetFamily: version.manifest.taskFamily,
      workClassId: version.manifest.workClassId,
      facets: version.manifest.facets,
      roleContextHash: version.manifest.roleContextHash,
      entryStateHash: version.manifest.entryState?.contentHash ?? null,
      candidates: candidates.map((candidate) => ({
        configuration: candidate.configuration,
        available: candidate.available,
        reason: candidate.available ? null : t("routing.availabilityUnknown"),
      })),
      cutoffAt: Date.now(),
      permittedSplits: ["development", "train"],
      objective: { kind: objective, minQuality },
      constraints: {
        providerIds: [],
        hardCandidateKey: null,
        maxDurationMs: null,
        maxCost: null,
      },
      maxAgeMs: Math.max(1, maxAgeDays) * 86_400_000,
      timeoutSeconds: null,
    };
  }, [
    version,
    mode,
    purpose,
    candidates,
    objective,
    minQuality,
    maxAgeDays,
    t,
  ]);
  const read = async () => {
    if (!query) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await benchmarkApi.getRoutingEvidence(query));
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
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("routing.title")}</DialogTitle>
          <DialogDescription>{t("routing.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t("routing.target")} className="md:col-span-2">
              {(id) => (
                <SelectField
                  id={id}
                  value={versionId}
                  onChange={(value) => {
                    setVersionId(value);
                    setCandidates(
                      candidatesFor(
                        versions.find((entry) => entry.id === value),
                        runs,
                      ),
                    );
                    setResult(null);
                  }}
                  options={
                    versions.length
                      ? versions.map((entry) => ({
                          value: entry.id,
                          label: t("editor.versionLabel", {
                            name: entry.manifest.name,
                            hash: shortId(entry.contentHash),
                          }),
                        }))
                      : [{ value: "none", label: t("run.noPublished") }]
                  }
                />
              )}
            </Field>
            <Field label={t("routing.mode")}>
              {(id) => (
                <SelectField
                  id={id}
                  value={mode}
                  onChange={(value) => setMode(value as "exact" | "class")}
                  options={(["exact", "class"] as const).map((value) => ({
                    value,
                    label: t(`routing.modes.${value}`),
                  }))}
                />
              )}
            </Field>
            <Field label={t("routing.purpose")}>
              {(id) => (
                <SelectField
                  id={id}
                  value={purpose}
                  onChange={(value) =>
                    setPurpose(value as "analysis" | "selector")
                  }
                  options={(["analysis", "selector"] as const).map((value) => ({
                    value,
                    label: t(`routing.purposes.${value}`),
                  }))}
                />
              )}
            </Field>
            <Field label={t("routing.objective")}>
              {(id) => (
                <SelectField
                  id={id}
                  value={objective}
                  onChange={(value) =>
                    setObjective(value as "quality" | "latency" | "cost")
                  }
                  options={(["quality", "latency", "cost"] as const).map(
                    (value) => ({
                      value,
                      label: t(`routing.objectives.${value}`),
                    }),
                  )}
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t("routing.minQuality")}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={minQuality}
                    onChange={(event) =>
                      setMinQuality(Number(event.target.value))
                    }
                  />
                )}
              </Field>
              <Field label={t("routing.maxAgeDays")}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    value={maxAgeDays}
                    onChange={(event) =>
                      setMaxAgeDays(Number(event.target.value))
                    }
                  />
                )}
              </Field>
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm">{t("routing.candidates")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("routing.candidatesHint")}
            </p>
            {candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("routing.noCandidates")}
              </p>
            ) : (
              candidates.map((candidate, index) => (
                <Label
                  key={candidate.configuration.id}
                  className="flex items-center gap-2 py-1 text-sm"
                >
                  <Checkbox
                    checked={candidate.available}
                    aria-label={t("routing.available")}
                    onCheckedChange={(checked) =>
                      setCandidates((previous) =>
                        previous.map((entry, position) =>
                          position === index
                            ? { ...entry, available: checked === true }
                            : entry,
                        ),
                      )
                    }
                  />
                  <span className="min-w-0 truncate">
                    {configurationLabel(candidate.configuration)}
                  </span>
                </Label>
              ))
            )}
          </fieldset>
          {result ? (
            <section className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t("routing.queryHash")}:{" "}
                <code className="break-all">{result.queryHash}</code>
              </p>
              {result.candidates.length === 0 ? (
                <BenchmarkEmpty title={t("routing.empty")} compact />
              ) : (
                <ul className="divide-y divide-border">
                  {result.candidates.map((row) => (
                    <li key={row.candidateKey} className="space-y-1 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">
                          {configurationLabel(row.configuration)}
                        </span>
                        <StateBadge state={row.status} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {row.reason}
                      </p>
                      <p className="text-xs">
                        {t("routing.coverage", {
                          samples: row.sampleCount,
                          families: row.familyCount,
                          quality: formatQuality(t, row.quality),
                        })}
                        {" · "}
                        {t("routing.protocol", {
                          missing: row.missingCount,
                          seconds: row.protocolTimeoutSeconds ?? t("unknown"),
                        })}
                      </p>
                      <BenchmarkEvidenceLinks
                        attemptIds={row.attemptIds}
                        onEvidence={onEvidence}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            flush
            className="sm:mr-auto"
            onClick={onClose}
          >
            {t("actions.close")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !query}
            onClick={() => void read()}
          >
            {t("routing.read")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
