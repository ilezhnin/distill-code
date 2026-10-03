import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IconChevronDown, IconClock, IconCoin } from "@tabler/icons-react";
import { acpGetSessionInfo } from "@/shared/api/acp";
import { mergeAcpSessionInfo } from "@/features/chat/lib/acpSessionMapping";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
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
import { Textarea } from "@/shared/ui/textarea";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys, useBenchmarkDefinitions } from "../hooks/useBenchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import {
  previewDocument,
  rubricCriteriaOf,
  weightedShare,
} from "../lib/benchmarkPreview";
import {
  formatElapsed,
  formatUsd,
  modelDisplayName,
  shortId,
  stateLabel,
} from "../lib/benchmarkLabels";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  SectionHeading,
  StateBadge,
} from "./BenchmarkPrimitives";

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
  const [busy, setBusy] = useState(false);
  const [reviewScore, setReviewScore] = useState(1);
  const [criterionScores, setCriterionScores] = useState<
    Record<string, number>
  >({});
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
  // Weighted criteria turn one judgement into comparable parts; the score
  // the leaderboard reads is their weighted mean.
  const criteria = rubricCriteriaOf(environment);
  const score =
    criteria.length > 0
      ? weightedShare(criteria, criterionScores)
      : reviewScore;
  const preview = previewDocument(
    attempt?.output,
    manifest?.facets.outputFormat,
  );
  const reviewed = attempt?.evaluations.some(
    (evaluation) =>
      evaluation.provenance === (visual ? "human_visual" : "human") &&
      evaluation.score !== null &&
      evaluation.evaluatorRevision === manifest?.evaluator.revision,
  );
  // A panel verdict opens the identity the way a human review does.
  const judged = attempt?.evaluations.some(
    (evaluation) => evaluation.provenance === "judge",
  );
  // Identity stays hidden while the frozen rubric is still loading, too.
  const blind = !manifest || (Boolean(rubric.trim()) && !reviewed && !judged);
  const canReview =
    Boolean(rubric.trim()) &&
    attempt?.phase === "terminal" &&
    attempt.output !== null;
  const evaluate = async (review: boolean) => {
    if (review && !canReview) return;
    setBusy(true);
    setError(null);
    try {
      const result = review
        ? await benchmarkApi.submitReview(
            attemptId,
            score,
            reviewReason,
            criteria.length > 0
              ? Object.fromEntries(
                  criteria.map((criterion) => [
                    criterion.id,
                    (criterionScores[criterion.id] ?? 0) / 10,
                  ]),
                )
              : null,
          )
        : await benchmarkApi.rescore(attemptId);
      client.setQueryData([...benchmarkKeys, "evidence", attemptId], result);
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const openTranscript = async () => {
    if (blind || !attempt?.sessionId) return;
    setBusy(true);
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
      setBusy(false);
    }
  };
  const artifacts =
    attempt?.evaluations.flatMap((evaluation) =>
      evaluation.artifacts.filter(
        (artifact) =>
          artifact.kind === "image" || artifact.kind === "screenshot",
      ),
    ) ?? [];
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
            {blind || !attempt
              ? t("evidence.anonymousReview", { id: shortId(attemptId) })
              : configurationLabel(attempt.configuration)}
          </DialogTitle>
          <DialogDescription>
            {blind ? t("evidence.blindReview") : t("evidence.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {error || evidence.error || definitions.error ? (
            <BenchmarkAlert>
              {error ??
                benchmarkErrorMessage(evidence.error ?? definitions.error)}
            </BenchmarkAlert>
          ) : null}
          {evidence.isPending ? (
            <BenchmarkEmpty title={t("loading")} compact />
          ) : null}
          {attempt && !blind ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("fields.status")}
                </dt>
                <dd className="mt-1">
                  <StateBadge state={attempt.outcome ?? attempt.phase} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("fields.elapsed")}
                </dt>
                <dd className="mt-1 flex items-center gap-1.5 tabular-nums">
                  <IconClock
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  {formatElapsed(t, attempt.durationMs)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("fields.tokens")}
                </dt>
                <dd className="mt-1">
                  {attempt.usage.input == null && attempt.usage.output == null
                    ? t("unknown")
                    : t("fields.tokensValue", {
                        input: attempt.usage.input ?? t("unknown"),
                        output: attempt.usage.output ?? t("unknown"),
                      })}
                  {attempt.usage.cacheWrite || attempt.usage.cacheRead ? (
                    <div className="text-xs text-muted-foreground">
                      {t("fields.tokensCache", {
                        write: attempt.usage.cacheWrite ?? 0,
                        read: attempt.usage.cacheRead ?? 0,
                      })}
                    </div>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("fields.cost")}
                </dt>
                <dd className="mt-1 flex items-center gap-1.5 tabular-nums">
                  <IconCoin
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  {formatUsd(t, attempt.usage.cost)}
                </dd>
              </div>
              {attempt.reason ? (
                <p className="col-span-full text-xs text-muted-foreground">
                  {attempt.reason}
                </p>
              ) : null}
            </dl>
          ) : null}
          {attempt && rubric.trim() ? (
            <section className="space-y-2">
              <SectionHeading title={t("evidence.rubric")} />
              <p className="whitespace-pre-wrap text-sm">{rubric}</p>
            </section>
          ) : null}
          {preview ? (
            <section className="space-y-2">
              <SectionHeading title={t("evidence.preview")} />
              <iframe
                sandbox=""
                srcDoc={preview}
                title={t("evidence.preview")}
                className="h-96 w-full rounded-md border border-border bg-white"
              />
            </section>
          ) : null}
          {attempt ? (
            <section className="space-y-2">
              <SectionHeading title={t("evidence.output")} />
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-xs">
                {attempt.output ?? t("evidence.noOutput")}
              </pre>
            </section>
          ) : null}
          {artifacts.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {artifacts.map((artifact, index) => {
                const label = blind
                  ? t("evidence.anonymousArtifact", { number: index + 1 })
                  : artifact.label;
                return (
                  <figure key={artifact.hash} className="space-y-1">
                    <img
                      src={convertFileSrc(artifact.path)}
                      alt={label}
                      className="w-full rounded-md border border-border"
                    />
                    <figcaption className="text-xs text-muted-foreground">
                      {label}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          ) : null}
          {attempt && !blind && attempt.workflowSteps.length > 0 ? (
            <section className="space-y-2">
              <SectionHeading title={t("evidence.workflowSteps")} />
              <ul className="divide-y divide-border">
                {attempt.workflowSteps.map((step) => (
                  <li
                    key={step.attemptId}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0 text-sm">
                      <div className="flex items-center gap-2">
                        <span>{step.stepId}</span>
                        <StateBadge state={step.outcome ?? "pending"} />
                      </div>
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
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {attempt && !blind ? (
            <section className="space-y-2">
              <SectionHeading title={t("evidence.evaluations")} />
              {attempt.evaluations.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("evidence.notEvaluated")}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {attempt.evaluations.map((evaluation) => (
                    <li key={evaluation.id} className="space-y-1 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <StateBadge state={evaluation.verdict} />
                        <span className="text-xs text-muted-foreground">
                          {evaluation.judge
                            ? t("evidence.judge", {
                                model: modelDisplayName(
                                  evaluation.judge,
                                  evaluation.judge.modelName,
                                ),
                              })
                            : evaluation.provenance}{" "}
                          · {evaluation.evaluatorRevision}
                          {evaluation.score != null
                            ? ` · ${evaluation.score.toFixed(2)}`
                            : ""}
                        </span>
                      </div>
                      {evaluation.details ? (
                        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          {Object.entries(evaluation.details).map(
                            ([id, value]) => (
                              <div key={id}>
                                <dt className="inline">
                                  {criteria.find((c) => c.id === id)?.label ??
                                    id}
                                </dt>
                                <dd className="inline tabular-nums">
                                  {" "}
                                  {Math.round(value * 10)}
                                </dd>
                              </div>
                            ),
                          )}
                        </dl>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {evaluation.reason}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {canReview ? (
            <section className="space-y-3">
              <SectionHeading
                title={t(judged ? "evidence.override" : "evidence.review")}
              />
              {criteria.length > 0 ? (
                <div className="space-y-3">
                  {criteria.map((criterion) => (
                    <Field
                      key={criterion.id}
                      label={t("evidence.criterion", {
                        label: criterion.label,
                        weight: criterion.weight,
                      })}
                    >
                      {(id) => (
                        <div className="flex items-center gap-3">
                          <input
                            id={id}
                            type="range"
                            min={0}
                            max={10}
                            step={1}
                            value={criterionScores[criterion.id] ?? 0}
                            onChange={(event) =>
                              setCriterionScores((scores) => ({
                                ...scores,
                                [criterion.id]: Number(event.target.value),
                              }))
                            }
                            className="flex-1 accent-chart-1"
                          />
                          <span className="w-6 text-right text-sm tabular-nums">
                            {criterionScores[criterion.id] ?? 0}
                          </span>
                        </div>
                      )}
                    </Field>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    {t("evidence.weighted", {
                      points: Math.round(score * 1000),
                    })}
                  </p>
                </div>
              ) : null}
              <div
                className={
                  criteria.length > 0
                    ? "grid gap-4"
                    : "grid gap-4 md:grid-cols-[8rem_1fr]"
                }
              >
                {criteria.length === 0 ? (
                  <Field label={t("fields.reviewScore")}>
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
                  </Field>
                ) : null}
                <Field label={t("fields.reviewReason")}>
                  {(id) => (
                    <Textarea
                      id={id}
                      value={reviewReason}
                      onChange={(event) => setReviewReason(event.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  !reviewReason.trim() ||
                  score < 0 ||
                  score > 1 ||
                  !Number.isFinite(score)
                }
                onClick={() => void evaluate(true)}
              >
                {t("evidence.review")}
              </Button>
            </section>
          ) : null}
          {attempt && !blind ? (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  flush
                  rightIcon={<IconChevronDown />}
                >
                  {t("evidence.metadata")}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-xs">
                  {JSON.stringify(
                    {
                      outcome: stateLabel(t, attempt.outcome ?? attempt.phase),
                      requested: attempt.configuration,
                      observed: attempt.observed,
                      usage: attempt.usage,
                      evidenceHash: attempt.evidenceHash,
                      eventCursor: attempt.eventCursor,
                      sessionId: attempt.sessionId,
                      hostRunId: attempt.hostRunId,
                    },
                    null,
                    2,
                  )}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {attempt &&
          !blind &&
          attempt.phase === "terminal" &&
          attempt.output !== null ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void evaluate(false)}
            >
              {t("evidence.rescore")}
            </Button>
          ) : null}
          {!blind ? (
            <Button
              type="button"
              variant="primary"
              disabled={!attempt?.sessionId || busy}
              onClick={() => void openTranscript()}
            >
              {t("actions.openTranscript")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
