import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
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
import type {
  RunSummary,
  BenchmarkVersion,
  RoutingEvidence,
  RoutingEvidenceQuery,
} from "../types";
import { configurationLabel } from "../lib/benchmarkDraft";
import { BenchmarkEvidenceLinks } from "./BenchmarkEvidenceLinks";
import {
  BenchmarkField,
  BenchmarkNotice,
  BenchmarkSelect,
} from "./BenchmarkFields";

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
  const makeQuery = (
    version: BenchmarkVersion | undefined,
  ): RoutingEvidenceQuery => ({
    schemaVersion: 1,
    mode: "exact",
    purpose: "analysis",
    targetVersionId: version?.id ?? null,
    targetFamily: version?.manifest.taskFamily ?? "",
    workClassId: version?.manifest.workClassId ?? "general-light",
    facets: version?.manifest.facets ?? {},
    roleContextHash: version?.manifest.roleContextHash ?? "clean-v1",
    entryStateHash: version?.manifest.entryState?.contentHash ?? null,
    candidates: [
      ...new Map(
        runs
          .filter((run) => run.request.versionIds.includes(version?.id ?? ""))
          .flatMap((run) => run.request.configurations)
          .map((configuration) => [configuration.id, configuration]),
      ).values(),
    ].map((configuration) => ({
      configuration,
      available: false,
      reason: t("routing.availabilityUnknown"),
    })),
    cutoffAt: Date.now(),
    permittedSplits: ["development", "train"],
    objective: { kind: "quality", minQuality: 0 },
    constraints: {
      providerIds: [],
      hardCandidateKey: null,
      maxDurationMs: null,
      maxCost: null,
    },
    maxAgeMs: 30 * 86_400_000,
    timeoutSeconds: null,
  });
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "none");
  const [source, setSource] = useState(() =>
    JSON.stringify(makeQuery(versions[0]), null, 2),
  );
  const [result, setResult] = useState<RoutingEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await benchmarkApi.getRoutingEvidence(JSON.parse(source)));
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
        <DialogBody className="space-y-4">
          <BenchmarkField label={t("fields.version")}>
            {(id) => (
              <BenchmarkSelect
                id={id}
                value={versionId}
                onChange={(value) => {
                  setVersionId(value);
                  setSource(
                    JSON.stringify(
                      makeQuery(
                        versions.find((version) => version.id === value),
                      ),
                      null,
                      2,
                    ),
                  );
                  setResult(null);
                }}
                options={
                  versions.length
                    ? versions.map((version) => ({
                        value: version.id,
                        label: `${version.manifest.name} / ${version.contentHash.slice(0, 8)}`,
                      }))
                    : [{ value: "none", label: t("run.noPublished") }]
                }
              />
            )}
          </BenchmarkField>
          <BenchmarkNotice>{t("routing.eligibilityHelp")}</BenchmarkNotice>
          <BenchmarkField label={t("routing.query")}>
            {(id) => (
              <Textarea
                id={id}
                rows={12}
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setResult(null);
                }}
              />
            )}
          </BenchmarkField>
          {error && <BenchmarkNotice error>{error}</BenchmarkNotice>}
          {result && (
            <div className="space-y-3">
              <code className="block break-all text-xs text-muted-foreground">
                {result.queryHash}
              </code>
              {result.candidates.length === 0 && (
                <BenchmarkNotice>{t("routing.empty")}</BenchmarkNotice>
              )}
              {result.candidates.map((row) => (
                <div
                  key={row.candidateKey}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <h3 className="font-medium">
                    {configurationLabel(row.configuration)}
                  </h3>
                  <p className="text-sm">
                    {t(`states.${row.status}`, { defaultValue: row.status })} ·{" "}
                    {row.reason}
                  </p>
                  <p className="text-sm">
                    {t("routing.coverage", {
                      samples: row.sampleCount,
                      families: row.familyCount,
                      quality:
                        row.quality == null
                          ? t("unknown")
                          : `${(row.quality * 100).toFixed(1)}%`,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("routing.protocol", {
                      missing: row.missingCount,
                      seconds: row.protocolTimeoutSeconds ?? t("unknown"),
                    })}
                  </p>
                  <BenchmarkEvidenceLinks
                    attemptIds={row.attemptIds}
                    onEvidence={onEvidence}
                  />
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void query()}
          >
            {t("routing.read")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
