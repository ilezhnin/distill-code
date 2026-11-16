import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  IconChevronDown,
  IconClock,
  IconCoin,
  IconHourglass,
} from "@tabler/icons-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { acpGetSessionInfo } from "@/shared/api/acp";
import { mergeAcpSessionInfo } from "@/features/chat/lib/acpSessionMapping";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { toggleVariants } from "@/shared/ui/toggle";
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
import { useBenchmarkSessionActivity } from "../hooks/useBenchmarkSessionActivity";
import { benchmarkKeys, useBenchmarkVersion } from "../hooks/useBenchmarks";
import {
  attemptTrail,
  countedRepetitions,
  earlierTries,
  supersededOutcome,
} from "../lib/benchmarkAttemptTrail";
import { configurationLabel } from "../lib/benchmarkDraft";
import {
  authoredByCandidate,
  hasEvaluatedOutcome,
  hasPanelVerdict,
} from "../lib/benchmarkEligibility";
import {
  criticalCheckEvidence,
  evaluationCriteria,
  previewDocument,
  rubricCriteriaOf,
  weightedShare,
} from "../lib/benchmarkPreview";
import {
  formatElapsed,
  formatSpend,
  modelDisplayName,
  providerVendor,
  shortId,
  stateLabel,
} from "../lib/benchmarkLabels";
import {
  activityElapsed,
  compactElapsed,
  taskActivity,
} from "../lib/benchmarkTaskTiming";
import type { Attempt } from "../types";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  Field,
  Metric,
  ModelIdentity,
  SectionHeading,
  StateBadge,
} from "./BenchmarkPrimitives";
import { BenchmarkDiagnosticHistory } from "./BenchmarkDiagnosticHistory";
import {
  type DotState,
  FAILING_OUTCOMES,
  RepetitionDots,
  useNow,
  WORKING,
} from "./BenchmarkTestStatus";
import { BenchmarkTrail } from "./BenchmarkTrail";
import { BenchmarkTranscriptDialog } from "./BenchmarkTranscriptDialog";

/** Run states in which nothing of an open attempt moves. */
const HELD_RUN = new Set(["paused", "needs_attention"]);

/** One repetition as its tab's dot, by what the attempt itself records. */
function repetitionDot(attempt: Attempt): DotState {
  if (WORKING.has(attempt.phase) || attempt.phase === "awaiting_judges")
    return "running";
  if (attempt.phase !== "terminal") return "queued";
  if (attempt.outcome === "pass") return "passed";
  return attempt.outcome != null && FAILING_OUTCOMES.has(attempt.outcome)
    ? "failed"
    : "stopped";
}

export function BenchmarkEvidenceView({
  attemptId: openedId,
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
  // A repetition tab changes only what this dialog shows: the page behind it
  // keeps its location, so nothing there redraws.
  const [shownId, setShownId] = useState(openedId);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const attemptId = shownId;
  const client = useQueryClient();
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
  // The case's other repetitions in the same run and configuration, so one
  // measurement reads as one dialog with a tab per repetition.
  const run = useQuery({
    queryKey: [...benchmarkKeys, "run", attempt?.runId],
    queryFn: () => benchmarkApi.getRun(attempt?.runId as string),
    enabled: attempt != null,
    staleTime: 30_000,
  });
  // Tries the run set aside and measured again count nowhere: they are no
  // repetitions, and open from their own list below the trail.
  const repetitions = attempt
    ? countedRepetitions(run.data?.attempts ?? [], attempt)
    : [];
  const tries = attempt ? earlierTries(run.data?.attempts ?? [], attempt) : [];
  // The rubric and checks belong to the attempt's own version alone.
  const version = useBenchmarkVersion(attempt?.versionId);
  const manifest = version.data?.manifest;
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
  const panelKind = manifest?.evaluator.kind === "rubric";
  const reviewed = attempt?.evaluations.some(
    (evaluation) =>
      evaluation.provenance === (visual ? "human_visual" : "human") &&
      evaluation.score !== null &&
      evaluation.evaluatorRevision === manifest?.evaluator.revision,
  );
  // A panel verdict opens the identity the way a human review does; a vote of
  // a panel that never reached its size is no verdict yet.
  const judged = attempt ? hasPanelVerdict(attempt.evaluations) : false;
  // A panel task stays anonymous only while its verdict is still to come;
  // an objective fail or a budget failure is already final.
  const verdictPending =
    attempt?.phase !== "terminal" ||
    attempt.outcome === "pending_review" ||
    attempt.outcome === "completed" ||
    attempt.outcome === "evaluation_error";
  // Identity stays hidden while the frozen rubric is still loading, too.
  const anonymousReview =
    !manifest ||
    (Boolean(rubric.trim()) &&
      !reviewed &&
      !judged &&
      (!panelKind || verdictPending));
  const disclosedReview = anonymousReview && revealed.has(attemptId);
  const blind = anonymousReview && !disclosedReview;
  const { formatDate, formatNumber } = useLocaleFormatting();
  // An open attempt's clocks tick; a settled one reads what it recorded.
  const open =
    attempt != null &&
    attempt.phase !== "terminal" &&
    attempt.phase !== "interrupted";
  const now = useNow(open);
  // While the model works its chat is the only sign of life: whether new
  // events still arrive, read without opening the transcript.
  const watching =
    open && !blind && attempt.phase === "running" && attempt.sessionId != null;
  const pulse = useBenchmarkSessionActivity(attempt?.sessionId ?? "", watching);
  const steps =
    attempt && !blind
      ? attemptTrail(t, attempt, {
          judged: panelKind,
          runState: run.data?.state,
          timeoutSeconds: run.data?.request.timeoutSeconds,
          now,
          formatTime: (at) => formatDate(at, { timeStyle: "short" }),
        })
      : [];
  if (watching && pulse.data) {
    const observation = pulse.data;
    steps
      .find((step) => step.id === "work")
      ?.substeps.push({
        id: "activity",
        title: t(
          observation.activitySeenAt == null
            ? "activity.observing"
            : "activity.lastSeen",
          {
            elapsed: compactElapsed(
              now - (observation.activitySeenAt ?? observation.unchangedSince),
            ),
          },
        ),
        // Five quiet minutes is worth a look; it is no proof of a hang.
        state:
          now - observation.unchangedSince >= 300_000 ? "waiting" : "running",
      });
  }
  // What the attempt spent working and what it spent in queues, as its card
  // counts them.
  const spent =
    attempt && !blind ? activityElapsed(taskActivity([attempt]), now) : null;
  const repetitionNumber = (other: Attempt) =>
    other.outcome === "superseded"
      ? t("trail.earlierTry")
      : t("evidence.repeat", { number: other.repetition + 1 });
  // An override replaces a verdict; a visual note only annotates one.
  const canReview =
    !disclosedReview &&
    Boolean(rubric.trim()) &&
    attempt?.phase === "terminal" &&
    attempt.output !== null &&
    (visual || hasEvaluatedOutcome(attempt.outcome));
  // The panel can score a rendering that no judge scored yet; asking it
  // reveals no identity. A human override outranks any later panel, so
  // asking again would spend calls that cannot change the score.
  const overridden = attempt?.evaluations.some(
    (evaluation) => evaluation.provenance === "human",
  );
  // Budget failures, cancelled, refused and excluded attempts keep their
  // outcome. A case the candidate wrote is evaluated like any other; the
  // boards decide what its score counts for.
  const canRescore =
    attempt?.phase === "terminal" &&
    attempt.output !== null &&
    hasEvaluatedOutcome(attempt.outcome) &&
    (panelKind ? Boolean(rubric.trim()) && !overridden : !blind);
  const ownTask =
    attempt != null &&
    authoredByCandidate(manifest?.environment, attempt.configuration);
  // Only a renderable answer to a brief with criteria reaches the panel; any
  // other answer is checked again without a model call.
  const panelRescore =
    panelKind &&
    ((preview != null && criteria.length > 0) ||
      attempt?.outcome === "pending_review" ||
      attempt?.outcome === "judged");
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
  const [sealedTranscript, setSealedTranscript] = useState(false);
  const openTranscript = async () => {
    if (blind || !attempt?.sessionId) return;
    // A finished attempt keeps no chat; its turn replays from the sealed
    // evidence. A running one opens its live chat.
    if (attempt.phase === "terminal") {
      setSealedTranscript(true);
      return;
    }
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
  // What was actually said about the answer: a panel's marker, a judge
  // still being asked and the placeholder of a review to come say nothing.
  const verdicts = (attempt?.evaluations ?? []).filter(
    (evaluation) =>
      evaluation.provenance !== "render" &&
      evaluation.details?.inFlight !== true &&
      !(
        evaluation.provenance === "objective" &&
        evaluation.verdict === "pending_review"
      ),
  );
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
          <DialogTitle className="leading-snug">
            {blind || !attempt
              ? t("evidence.anonymousReview", { id: shortId(attemptId) })
              : (manifest?.name ?? configurationLabel(attempt.configuration))}
          </DialogTitle>
          <DialogDescription>
            {disclosedReview
              ? t("diagnostics.disclosedReview")
              : blind || !attempt
                ? t("evidence.blindReview")
                : [
                    repetitionNumber(attempt),
                    attempt.startedAt == null
                      ? null
                      : formatDate(attempt.startedAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {attempt && !blind ? (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <ModelIdentity
                configuration={attempt.configuration}
                name={modelDisplayName(attempt.configuration)}
                vendor={providerVendor(attempt.configuration.providerId)}
              />
              <StateBadge
                state={
                  !open
                    ? (attempt.outcome ?? attempt.phase)
                    : run.data && HELD_RUN.has(run.data.state)
                      ? run.data.state
                      : attempt.phase
                }
              />
            </div>
          ) : null}
          {repetitions.length > 1 && !blind ? (
            <div
              role="tablist"
              aria-label={t("evidence.repetitions")}
              className="flex flex-wrap items-center gap-0.5"
            >
              {repetitions.map((other) => (
                <button
                  key={other.id}
                  type="button"
                  role="tab"
                  aria-selected={other.id === attemptId}
                  data-state={other.id === attemptId ? "on" : "off"}
                  className={cn(
                    toggleVariants({ size: "sm" }),
                    "h-7 gap-1.5 px-2.5 text-xs",
                  )}
                  onClick={() => setShownId(other.id)}
                >
                  <RepetitionDots
                    states={[repetitionDot(other)]}
                    animate={!run.data || !HELD_RUN.has(run.data.state)}
                  />
                  {repetitionNumber(other)}
                </button>
              ))}
            </div>
          ) : null}
          {error || evidence.error || version.error ? (
            <BenchmarkAlert>
              {error ?? benchmarkErrorMessage(evidence.error ?? version.error)}
            </BenchmarkAlert>
          ) : null}
          {evidence.isPending ? (
            <BenchmarkEmpty title={t("loading")} compact />
          ) : null}
          {ownTask && !blind ? (
            <p className="text-sm text-muted-foreground">
              {t("evidence.ownTask")}
            </p>
          ) : null}
          {attempt && !blind ? (
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              {open ? (
                <>
                  {spent?.execution != null ? (
                    <Metric
                      label={t("trail.active")}
                      icon={<IconClock aria-hidden className="size-3.5" />}
                      value={compactElapsed(spent.execution)}
                    />
                  ) : null}
                  {spent?.waiting != null ? (
                    <Metric
                      label={t("grid.waited")}
                      icon={<IconHourglass aria-hidden className="size-3.5" />}
                      value={compactElapsed(spent.waiting)}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  {attempt.durationMs != null ? (
                    <Metric
                      label={t("fields.elapsed")}
                      icon={<IconClock aria-hidden className="size-3.5" />}
                      value={formatElapsed(t, attempt.durationMs)}
                    />
                  ) : null}
                  {attempt.usage.input != null ||
                  attempt.usage.output != null ? (
                    <Metric
                      label={t("fields.tokens")}
                      value={
                        <>
                          {t("fields.tokensValue", {
                            input:
                              attempt.usage.input == null
                                ? t("unknown")
                                : formatNumber(attempt.usage.input),
                            output:
                              attempt.usage.output == null
                                ? t("unknown")
                                : formatNumber(attempt.usage.output),
                          })}
                          {attempt.usage.cacheWrite ||
                          attempt.usage.cacheRead ? (
                            <div className="font-sans text-xs text-muted-foreground">
                              {t("fields.tokensCache", {
                                write: attempt.usage.cacheWrite ?? 0,
                                read: attempt.usage.cacheRead ?? 0,
                              })}
                            </div>
                          ) : null}
                        </>
                      }
                    />
                  ) : null}
                  {attempt.usage.cost != null ||
                  attempt.usage.output != null ? (
                    <Metric
                      label={t("fields.cost")}
                      icon={<IconCoin aria-hidden className="size-3.5" />}
                      value={formatSpend(
                        t,
                        attempt.usage.cost,
                        attempt.usage.output,
                      )}
                    />
                  ) : null}
                </>
              )}
            </dl>
          ) : null}
          {steps.length > 0 ? <BenchmarkTrail steps={steps} now={now} /> : null}
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
          {attempt?.output != null ? (
            <section className="space-y-2">
              <SectionHeading title={t("evidence.output")} />
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-4 text-xs">
                {attempt.output}
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
          {!blind && verdicts.length > 0 ? (
            <section className="space-y-2">
              <SectionHeading title={t("evidence.evaluations")} />
              {
                <ul className="divide-y divide-border">
                  {verdicts.map((evaluation) => (
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
                      {evaluation.details &&
                      ["judge", "human", "human_visual"].includes(
                        evaluation.provenance,
                      ) ? (
                        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          {evaluationCriteria(evaluation.details).map(
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
                      {criticalCheckEvidence(evaluation.details).length > 0 ? (
                        <div className="space-y-2 text-xs">
                          <p className="font-medium">
                            {t("evidence.criticalChecks")}
                          </p>
                          {criticalCheckEvidence(evaluation.details).map(
                            (check) => (
                              <div
                                key={check.id}
                                className="space-y-1 rounded-md border border-border p-2"
                              >
                                <div className="flex items-center gap-2">
                                  <span>{check.id}</span>
                                  <StateBadge
                                    state={
                                      check.verdict === "unknown"
                                        ? "pending_review"
                                        : check.verdict
                                    }
                                  />
                                </div>
                                <p>{check.reason}</p>
                                {[...new Set(check.evidence)].map((quote) => (
                                  <blockquote
                                    key={quote}
                                    className="border-l-2 border-border pl-2 whitespace-pre-wrap break-words text-muted-foreground"
                                  >
                                    {quote}
                                  </blockquote>
                                ))}
                              </div>
                            ),
                          )}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              }
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
          {attempt ? (
            <div className="space-y-2 border-t border-border pt-4">
              {tries.length > 0 && !blind ? (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      flush
                      rightIcon={<IconChevronDown />}
                    >
                      {t("trail.earlier", { count: tries.length })}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="mt-2 divide-y divide-border">
                      {tries.map((other) => (
                        <li
                          key={other.id}
                          className="flex items-center justify-between gap-3 py-1.5 text-xs"
                        >
                          <span className="min-w-0 truncate">
                            <span className="tabular-nums">
                              {other.startedAt == null
                                ? shortId(other.id)
                                : formatDate(other.startedAt, {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  })}
                            </span>
                            <span className="text-muted-foreground">
                              {" · "}
                              {stateLabel(t, supersededOutcome(other))}
                              {other.startedAt != null &&
                              other.finishedAt != null
                                ? ` · ${compactElapsed(other.finishedAt - other.startedAt)}`
                                : ""}
                            </span>
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => setShownId(other.id)}
                          >
                            {t("actions.inspect")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
              {attempt ? (
                <BenchmarkDiagnosticHistory
                  key={attemptId}
                  attemptId={attemptId}
                  blind={blind}
                  onReveal={() =>
                    setRevealed((previous) => new Set([...previous, attemptId]))
                  }
                />
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
                          outcome: stateLabel(
                            t,
                            attempt.outcome ?? attempt.phase,
                          ),
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
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {canRescore ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void evaluate(false)}
            >
              {t(panelRescore ? "evidence.rescoreJudges" : "evidence.rescore")}
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
        {sealedTranscript && !blind ? (
          <BenchmarkTranscriptDialog
            attemptId={attemptId}
            onClose={() => setSealedTranscript(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
