import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { acpGetSessionInfo } from "@/shared/api/acp";
import { mergeAcpSessionInfo } from "@/features/chat/lib/acpSessionMapping";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
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
import { benchmarkKeys, useBenchmarkDefinitions } from "../hooks/useBenchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import { BenchmarkField, BenchmarkNotice } from "./BenchmarkFields";

export function BenchmarkEvidenceView({
  attemptId,
  onClose,
  onSelectSession,
  onSelectAttempt,
}: {
  attemptId: string;
  onClose: () => void;
  onSelectSession: (id: string) => void;
  onSelectAttempt: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const definitions = useBenchmarkDefinitions();
  const evidence = useQuery({
    queryKey: [...benchmarkKeys, "evidence", attemptId],
    queryFn: () => benchmarkApi.getEvidence(attemptId),
  });
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [reviewScore, setReviewScore] = useState(1);
  const [reviewReason, setReviewReason] = useState("");
  const attempt = evidence.data;
  const manifest = definitions.data
    ?.flatMap((definition) => definition.versions)
    .find((version) => version.id === attempt?.versionId)?.manifest;
  const visual =
    manifest?.evaluator.kind === "javascript" ||
    manifest?.evaluator.kind === "browser";
  const environment = manifest?.environment;
  const visualRubric =
    environment &&
    typeof environment === "object" &&
    "visualRubric" in environment &&
    typeof environment.visualRubric === "string"
      ? environment.visualRubric
      : null;
  const rubric = visual
    ? (visualRubric ?? manifest?.evaluator.rubric ?? "")
    : manifest?.evaluator.kind === "rubric"
      ? manifest.evaluator.rubric
      : "";
  const reviewed = attempt?.evaluations.some(
    (evaluation) =>
      evaluation.provenance === (visual ? "human_visual" : "human") &&
      evaluation.score !== null &&
      evaluation.evaluatorRevision === manifest?.evaluator.revision,
  );
  // Keep identity hidden while the frozen rubric is loading, too.
  const blind = !manifest || (Boolean(rubric.trim()) && !reviewed);
  const canReview =
    Boolean(rubric.trim()) &&
    attempt?.phase === "terminal" &&
    attempt.output !== null;
  const evaluate = async (review: boolean) => {
    if (review && !canReview) return;
    setOpening(true);
    setError(null);
    try {
      const result = review
        ? await benchmarkApi.submitReview(attemptId, reviewScore, reviewReason)
        : await benchmarkApi.rescore(attemptId);
      client.setQueryData([...benchmarkKeys, "evidence", attemptId], result);
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setOpening(false);
    }
  };
  const openTranscript = async () => {
    if (blind || !attempt?.sessionId) return;
    setOpening(true);
    setError(null);
    try {
      const session = await acpGetSessionInfo(attempt.sessionId);
      useChatSessionStore.setState((state) =>
        mergeAcpSessionInfo(state, session),
      );
      onSelectSession(attempt.sessionId);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setOpening(false);
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
          <DialogTitle>{t("evidence.title")}</DialogTitle>
          <DialogDescription>{t("evidence.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {evidence.isPending && (
            <BenchmarkNotice>{t("loading")}</BenchmarkNotice>
          )}
          {(error || evidence.error || definitions.error) && (
            <BenchmarkNotice error>
              {error ??
                benchmarkErrorMessage(evidence.error ?? definitions.error)}
            </BenchmarkNotice>
          )}
          {attempt && (
            <>
              <div className="space-y-1">
                <h3 className="font-medium">
                  {blind
                    ? t("evidence.anonymousReview", {
                        id: attempt.id.slice(0, 8),
                      })
                    : configurationLabel(attempt.configuration)}
                </h3>
                {blind && (
                  <p className="text-sm text-muted-foreground">
                    {t("evidence.blindReview")}
                  </p>
                )}
                {!blind && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t(`states.${attempt.outcome ?? attempt.phase}`, {
                        defaultValue: attempt.outcome ?? attempt.phase,
                      })}
                    </p>
                    {attempt.reason && (
                      <p className="text-sm">{attempt.reason}</p>
                    )}
                  </>
                )}
              </div>
              {!blind && (
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">
                      {t("fields.duration")}
                    </dt>
                    <dd>
                      {attempt.durationMs == null
                        ? t("unknown")
                        : t("seconds", {
                            value: (attempt.durationMs / 1000).toFixed(2),
                          })}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("fields.cost")}
                    </dt>
                    <dd>
                      {attempt.usage.cost == null
                        ? t("unknown")
                        : attempt.usage.cost.toFixed(6)}
                    </dd>
                  </div>
                </dl>
              )}
              {rubric.trim() && (
                <section className="space-y-2">
                  <h3 className="font-medium">{t("evidence.rubric")}</h3>
                  <p className="whitespace-pre-wrap text-sm">{rubric}</p>
                </section>
              )}
              <h3 className="font-medium">{t("evidence.output")}</h3>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-4 text-sm">
                {attempt.output ?? t("evidence.noOutput")}
              </pre>
              <h3 className="font-medium">{t("evidence.evaluations")}</h3>
              {!blind && (attempt.workflowSteps?.length ?? 0) > 0 && (
                <section className="space-y-2">
                  <h3 className="font-medium">{t("evidence.workflowSteps")}</h3>
                  {attempt.workflowSteps.map((step) => (
                    <div
                      key={step.attemptId}
                      className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                    >
                      <div className="min-w-0 text-sm">
                        <p>
                          {step.stepId} ·{" "}
                          {t(`states.${step.outcome ?? "pending"}`, {
                            defaultValue: step.outcome ?? "pending",
                          })}
                        </p>
                        <code className="block truncate text-xs text-muted-foreground">
                          {step.entryStateHash}
                        </code>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => onSelectAttempt(step.attemptId)}
                      >
                        {t("actions.inspect")}
                      </Button>
                    </div>
                  ))}
                </section>
              )}
              {attempt.evaluations.length === 0 && (
                <BenchmarkNotice>{t("evidence.notEvaluated")}</BenchmarkNotice>
              )}
              {attempt.evaluations.map((evaluation) => (
                <section
                  key={evaluation.id}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  {!blind && (
                    <>
                      <div className="text-sm">
                        {t(`states.${evaluation.verdict}`, {
                          defaultValue: evaluation.verdict,
                        })}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {evaluation.reason}
                      </p>
                      <code className="text-xs">
                        {evaluation.provenance} / {evaluation.evaluatorRevision}
                      </code>
                    </>
                  )}
                  <div className="grid gap-3 md:grid-cols-2">
                    {evaluation.artifacts
                      ?.filter(
                        (artifact) =>
                          artifact.kind === "image" ||
                          artifact.kind === "screenshot",
                      )
                      .map((artifact, index) => (
                        <figure key={artifact.hash}>
                          <img
                            src={convertFileSrc(artifact.path)}
                            alt={
                              blind
                                ? t("evidence.anonymousArtifact", {
                                    number: index + 1,
                                  })
                                : artifact.label
                            }
                            className="w-full rounded-md border border-border"
                          />
                          <figcaption className="text-xs text-muted-foreground">
                            {blind
                              ? t("evidence.anonymousArtifact", {
                                  number: index + 1,
                                })
                              : artifact.label}
                          </figcaption>
                        </figure>
                      ))}
                  </div>
                </section>
              ))}
              {canReview && (
                <section className="space-y-3">
                  <BenchmarkField label={t("fields.reviewScore")}>
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={0}
                        max={1}
                        step={0.1}
                        value={reviewScore}
                        onChange={(event) =>
                          setReviewScore(Number(event.target.value))
                        }
                      />
                    )}
                  </BenchmarkField>
                  <BenchmarkField label={t("fields.reviewReason")}>
                    {(id) => (
                      <Textarea
                        id={id}
                        value={reviewReason}
                        onChange={(event) =>
                          setReviewReason(event.target.value)
                        }
                      />
                    )}
                  </BenchmarkField>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      opening ||
                      !reviewReason.trim() ||
                      reviewScore < 0 ||
                      reviewScore > 1 ||
                      !Number.isFinite(reviewScore)
                    }
                    onClick={() => void evaluate(true)}
                  >
                    {t("evidence.review")}
                  </Button>
                </section>
              )}
              {!blind &&
                attempt.phase === "terminal" &&
                attempt.output !== null && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={opening}
                    onClick={() => void evaluate(false)}
                  >
                    {t("evidence.rescore")}
                  </Button>
                )}
              {!blind && (
                <details className="text-sm">
                  <summary>{t("evidence.metadata")}</summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(
                      {
                        requested: attempt.configuration,
                        observed: attempt.observed,
                        usage: attempt.usage,
                        evidenceHash: attempt.evidenceHash,
                        eventCursor: attempt.eventCursor,
                        sessionId: attempt.sessionId,
                        hostRunId: attempt.hostRunId,
                        evaluations: attempt.evaluations,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("actions.close")}
          </Button>
          {!blind && (
            <Button
              type="button"
              variant="primary"
              disabled={!attempt?.sessionId || opening}
              onClick={() => void openTranscript()}
            >
              {t("evidence.openTranscript")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
