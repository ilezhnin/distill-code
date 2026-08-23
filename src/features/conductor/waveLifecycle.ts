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
 * ## Why the verdict scan runs before plan admission
 *
 * A `revise` verdict is an assistant message carrying a `distill-wave` fence.
 * Left alone, the plan detector would admit it as a brand-new root wave — the
 * revision would run twice, once inside the loop and once outside it, and the
 * cap would not apply to the second. So this pass runs first in every tick and
 * writes a tombstone for the message it judged *before* returning; by the time
 * `admitCandidates` looks, that message id is already spent.
 */

import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { deliverEnvelope } from "./digestDelivery";
import { parseDistillVerdict } from "./distillVerdict";
import type { SessionNode } from "./types";
import {
  admitWavePlan,
  collectWaveStepReports,
  createWaveState,
  withWavePhase,
  type WaveState,
} from "./waveEngine";
import {
  buildWaveDigest,
  findDigestMessageIndex,
  findVerdictMessageAfter,
  waveDigestMarker,
  type DigestEntry,
} from "./waveDigest";
import {
  digestDeliveryFailureText,
  waveClosureNoticeText,
} from "./waveNotices";
import {
  decideWaveVerdict,
  digestUndeliverableDecision,
  isWaveRetired,
  type WaveVerdictDecision,
} from "./waveVerdict";
import {
  setWaveEngineState,
  updateWaveEngineState,
  withWave,
  withWaveTombstone,
  withoutWave,
  type WaveEngineState,
} from "./waveStore";
import { getTextContent } from "@/shared/types/messages";

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
): void {
  useChatStore
    .getState()
    .addMessage(sessionId, createSystemNotificationMessage(text, type, action));
}

function nodesByWave(waveId: string): Map<number, SessionNode> {
  const byStep = new Map<number, SessionNode>();
  for (const node of Object.values(
    useConductorGraphStore.getState().nodesById,
  )) {
    if (node.waveId !== waveId) continue;
    if (typeof node.stepIndex !== "number") continue;
    byStep.set(node.stepIndex, node);
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
  const byStep = nodesByWave(wave.waveId);
  return collectWaveStepReports(wave, graph.getReport).map((entry) => ({
    node: {
      displayName:
        byStep.get(entry.stepIndex)?.displayName ??
        `Step ${entry.stepIndex + 1}`,
    },
    report: entry.report,
  }));
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
 * Verdict pass. Runs first in the tick.
 *
 * For every wave in `awaitingVerdict`, finds its digest by marker and reads the
 * first settled assistant message after it. Whatever the outcome, that message
 * id is tombstoned so the plan detector can never re-admit it as a new root.
 */
export function processWaveVerdicts(state: WaveEngineState): WaveEngineState {
  const chat = useChatStore.getState();
  let next = state;

  for (const wave of [...next.waves]) {
    if (wave.phase !== "awaitingVerdict") continue;
    const messages = chat.messagesBySession[wave.conductorSessionId];
    const digestIndex = findDigestMessageIndex(
      messages,
      waveDigestMarker(wave.waveId, wave.digestAttempt),
    );
    if (digestIndex < 0) continue;
    const answer = findVerdictMessageAfter(messages, digestIndex);
    if (!answer) continue;

    // Tombstone before deciding: this message is the wave's verdict and is
    // never a plan, whatever fences it carries.
    next = withWaveTombstone(next, {
      planMessageId: answer.id,
      conductorSessionId: wave.conductorSessionId,
      outcome: "spawned",
      at: Date.now(),
    });
    setWaveEngineState(next);

    const decision = decideWaveVerdict({
      parse: parseDistillVerdict(getTextContent(answer)),
      revisionCount: wave.revisionCount,
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
  const closed = withWavePhase(wave, decision.phase);

  if (decision.revision) {
    const admission = admitWavePlan({
      kind: "plan",
      steps: [...decision.revision.steps],
      planText: "",
      prose: "",
    });
    if (admission.kind === "rejected") {
      // The revision wave itself is unrunnable (a `model` field, say). No
      // revision is spent and the operator sees why.
      const parked = withWavePhase(wave, "needsOperator");
      next = withWave(next, parked);
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
      carriedReports: collectWaveStepReports(
        wave,
        useConductorGraphStore.getState().getReport,
      ).map((entry) => ({ ...entry, fromPreviousWave: true })),
    });
    next = withWave(next, revision);
  }

  next = isWaveRetired(closed)
    ? withoutWave(next, wave.waveId)
    : withWave(next, closed);

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
 * Digest pass. Runs after the engine has scheduled spawns.
 *
 * Moves `digestPending` waves to `dispatchingDigest` and returns the deliveries
 * to start once the tick's state has been committed — the same "persist first,
 * then act" order `waveRunner.ts` uses for spawns.
 */
export function processWaveDigests(state: WaveEngineState): {
  state: WaveEngineState;
  pending: PendingDigestDispatch[];
} {
  const chat = useChatStore.getState();
  let next = state;
  const pending: PendingDigestDispatch[] = [];

  for (const wave of [...next.waves]) {
    if (wave.phase !== "digestPending" && wave.phase !== "dispatchingDigest") {
      continue;
    }
    const key = digestKey(wave.waveId, wave.digestAttempt);
    if (inFlightDigests.has(key)) continue;

    if (wave.phase === "dispatchingDigest") {
      // Resuming after a restart (or after a delivery that never returned).
      // The transcript is the only honest witness: if the digest is there it
      // landed, and the wave is simply waiting for an answer.
      const marker = waveDigestMarker(wave.waveId, wave.digestAttempt);
      const messages = chat.messagesBySession[wave.conductorSessionId];
      if (findDigestMessageIndex(messages, marker) >= 0) {
        next = withWave(next, withWavePhase(wave, "awaitingVerdict"));
        continue;
      }
      const queued = chat.queuedMessageBySession[wave.conductorSessionId] ?? [];
      if (
        queued.some(
          (record) =>
            record.kind === "transport-ready" &&
            record.payload.text.includes(marker),
        )
      ) {
        // Still parked in the parent's queue; it will commit when it drains.
        continue;
      }
    }

    markWaveReportsPublished(wave);
    const text = buildWaveDigest({
      waveId: wave.waveId,
      attempt: wave.digestAttempt,
      entries: digestEntriesFor(wave),
    });
    next = withWave(next, withWavePhase(wave, "dispatchingDigest"));
    inFlightDigests.add(key);
    pending.push({
      waveId: wave.waveId,
      attempt: wave.digestAttempt,
      conductorSessionId: wave.conductorSessionId,
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
        updateWaveEngineState((state) => {
          const current = state.waves.find(
            (candidate) => candidate.waveId === dispatch.waveId,
          );
          if (!current) return state;
          return withWave(state, withWavePhase(current, decision.phase));
        });
        // One notice, carrying the reason *and* the digest itself: the reports
        // are already flagged published, so this transcript entry is the only
        // remaining copy of what the workers said.
        appendNotice(
          dispatch.conductorSessionId,
          digestDeliveryFailureText(
            waveClosureNoticeText(
              decision.closure ?? { reason: "digest-undeliverable" },
            ),
            dispatch.text,
          ),
          "error",
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

/** True when this process holds a digest delivery for the wave. Tests only. */
export function hasInFlightDigestForTests(
  waveId: string,
  attempt: number,
): boolean {
  return inFlightDigests.has(digestKey(waveId, attempt));
}

/** Clears the process-local guards. Tests only. */
export function resetWaveLifecycleForTests(): void {
  inFlightDigests.clear();
}
