/**
 * The effectful shell of the closed loop (D4).
 *
 * `waveVerdict.ts` decides; this file reads stores, sends the digest through
 * the envelope, spawns the revision wave and posts the operator notices. It is
 * driven from `waveRunner.ts`'s tick, which is driven from the app-wide
 * conductor sync — so a wave closes with the conductor chat shut.
 *
 * ## Re-entrancy
 *
 * The sync subscription fires on every chat-store change, i.e. on every
 * streamed token, so every transition here has to be idempotent. It follows the
 * discipline `waveRunner.ts` already established, one level up:
 *
 * - a **persisted marker** — the wave's `phase` — moves before any async work
 *   starts, so a crash mid-flight resumes rather than repeats;
 * - an **in-memory in-flight set** covers the window the phase cannot, because
 *   an async dispatch that has not returned yet looks exactly like one that was
 *   never started;
 * - and the **digest's own marker in the parent transcript** is the tiebreaker
 *   the other two cannot be: after a restart, `dispatchingDigest` is ambiguous,
 *   and the only honest way to tell a delivered digest from a lost one is to
 *   look for it in the transcript.
 *
 * That last one has a precondition the code has to respect: the transcript has
 * to have been *read*. `chat.messagesBySession` is an evictable cache that is
 * empty for any session the operator has not opened this run, and this file
 * runs precisely when the conductor chat is shut. So every transcript read
 * here goes through `waveTranscripts.ts`, which answers "loaded" or "unknown"
 * and hydrates in the background; on "unknown" the wave waits. Re-delivering a
 * digest that already landed costs two model turns and discards the answer to
 * the first copy, and waiting costs nothing.
 *
 * ## Why the verdict scan runs before plan admission
 *
 * A `revise` verdict is an assistant message carrying a `distill-wave` fence.
 * Left alone, the plan detector would admit it as a brand-new root wave — the
 * revision would run twice, once inside the loop and once outside it, and the
 * cap would not apply to the second. So this pass runs first in every tick and
 * writes a tombstone for the message it judged *before* returning; by the time
 * `admitCandidates` looks, that message id is already spent.
 */

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { isLegacyReplayReplyId } from "@/shared/api/acpReplayMetadata";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { skipConductorNoticeRelay } from "./conductorNoticeRelay";
import { deliverEnvelope } from "./digestDelivery";
import { parseFlockVerdict } from "./flockVerdict";
import type { ConductorRoadmap } from "./flockRoadmap";
import { parseFlockWave } from "./flockWave";
import type { SessionNode } from "./types";
import {
  admitWavePlan,
  collectWaveStepReports,
  createWaveState,
  hasAttestedWaveStepReport,
  waveStepNode,
  withVerdictIssue,
  withWavePhase,
  type WavePhase,
  type WaveState,
} from "./waveEngine";
import { ownedWaveLineage } from "./waveExecutor";
import {
  buildWaveDigest,
  findDigestMessageIndex,
  findVerdictMessageAfter,
  shortWaveId,
  waveDigestMarker,
  waveGitDeltaOf,
  type DigestEntry,
} from "./waveDigest";
import { buildGoalContinueInstruction } from "./wavePrompts";
import { goalLoopNoticeText } from "./waveNotices";
import {
  ownedWaveFinalBinding,
  resetWaveArtifactProbeForTests,
  startWaveArtifactProbe,
  waveArtifactFactsOf,
} from "./waveArtifactProbe";
import { resetWaveGitProbeForTests, startWaveGitProbe } from "./waveGitProbe";
import {
  bumpWaveTelemetryCounter,
  recordWaveClose,
  resetWaveTelemetryForTests,
} from "./waveTelemetryStore";
import {
  digestDeliveryFailureText,
  waveAcceptReaskedNoticeText,
  waveClosureNoticeText,
} from "./waveNotices";
import {
  MAX_WAVE_REVISIONS,
  decideWaveVerdict,
  digestLostDecision,
  digestUndeliverableDecision,
  isWaveLive,
  isWaveRetired,
  verdictUnansweredDecision,
  waveInterruptedDecision,
  type WaveVerdictDecision,
} from "./waveVerdict";
import {
  checkExplicitWaveStepModel,
  checkWaveStepRunSettings,
} from "./waveStepTarget";
import {
  recordTaskMemoryVerdict,
  recordWaveInTaskMemory,
  resetTaskMemoryIoForTests,
  taskMemoryGoal,
  taskMemoryStepOf,
  type TaskMemoryVerdict,
} from "./taskMemory";
import { readConductorTranscript } from "./waveTranscripts";
import {
  hasWaveTombstone,
  setWaveEngineState,
  updateWaveEngineState,
  withProcessedMessageWatermark,
  withRoadmap,
  withWave,
  withWaveTombstone,
  withoutWave,
  type WaveEngineState,
} from "./waveStore";
import { getTextContent, type Message } from "@/shared/types/messages";

/** `waveId#attempt` of digests whose delivery is in flight in this process. */
const inFlightDigests = new Set<string>();

/** Digest deliveries the shell wants to start once the tick has committed. */
export interface PendingDigestDispatch {
  waveId: string;
  attempt: number;
  conductorSessionId: string;
  text: string;
}

function digestKey(waveId: string, attempt: number): string {
  return `${waveId}#${attempt}`;
}

function appendNotice(
  sessionId: string,
  text: string,
  type: "error" | "warning",
  action?: Parameters<typeof createSystemNotificationMessage>[2],
): string {
  const message = createSystemNotificationMessage(text, type, action);
  useChatStore.getState().addMessage(sessionId, message);
  return message.id;
}

/** Parked waves whose closure notice this renderer process has shown. */
const announcedClosures = new Set<string>();

/**
 * Restates why a parked wave was closed after a reload or restart: the
 * live notice is not part of the persisted transcript. Each wave is
 * announced once per renderer process, after its conductor transcript is
 * loaded, so the notice lands after the history instead of before it.
 */
export function restoreParkedWaveNotices(
  state: WaveEngineState,
  onHydrated: () => void,
): void {
  for (const wave of state.waves) {
    if (
      wave.phase !== "needsOperator" ||
      !wave.closure ||
      announcedClosures.has(wave.waveId)
    )
      continue;
    const transcript = readConductorTranscript(
      wave.conductorSessionId,
      onHydrated,
    );
    if (transcript.kind !== "loaded") continue;
    announcedClosures.add(wave.waveId);
    // A restatement for the operator after a restart: the conductor was told
    // when the wave closed, and is not woken to be told again.
    skipConductorNoticeRelay(
      appendNotice(
        wave.conductorSessionId,
        waveClosureNoticeText(wave.closure),
        "error",
      ),
    );
  }
}

function nodesByWave(wave: WaveState): Map<number, SessionNode> {
  const nodes = Object.values(useConductorGraphStore.getState().nodesById);
  const byStep = new Map<number, SessionNode>();
  for (const step of wave.steps) {
    const node = waveStepNode(wave, step.stepIndex, nodes);
    if (node) byStep.set(step.stepIndex, node);
  }
  return byStep;
}

/**
 * The digest entries for a finished wave, one per step, in step order.
 *
 * Reads from the wave's own steps rather than from the graph, so a step whose
 * child was never registered still contributes a synthesized report instead of
 * silently shrinking the digest.
 */
function digestEntriesFor(wave: WaveState): DigestEntry[] {
  const graph = useConductorGraphStore.getState();
  const byStep = nodesByWave(wave);
  return collectWaveStepReports(
    wave,
    graph.getReport,
    (stepIndex) => byStep.get(stepIndex)?.status,
  ).map((entry) => {
    const node = byStep.get(entry.stepIndex);
    const step = wave.steps.find(
      (candidate) => candidate.stepIndex === entry.stepIndex,
    );
    // The app's own facts about the step, beside the worker's account: how
    // it was routed, and why it was stopped when the app stopped it.
    const notes = [
      ...(step?.dispatchNote ? [step.dispatchNote] : []),
      ...(node?.stopReason &&
      (entry.report.status === "cancelled" || node.status === "stopped") &&
      !entry.report.summary.includes(node.stopReason)
        ? [node.stopReason]
        : []),
    ];
    return {
      node: {
        displayName: node?.displayName ?? `Step ${entry.stepIndex + 1}`,
      },
      report: entry.report,
      ...(notes.length > 0 ? { appNote: notes.join(" ") } : {}),
    };
  });
}

/** The conductor's other live or queued waves, as the digest names them. */
function otherWavesOf(state: WaveEngineState, wave: WaveState) {
  return state.waves
    .filter(
      (candidate) =>
        candidate.conductorSessionId === wave.conductorSessionId &&
        candidate.waveId !== wave.waveId &&
        (isWaveLive(candidate) || candidate.phase === "queued"),
    )
    .map((candidate) => ({
      waveId: shortWaveId(candidate.waveId),
      stepCount: candidate.steps.length,
      phase: candidate.phase,
    }));
}

/**
 * Records a finished wave in its root request's task memory (P33).
 *
 * Fire-and-forget beside the digest, and deliberately at that point: the
 * revision this wave may earn is created inside the verdict pass and starts
 * spawning in the same tick, so a write that waited for the verdict would race
 * the readers it exists for. `recordWaveInTaskMemory` never throws — a request
 * with no project folder simply keeps no record.
 */
function recordWaveInMemory(wave: WaveState): void {
  const graph = useConductorGraphStore.getState();
  const byStep = nodesByWave(wave);
  const labels = new Map(
    wave.steps.map((step) => [step.stepIndex, step.label]),
  );
  const steps = collectWaveStepReports(
    wave,
    graph.getReport,
    (stepIndex) => byStep.get(stepIndex)?.status,
  ).map((entry) =>
    taskMemoryStepOf({
      role: entry.role,
      ...(labels.get(entry.stepIndex)
        ? { label: labels.get(entry.stepIndex) }
        : {}),
      report: entry.report,
    }),
  );
  void recordWaveInTaskMemory({
    conductorSessionId: wave.conductorSessionId,
    rootRequestId: wave.rootRequestId,
    goal: taskMemoryGoal(
      // Whatever the transcript cache already holds. This must not hydrate:
      // the goal is a nicety for a person reading the file, and no wave waits
      // on it.
      useChatStore.getState().messagesBySession[wave.conductorSessionId] ?? [],
      wave.rootRequestId,
      useChatSessionStore.getState().getSession(wave.conductorSessionId)
        ?.title ?? "",
    ),
    wave: {
      waveId: wave.waveId,
      attempt: wave.revisionCount + 1,
      verdict: "undecided",
      steps,
    },
  });
}

/** The document's verdict vocabulary for a phase the wave just moved to. */
function taskMemoryVerdictOf(phase: WavePhase): TaskMemoryVerdict {
  if (phase === "accepted") return "accept";
  if (phase === "revised") return "revise";
  if (phase === "needsOperator") return "needs-operator";
  return "undecided";
}

/**
 * Marks every report a wave is about to publish as published.
 *
 * `publishedToParent` is the idempotency flag of the whole envelope mechanism
 * and is set *before* the send, not after: a crash between the flag and the
 * dispatch loses a digest, a crash between the dispatch and the flag sends it
 * twice, and the second is the one that corrupts the conductor's context. The
 * wave's own `dispatchingDigest` phase plus the transcript-marker check is what
 * recovers the lost case.
 */
function markWaveReportsPublished(wave: WaveState): void {
  const graph = useConductorGraphStore.getState();
  for (const step of wave.steps) {
    if (!step.runId) continue;
    const report = graph.getReport(step.runId);
    if (!report || report.publishedToParent) continue;
    graph.attachReport({ ...report, publishedToParent: true });
  }
}

/**
 * One sample per this much wall clock before a wave waiting on a verdict that
 * is never coming is parked.
 *
 * Sized like the stall detector's window, and for the same reason: the states
 * this watches — "the queue no longer holds the digest", "the conductor is
 * idle and has not answered" — are both true for a moment in the healthy path,
 * between a digest being committed and the turn on it starting. Two samples a
 * minute apart cannot be that moment.
 */
export const WAVE_VERDICT_SILENCE_SAMPLE_MS = 60_000;

/** Consecutive silent samples that park the wave. */
export const WAVE_VERDICT_SILENCE_THRESHOLD = 2;

/** `waveId#attempt` → how long this wave has looked unanswerable. */
const verdictSilence = new Map<string, { strikes: number; at: number }>();

/**
 * Records one "this verdict is not coming" observation for a wave and says
 * whether enough of them have piled up, far enough apart, to act on.
 */
function noteVerdictSilence(wave: WaveState): boolean {
  return noteSilence(digestKey(wave.waveId, wave.digestAttempt));
}

/** The sampler behind {@link noteVerdictSilence}, for anything keyed. */
function noteSilence(key: string): boolean {
  const now = Date.now();
  const seen = verdictSilence.get(key);
  if (!seen) {
    verdictSilence.set(key, { strikes: 1, at: now });
    return false;
  }
  if (now - seen.at < WAVE_VERDICT_SILENCE_SAMPLE_MS) {
    return seen.strikes >= WAVE_VERDICT_SILENCE_THRESHOLD;
  }
  const strikes = seen.strikes + 1;
  verdictSilence.set(key, { strikes, at: now });
  return strikes >= WAVE_VERDICT_SILENCE_THRESHOLD;
}

/** Forgets a wave's samples: whatever looked lost is back. */
function clearVerdictSilence(wave: WaveState): void {
  verdictSilence.delete(digestKey(wave.waveId, wave.digestAttempt));
}

/**
 * True while the conductor's queue still holds the message that carries this
 * marker: a wave's digest, or a continue turn.
 */
function isMarkerQueued(conductorSessionId: string, marker: string): boolean {
  const queued =
    useChatStore.getState().queuedMessageBySession[conductorSessionId] ?? [];
  return queued.some(
    (record) =>
      record.kind === "transport-ready" && record.payload.text.includes(marker),
  );
}

/**
 * True while the conductor could still be about to answer: it is working, or
 * it has something queued that will put it to work.
 */
function conductorMayStillAnswer(conductorSessionId: string): boolean {
  const chat = useChatStore.getState();
  if ((chat.queuedMessageBySession[conductorSessionId]?.length ?? 0) > 0) {
    return true;
  }
  return isSessionRunning(chat.getSessionRuntime(conductorSessionId).chatState);
}

/**
 * Parks a wave whose verdict will never arrive, and offers the re-ask.
 *
 * Phase first, notice second, like every other transition here: the persisted
 * park is what stops the next tick from repeating the whole judgement.
 */
function parkUndecidedWave(
  state: WaveEngineState,
  wave: WaveState,
  decision: WaveVerdictDecision,
): WaveEngineState {
  clearVerdictSilence(wave);
  const phased = withWavePhase(
    withVerdictIssue(wave, decision.verdictIssue),
    decision.phase,
  );
  const parked = decision.closure
    ? { ...phased, closure: decision.closure }
    : phased;
  if (parked.closure) announcedClosures.add(parked.waveId);
  const next = withWave(state, parked);
  setWaveEngineState(next);
  recordWaveClose(
    parked,
    "needs-operator",
    decision.closure?.reason ?? "verdict-missing",
  );
  void recordTaskMemoryVerdict({
    conductorSessionId: wave.conductorSessionId,
    rootRequestId: wave.rootRequestId,
    waveId: wave.waveId,
    verdict: "needs-operator",
  });
  if (decision.closure) {
    appendNotice(
      wave.conductorSessionId,
      waveClosureNoticeText(decision.closure),
      "error",
      decision.offerRetry
        ? {
            type: "retryWaveDigest",
            sessionId: wave.conductorSessionId,
            waveId: wave.waveId,
          }
        : undefined,
    );
  }
  return next;
}

/**
 * Verdict pass. Runs first in the tick.
 *
 * For every wave in `awaitingVerdict`, finds its digest by marker and reads the
 * first settled assistant message after it. Whatever the outcome, that message
 * id is tombstoned so the plan detector can never re-admit it as a new root.
 */
export function processWaveVerdicts(
  state: WaveEngineState,
  onHydrated: () => void,
): WaveEngineState {
  let next = state;

  for (const wave of [...next.waves]) {
    if (wave.phase !== "awaitingVerdict") continue;
    // An unread transcript is not an unanswered digest. Without this the wave
    // would sit in `awaitingVerdict` for as long as the conductor chat stays
    // shut, which is the normal way this feature is used.
    const transcript = readConductorTranscript(
      wave.conductorSessionId,
      onHydrated,
    );
    if (transcript.kind === "unknown") continue;
    const messages = transcript.messages;
    const marker = waveDigestMarker(wave.waveId, wave.digestAttempt);
    const digestIndex = findDigestMessageIndex(messages, marker);
    if (digestIndex < 0) {
      // The digest is in neither the transcript nor the queue: it was cleared
      // from the queue, or the session it was queued on is gone. Nothing will
      // ever answer it, and a live wave the conductor cannot close refuses
      // every later plan it makes — so the wave is parked and the operator is
      // given the same "ask again" button an unreadable verdict earns (WAVES:
      // an undecided wave MUST offer the operator the ability to ask again).
      if (isMarkerQueued(wave.conductorSessionId, marker)) {
        clearVerdictSilence(wave);
        continue;
      }
      if (noteVerdictSilence(wave)) {
        next = parkUndecidedWave(next, wave, digestLostDecision());
      }
      continue;
    }
    const answer = findVerdictMessageAfter(messages, digestIndex, {
      // A message the engine already spent — another wave's verdict, or a
      // plan it admitted — is not this wave's answer, wherever it sits.
      isConsumed: (messageId) => hasWaveTombstone(next, messageId),
      waveId: wave.waveId,
      namedWaveOf: (message) => {
        const parsed = parseFlockVerdict(getTextContent(message));
        return parsed.kind === "verdict" ? parsed.verdict.waveId : undefined;
      },
    });
    if (!answer) {
      // The digest landed and no answer followed it. While the conductor is
      // working, that is the normal state of the loop; once it is idle or in
      // error with nothing queued, its turn on the digest is over and it
      // produced no answer — a failed turn, or one lost with a previous
      // process. Sampled over a minute apiece so the window between the
      // digest being committed and the turn starting is never mistaken for it.
      if (conductorMayStillAnswer(wave.conductorSessionId)) {
        clearVerdictSilence(wave);
        continue;
      }
      if (noteVerdictSilence(wave)) {
        next = parkUndecidedWave(next, wave, verdictUnansweredDecision());
      }
      continue;
    }
    clearVerdictSilence(wave);

    // Tombstone before deciding: this message is the wave's verdict and is
    // never a plan, whatever fences it carries. The watermark moves with it,
    // so a verdict whose tombstone is evicted years later is still not read as
    // a plan the next time this chat is opened.
    next = withProcessedMessageWatermark(
      withWaveTombstone(next, {
        planMessageId: answer.id,
        conductorSessionId: wave.conductorSessionId,
        outcome: "spawned",
        at: Date.now(),
      }),
      wave.conductorSessionId,
      answer.created,
    );
    setWaveEngineState(next);

    const decision = decideWaveVerdict({
      parse: parseFlockVerdict(getTextContent(answer)),
      revisionCount: wave.revisionCount,
      // E2: `accept` is honoured only on the verification step's evidence.
      // The decision stays pure — it is handed the wave and a report lookup,
      // not a store.
      wave,
      reportOf: useConductorGraphStore.getState().getReport,
    });
    next = applyVerdictDecision(next, wave, decision, answer.id);
    setWaveEngineState(next);
  }
  return next;
}

function applyVerdictDecision(
  state: WaveEngineState,
  wave: WaveState,
  decision: WaveVerdictDecision,
  verdictMessageId: string,
): WaveEngineState {
  let next = state;
  // Q5/M3: what was wrong with this answer rides on the wave, so the operator's
  // retry can re-ask in terms the conductor can act on. It is cleared whenever
  // the answer *was* readable, so a later retry never quotes a stale failure.
  const judged = withVerdictIssue(wave, decision.verdictIssue);
  if (decision.reasked) {
    // An accept the app could not honour goes back to the conductor once,
    // with the reason, as a new attempt of the same digest: a new marker, so
    // the answer just read can never be read again. The wave stays live and
    // nothing is recorded as closed; the operator sees why it went back.
    next = withWave(next, {
      ...withWavePhase(judged, "digestPending"),
      digestAttempt: wave.digestAttempt + 1,
    });
    // The re-sent digest tells the conductor this itself.
    skipConductorNoticeRelay(
      appendNotice(
        wave.conductorSessionId,
        waveAcceptReaskedNoticeText(decision.reasked),
        "warning",
      ),
    );
    return next;
  }
  const phased = withWavePhase(judged, decision.phase);
  // The closure notice is transient; the parked wave keeps its reason.
  const closed =
    decision.phase === "needsOperator" && decision.closure
      ? { ...phased, closure: decision.closure }
      : phased;
  if (closed.closure) announcedClosures.add(closed.waveId);
  // P33: the record already holds this wave's steps; this is the one fact it
  // could not know when it was written.
  void recordTaskMemoryVerdict({
    conductorSessionId: wave.conductorSessionId,
    rootRequestId: wave.rootRequestId,
    waveId: wave.waveId,
    verdict: taskMemoryVerdictOf(decision.phase),
  });

  if (decision.revision) {
    const admission = admitWavePlan(
      {
        kind: "plan",
        steps: [...decision.revision.steps],
        planText: "",
        prose: "",
      },
      // A revision's explicit step models face the same live check as a fresh
      // plan's — the verdict path must not be the door a silently unrunnable
      // model walks in through.
      {
        checkStepModel: checkExplicitWaveStepModel,
        checkStepRunSettings: (step) =>
          checkWaveStepRunSettings(step, wave.conductorSessionId),
      },
    );
    if (admission.kind === "rejected") {
      // The revision wave itself is unrunnable (a model nothing installed can
      // run, say). No revision is spent and the operator sees why.
      const parked = {
        ...withWavePhase(
          withVerdictIssue(judged, {
            reason: "invalid",
            detail: admission.detail,
          }),
          "needsOperator",
        ),
        closure: {
          reason: "verdict-invalid" as const,
          detail: admission.detail,
        },
      };
      announcedClosures.add(parked.waveId);
      next = withWave(next, parked);
      recordWaveClose(parked, "needs-operator", "verdict-invalid");
      appendNotice(
        wave.conductorSessionId,
        waveClosureNoticeText({
          reason: "verdict-invalid",
          detail: admission.detail,
        }),
        "error",
        {
          type: "retryWaveDigest",
          sessionId: wave.conductorSessionId,
          waveId: wave.waveId,
        },
      );
      return next;
    }
    const revision = createWaveState({
      waveId: crypto.randomUUID(),
      conductorSessionId: wave.conductorSessionId,
      planMessageId: verdictMessageId,
      steps: admission.steps,
      createdAt: Date.now(),
      rootRequestId: wave.rootRequestId,
      revisionCount: decision.revision.revisionIndex,
      // Q4: the revision's `"all"` steps see the previous wave of this root.
      // Q4: the same statuses as the digest, for the same reason — a
      // revision must not inherit "completed / result unknown" for a step
      // that was actually killed, or it plans around work nobody did.
      carriedReports: collectWaveStepReports(
        wave,
        useConductorGraphStore.getState().getReport,
        (stepIndex) => nodesByWave(wave).get(stepIndex)?.status,
      ).map((entry) => ({ ...entry, fromPreviousWave: true })),
      // An owned revision continues the native lineage and root budget.
      carriedBindingIds: ownedWaveLineage(
        wave,
        (stepIndex) => nodesByWave(wave).get(stepIndex)?.status,
      ),
    });
    next = withWave(next, revision);
    bumpWaveTelemetryCounter("admittedWaves");
    // E3a baseline for the revision wave. The probe settles through the
    // engine store, so it finds the wave once this tick's state is committed.
    startWaveGitProbe({
      waveId: revision.waveId,
      conductorSessionId: revision.conductorSessionId,
      point: "admission",
    });
  }

  next = isWaveRetired(closed)
    ? withoutWave(next, wave.waveId)
    : withWave(next, closed);
  if (decision.phase === "accepted") {
    next = armGoalContinuation(next, wave.conductorSessionId);
  }
  // The wave is leaving the live loop (retired now or parked for the
  // operator); its record outlives it — the engine state will not.
  recordWaveClose(
    closed,
    decision.phase === "accepted"
      ? "accepted"
      : decision.phase === "revised"
        ? "revised"
        : "needs-operator",
    decision.closure?.reason,
  );

  if (decision.closure && decision.phase === "needsOperator") {
    appendNotice(
      wave.conductorSessionId,
      waveClosureNoticeText(decision.closure),
      "error",
      decision.offerRetry
        ? {
            type: "retryWaveDigest",
            sessionId: wave.conductorSessionId,
            waveId: wave.waveId,
          }
        : undefined,
    );
  }
  return next;
}

/**
 * Parks a wave as interrupted (C3): a wave none of whose steps ever reported.
 *
 * Phase and closure first, then the record, then the operator's notice with
 * its retry — the same order as every other transition here, so a crash
 * between them resumes into a wave the scheduler never touches again. The
 * announcement is noted, so the restart restatement does not say it twice
 * in one process. Both askers use it: the digest pass, when the last step
 * goes terminal, and the scheduler, when a killed worker leaves nothing for
 * the next step to build on.
 */
export function parkInterruptedWave(
  state: WaveEngineState,
  wave: WaveState,
): { state: WaveEngineState; parked: WaveState } {
  const decision = waveInterruptedDecision();
  const closure = decision.closure ?? { reason: "wave-interrupted" };
  const parked: WaveState = {
    ...withWavePhase(wave, decision.phase),
    closure,
  };
  const next = withWave(state, parked);
  setWaveEngineState(next);
  announcedClosures.add(parked.waveId);
  recordWaveClose(parked, "needs-operator", closure.reason);
  appendNotice(
    wave.conductorSessionId,
    waveClosureNoticeText(closure),
    "error",
    {
      type: "retryWaveDigest",
      sessionId: wave.conductorSessionId,
      waveId: wave.waveId,
    },
  );
  return { state: next, parked };
}

/**
 * Digest pass. Runs after the engine has scheduled spawns.
 *
 * Moves `digestPending` waves to `dispatchingDigest` and returns the deliveries
 * to start once the tick's state has been committed — the same "persist first,
 * then act" order `waveRunner.ts` uses for spawns.
 */
export function processWaveDigests(
  state: WaveEngineState,
  onHydrated: () => void,
): {
  state: WaveEngineState;
  pending: PendingDigestDispatch[];
} {
  let next = state;
  const pending: PendingDigestDispatch[] = [];

  for (const wave of [...next.waves]) {
    if (wave.phase !== "digestPending" && wave.phase !== "dispatchingDigest") {
      continue;
    }
    const key = digestKey(wave.waveId, wave.digestAttempt);
    if (inFlightDigests.has(key)) continue;

    // A wave every step of which went terminal without a single report is not
    // a finished wave — it is an interrupted one. The startup reconcile
    // demotes children whose runtime died with the process to `stopped`,
    // which is terminal, so a restart mid-wave otherwise digests "unknown"
    // for every step: a model call spent judging nothing, and that junk
    // embedded in the prompt of any `access: "all"` step still to come.
    // Attempt 0 refuses; a digest the operator re-armed by hand goes through,
    // because by then they have read the notice and asked for it anyway.
    if (wave.phase === "digestPending" && wave.digestAttempt === 0) {
      const graph = useConductorGraphStore.getState();
      if (!hasAttestedWaveStepReport(wave, graph.getReport)) {
        next = parkInterruptedWave(next, wave).state;
        continue;
      }
    }

    if (wave.phase === "dispatchingDigest") {
      // Resuming after a restart (or after a delivery that never returned).
      // The transcript is the only honest witness: if the digest is there it
      // landed, and the wave is simply waiting for an answer. But a transcript
      // that was never loaded is not a witness at all — "absent" and "unknown"
      // are different answers, and only "absent" may re-deliver.
      const marker = waveDigestMarker(wave.waveId, wave.digestAttempt);
      const transcript = readConductorTranscript(
        wave.conductorSessionId,
        onHydrated,
      );
      if (transcript.kind === "unknown") continue;
      const messages = transcript.messages;
      if (findDigestMessageIndex(messages, marker) >= 0) {
        next = withWave(next, withWavePhase(wave, "awaitingVerdict"));
        continue;
      }
      if (isMarkerQueued(wave.conductorSessionId, marker)) {
        // Still parked in the parent's queue; it will commit when it drains.
        continue;
      }
    }

    // E3a: before the digest is built, the app itself asks git what actually
    // changed in the working folder. The wave waits for that answer — bounded
    // by the probe's own timeout — because this is the only line of the
    // digest no model authored. A probe that can never run (no Tauri, no
    // working folder) settles inline, so tests and degraded builds never wait.
    let live = wave;
    // Owned children work in native task copies; the conductor's folder is
    // not where their changes are, so its git count would be a false zero.
    // Their app-measured change count comes from the sealed artifact below.
    const ownedWave = ownedWaveFinalBinding(live.steps).owned;
    if (!live.gitDigestProbed) {
      if (
        !ownedWave &&
        startWaveGitProbe({
          waveId: live.waveId,
          conductorSessionId: live.conductorSessionId,
          point: "digest",
          onSettled: onHydrated,
        })
      ) {
        continue;
      }
      live = { ...live, gitDigestProbed: true };
    }
    // E3b, on the same terms as E3a: the app asks the filesystem whether the
    // files the reports named are there, and the digest waits for the answer
    // because it is the only fact in the loop a model cannot manufacture.
    if (!live.artifactsProbed) {
      if (
        startWaveArtifactProbe({
          waveId: live.waveId,
          conductorSessionId: live.conductorSessionId,
          reports: digestEntriesFor(live).map((entry) => entry.report),
          steps: live.steps,
          onSettled: onHydrated,
        })
      ) {
        continue;
      }
      live = { ...live, artifactsProbed: true };
    }
    markWaveReportsPublished(live);
    // P33: the request's own record of what it has already tried, written
    // before the verdict can turn this wave into another one.
    recordWaveInMemory(live);
    const gitDelta = waveGitDeltaOf(live);
    const artifacts = waveArtifactFactsOf(live);
    const text = buildWaveDigest({
      waveId: live.waveId,
      attempt: live.digestAttempt,
      entries: digestEntriesFor(live),
      revisionsLeft: Math.max(0, MAX_WAVE_REVISIONS - live.revisionCount),
      maxRevisions: MAX_WAVE_REVISIONS,
      otherWaves: otherWavesOf(next, live),
      ...(live.stalled ? { stalled: true } : {}),
      ...(gitDelta ? { gitDelta } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(live.nativeChangedFiles !== undefined
        ? { nativeChangedFiles: live.nativeChangedFiles }
        : {}),
      // Q5/M3: a re-asked digest says why it is being asked again. Re-sending
      // a byte-identical question to a model that already failed to answer it
      // is a model call spent on the same failure.
      ...(live.verdictIssue ? { verdictIssue: live.verdictIssue } : {}),
    });
    next = withWave(next, withWavePhase(live, "dispatchingDigest"));
    inFlightDigests.add(key);
    pending.push({
      waveId: live.waveId,
      attempt: live.digestAttempt,
      conductorSessionId: live.conductorSessionId,
      text,
    });
  }

  return { state: next, pending };
}

/**
 * Starts one digest delivery. Called after the tick has committed its state.
 *
 * `onSettled` re-runs the tick, exactly as a finished spawn does: the delivery
 * writes to stores that already re-entered and were rejected by the tick guard.
 */
export function startDigestDispatch(
  dispatch: PendingDigestDispatch,
  onSettled: () => void,
): void {
  const key = digestKey(dispatch.waveId, dispatch.attempt);
  void (async () => {
    try {
      const result = await deliverEnvelope(
        dispatch.conductorSessionId,
        dispatch.text,
      );
      if (result.status === "failed") {
        const decision = digestUndeliverableDecision(result.detail ?? "");
        let parked: WaveState | undefined;
        updateWaveEngineState((state) => {
          const current = state.waves.find(
            (candidate) => candidate.waveId === dispatch.waveId,
          );
          // Same guard as the success branch below, and for the same reason:
          // the operator's stop can land inside the delivery window. Parking a
          // wave they just stopped would append a second closure notice with a
          // retry button on it, and `recordWaveClose` would upsert over the
          // `operator-stopped` reason — so the telemetry record would forget
          // the stop and the button would re-digest a wave whose children are
          // already dead.
          if (!current || current.phase !== "dispatchingDigest") return state;
          parked = withWavePhase(current, decision.phase);
          return withWave(state, parked);
        });
        if (parked) {
          recordWaveClose(
            parked,
            "needs-operator",
            decision.closure?.reason ?? "digest-undeliverable",
          );
        }
        if (!parked) return;
        // One notice, carrying the reason *and* the digest itself: the reports
        // are already flagged published, so this transcript entry is the only
        // remaining copy of what the workers said. It also carries the retry
        // (P17): a send that failed is the one failure asking again is likely
        // to fix, and without the button the wave's whole result was lost to
        // it.
        appendNotice(
          dispatch.conductorSessionId,
          digestDeliveryFailureText(
            waveClosureNoticeText(
              decision.closure ?? { reason: "digest-undeliverable" },
            ),
            dispatch.text,
          ),
          "error",
          decision.offerRetry
            ? {
                type: "retryWaveDigest",
                sessionId: dispatch.conductorSessionId,
                waveId: dispatch.waveId,
              }
            : undefined,
        );
        return;
      }
      // Dispatched or queued: both mean the digest is on its way into the
      // transcript, and the verdict scan anchors on the marker once it lands.
      updateWaveEngineState((state) => {
        const current = state.waves.find(
          (candidate) => candidate.waveId === dispatch.waveId,
        );
        if (!current || current.phase !== "dispatchingDigest") return state;
        return withWave(state, withWavePhase(current, "awaitingVerdict"));
      });
    } finally {
      inFlightDigests.delete(key);
      onSettled();
    }
  })();
}

/**
 * How many "continue toward the goal" turns one goal may spend. Each one is a
 * conductor turn plus the wave it plans; forty is a long working day of
 * stages, and a goal that needs more is one the operator should look at.
 */
export const MAX_GOAL_CONTINUE_TURNS = 40;

/** Opening of every goal-turn marker. */
export const GOAL_MARKER_PREFIX = "[flock-goal:";

/** The marker line of one continue turn, by conductor and attempt. */
export function goalTurnMarker(conductorSessionId: string, attempt: number) {
  return `${GOAL_MARKER_PREFIX}${conductorSessionId.replace(/[^A-Za-z0-9:_-]/g, "-")}#${attempt}]`;
}

/** A continue turn the shell wants to send once the tick has committed. */
export interface PendingGoalDispatch {
  conductorSessionId: string;
  attempt: number;
  text: string;
}

/** Continue turns whose delivery is in flight in this process. */
const inFlightGoalTurns = new Set<string>();

function goalKey(conductorSessionId: string, attempt: number): string {
  return `${conductorSessionId}#${attempt}`;
}

/** The silence samples of a continue turn, apart from any wave's. */
function goalSilenceKey(conductorSessionId: string, attempt: number): string {
  return `goal:${goalKey(conductorSessionId, attempt)}`;
}

/**
 * Where a continue turn sits in the conductor's chat.
 *
 * Turn numbers start over with every new goal, so the chat can hold the same
 * marker from a goal before, with the answer that turn got. Read as this
 * turn's, that answer paused a loop one second after it was asked to go on
 * (2026-11-09, conductor 43b619ae: the new turn was still in the queue, and
 * the "#1" of the day before had been answered with a broken plan). Only a
 * message no older than the turn itself is this turn.
 */
function findGoalTurnIndex(
  messages: readonly Message[],
  marker: string,
  startedAt: number,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || message.created < startedAt) continue;
    if (getTextContent(message).includes(marker)) return index;
  }
  return -1;
}

/**
 * What the conductor has said since a continue turn landed, as the plan
 * detector would read it. More than one message when something was steered
 * into the turn: what was written before it settles on its own, and the rest
 * of the reply follows the steered message.
 */
function goalTurnAnswers(
  messages: readonly Message[],
  turnIndex: number,
): Message[] {
  return messages
    .slice(turnIndex + 1)
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.metadata?.completionStatus !== "inProgress" &&
        !isLegacyReplayReplyId(message.id),
    );
}

/**
 * Decides, on an accepted wave, whether the conductor is asked to go on.
 *
 * Only a roadmap whose status is "in-progress" arms a turn; a conductor with
 * no roadmap or a closed one is done when its wave is accepted, exactly as
 * before. One turn at a time: a second accept while a turn is in flight (two
 * concurrent waves closing together) joins the one already armed. Phase
 * first, like every other transition here — `pending` is persisted before
 * anything is sent, so a crash resumes into a turn that is still owed.
 */
function armGoalContinuation(
  state: WaveEngineState,
  conductorSessionId: string,
): WaveEngineState {
  const roadmap = state.roadmaps[conductorSessionId];
  if (!roadmap || roadmap.status !== "in-progress") return state;
  if (roadmap.continueTurn) return state;
  // While another wave of the conductor is still live, its digest is still
  // to come; the goal turn waits for the conductor's hands to be free.
  if (
    state.waves.some(
      (wave) =>
        wave.conductorSessionId === conductorSessionId && isWaveLive(wave),
    )
  ) {
    return state;
  }
  return armGoalTurnNow(state, roadmap);
}

function armGoalTurnNow(
  state: WaveEngineState,
  roadmap: ConductorRoadmap,
): WaveEngineState {
  if (roadmap.continueTurns >= MAX_GOAL_CONTINUE_TURNS) {
    appendNotice(
      roadmap.conductorSessionId,
      goalLoopNoticeText({ kind: "capped", max: MAX_GOAL_CONTINUE_TURNS }),
      "warning",
    );
    return withRoadmap(state, {
      ...roadmap,
      status: "paused",
      updatedAt: Date.now(),
    });
  }
  const attempt = roadmap.continueTurns + 1;
  return withRoadmap(state, {
    ...roadmap,
    continueTurns: attempt,
    continueTurn: { attempt, phase: "pending", startedAt: Date.now() },
  });
}

/**
 * Goal pass. Runs after the roadmap pass and before plan admission.
 *
 * Three jobs: a roadmap that went "in-progress" while its conductor has no
 * live wave gets a turn armed (the operator set the goal while nothing ran);
 * an armed turn is built into a message for the shell to send; and a sent
 * turn's answer is read — a plan means the loop goes on (admission picks it
 * up on this same tick), a roadmap that closed the goal ends it, and an
 * answer with neither pauses it so the conductor is never nudged in a loop
 * it has stopped answering.
 */
export function processGoalTurns(
  state: WaveEngineState,
  onHydrated: () => void,
): { state: WaveEngineState; pending: PendingGoalDispatch[] } {
  let next = state;
  const pending: PendingGoalDispatch[] = [];
  for (const roadmap of Object.values(next.roadmaps)) {
    const conductorSessionId = roadmap.conductorSessionId;
    const live = next.waves.some(
      (wave) =>
        wave.conductorSessionId === conductorSessionId && isWaveLive(wave),
    );
    if (!roadmap.continueTurn) {
      // A roadmap closed by the conductor while a turn was owed, or set with
      // nothing running: the first case is done, the second starts the loop.
      if (roadmap.status !== "in-progress" || live) continue;
      if (roadmap.continueTurns > 0) continue;
      // The goal was just published and nothing of the conductor's is live:
      // the conductor's own message carried the first plan, or it will plan
      // on the operator's next word. Nothing to send yet.
      continue;
    }
    const turn = roadmap.continueTurn;
    const key = goalKey(conductorSessionId, turn.attempt);
    if (roadmap.status !== "in-progress") {
      // The roadmap pass applied a block that closed or paused the goal.
      next = withRoadmap(next, withoutContinueTurn(roadmap));
      appendNotice(
        conductorSessionId,
        goalLoopNoticeText(
          roadmap.status === "reached"
            ? { kind: "reached" }
            : roadmap.status === "needs-operator"
              ? { kind: "needs-operator" }
              : { kind: "paused" },
        ),
        "warning",
      );
      continue;
    }
    if (turn.phase === "pending") {
      if (inFlightGoalTurns.has(key)) continue;
      const text = `${goalTurnMarker(conductorSessionId, turn.attempt)}\n${buildGoalContinueInstruction(
        {
          roadmap,
          turn: turn.attempt,
          maxTurns: MAX_GOAL_CONTINUE_TURNS,
        },
      )}`;
      next = withRoadmap(next, {
        ...roadmap,
        continueTurn: { ...turn, phase: "dispatching" },
      });
      inFlightGoalTurns.add(key);
      pending.push({ conductorSessionId, attempt: turn.attempt, text });
      appendNotice(
        conductorSessionId,
        goalLoopNoticeText({ kind: "continued", turn: turn.attempt }),
        "warning",
      );
      continue;
    }
    if (inFlightGoalTurns.has(key)) continue;
    const transcript = readConductorTranscript(conductorSessionId, onHydrated);
    if (transcript.kind === "unknown") continue;
    const marker = goalTurnMarker(conductorSessionId, turn.attempt);
    const silenceKey = goalSilenceKey(conductorSessionId, turn.attempt);
    const markerIndex = findGoalTurnIndex(
      transcript.messages,
      marker,
      turn.startedAt,
    );
    if (markerIndex < 0) {
      if (turn.phase === "dispatching") continue;
      // Sent, and not in the chat yet: a conductor still closing its verdict
      // turn has the request parked in its queue, and it lands when the
      // queue drains.
      if (isMarkerQueued(conductorSessionId, marker)) {
        verdictSilence.delete(silenceKey);
        continue;
      }
      // In neither place. A draining queue looks like that for a moment, so
      // only a turn that stays lost — the queue was cleared — pauses the
      // loop, rather than nudging into a transcript that lost it.
      if (!noteSilence(silenceKey)) continue;
      verdictSilence.delete(silenceKey);
      next = withRoadmap(next, {
        ...withoutContinueTurn(roadmap),
        status: "paused",
        updatedAt: Date.now(),
      });
      appendNotice(
        conductorSessionId,
        goalLoopNoticeText({ kind: "paused" }),
        "warning",
      );
      continue;
    }
    verdictSilence.delete(silenceKey);
    const answers = goalTurnAnswers(transcript.messages, markerIndex);
    // A plan in the answer is the loop going on — admission reads that
    // message on this very tick; a roadmap that closed the goal was applied
    // by the roadmap pass and handled above.
    const planned = answers.some(
      (answer) => parseFlockWave(getTextContent(answer)).kind === "plan",
    );
    if (planned) {
      next = withRoadmap(next, withoutContinueTurn(roadmap));
      continue;
    }
    // No plan so far. That is an answer without one only once the conductor
    // has finished the turn: while it works, or has something queued that
    // will put it to work, the rest of its reply is still to come.
    if (answers.length === 0 || conductorMayStillAnswer(conductorSessionId)) {
      if (turn.phase === "dispatching") {
        next = withRoadmap(next, {
          ...roadmap,
          continueTurn: { ...turn, phase: "awaiting" },
        });
      }
      continue;
    }
    next = withRoadmap(next, {
      ...withoutContinueTurn(roadmap),
      status: "paused",
      updatedAt: Date.now(),
    });
    appendNotice(
      conductorSessionId,
      goalLoopNoticeText({ kind: "paused" }),
      "warning",
    );
  }
  return { state: next, pending };
}

function withoutContinueTurn(roadmap: ConductorRoadmap): ConductorRoadmap {
  const { continueTurn: _cleared, ...rest } = roadmap;
  return rest;
}

/**
 * Sends one continue turn. Called after the tick has committed its state,
 * exactly like a digest; `onSettled` re-runs the tick.
 */
export function startGoalDispatch(
  dispatch: PendingGoalDispatch,
  onSettled: () => void,
): void {
  const key = goalKey(dispatch.conductorSessionId, dispatch.attempt);
  void (async () => {
    try {
      const result = await deliverEnvelope(
        dispatch.conductorSessionId,
        dispatch.text,
      );
      updateWaveEngineState((state) => {
        const roadmap = state.roadmaps[dispatch.conductorSessionId];
        if (!roadmap?.continueTurn) return state;
        if (roadmap.continueTurn.attempt !== dispatch.attempt) return state;
        if (result.status === "failed") {
          return withRoadmap(state, {
            ...withoutContinueTurn(roadmap),
            status: "paused",
            updatedAt: Date.now(),
          });
        }
        return withRoadmap(state, {
          ...roadmap,
          continueTurn: { ...roadmap.continueTurn, phase: "awaiting" },
        });
      });
      if (result.status === "failed") {
        appendNotice(
          dispatch.conductorSessionId,
          goalLoopNoticeText({
            kind: "undeliverable",
            detail: result.detail ?? "",
          }),
          "error",
        );
      }
    } finally {
      inFlightGoalTurns.delete(key);
      onSettled();
    }
  })();
}

/** Clears the process-local guards. Tests only. */
export function resetWaveLifecycleForTests(): void {
  inFlightDigests.clear();
  inFlightGoalTurns.clear();
  announcedClosures.clear();
  verdictSilence.clear();
  resetWaveGitProbeForTests();
  resetWaveArtifactProbeForTests();
  resetWaveTelemetryForTests();
  resetTaskMemoryIoForTests();
}
