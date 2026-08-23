/**
 * The effectful shell of the wave engine.
 *
 * It runs from the global conductor sync (`useConductorGraphSync`), which is
 * mounted once for the whole app — so a wave keeps spawning and finishing with
 * the conductor chat closed, or never opened at all.
 *
 * Everything it decides is decided by the pure modules: `waveDetection.ts`
 * finds plan messages, `waveEngine.ts` admits plans and schedules steps,
 * `waveStore.ts` owns persistence, `waveNotices.ts` owns operator text. This
 * file only reads stores, spawns children and appends messages.
 *
 * Double-processing is impossible on two levels: a persisted tombstone per plan
 * message id (written before anything else happens, so a crash cannot lose it)
 * and in-memory in-flight sets for the async work the tombstone cannot cover —
 * the store subscription that calls this fires on every chat-store change.
 */

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { roleDisplayName } from "./roleLayers";
import { spawnConductorChildSession } from "./spawnOrchestrator";
import type { SessionNode } from "./types";
import { detectWavePlanCandidates } from "./waveDetection";
import {
  admitWavePlan,
  advanceWave,
  createWaveState,
  withWavePhase,
  withWaveStepPhase,
  type WaveSpawnRequest,
  type WaveState,
} from "./waveEngine";
import {
  processWaveDigests,
  processWaveVerdicts,
  resetWaveLifecycleForTests,
  startDigestDispatch,
  type PendingDigestDispatch,
} from "./waveLifecycle";
import {
  waveConcurrentPlanNoticeText,
  waveRejectionNoticeText,
  waveSpawnFailureText,
} from "./waveNotices";
import { isWaveLive } from "./waveVerdict";
import { buildWaveStepPrompt } from "./wavePrompts";
import { resetConductorTranscriptsForTests } from "./waveTranscripts";
import {
  getWaveEngineState,
  hasWaveTombstone,
  pruneOrphanedWaves,
  setWaveEngineState,
  updateWaveEngineState,
  withWave,
  withWaveTombstone,
  withoutParkedWavesFor,
  type WaveEngineState,
} from "./waveStore";

/**
 * Plan messages taken up in this process. The tombstone is written in the same
 * synchronous block, so this only guards against re-entrancy inside one tick.
 */
const inFlightPlans = new Set<string>();

/** `waveId:stepIndex` of spawns awaiting their child session. */
const inFlightSpawns = new Set<string>();

/**
 * Settled conductor messages already scanned and found to carry no plan. The
 * sync subscription fires on every chat-store change, so without this the
 * engine would re-read every message of every conductor transcript per token.
 */
const scannedWithoutPlan = new Set<string>();

/** Re-entrancy guard: spawning writes stores, which call this again. */
let ticking = false;

/**
 * Steps left `spawning` by a previous process are only adopted or reset on the
 * first tick of this one — mid-session a `spawning` step is just an awaited
 * spawn that has not registered its node yet.
 */
let hasResumedOrphanedSpawns = false;

function spawnKey(waveId: string, stepIndex: number): string {
  return `${waveId}:${stepIndex}`;
}

function conductorNodes(nodes: readonly SessionNode[]): SessionNode[] {
  return nodes.filter((node) => node.role === "conductor");
}

function appendConductorNotice(
  sessionId: string,
  text: string,
  retryAction: boolean,
  type: "error" | "warning" = "error",
  retryDetail?: string,
): void {
  useChatStore
    .getState()
    .addMessage(
      sessionId,
      createSystemNotificationMessage(
        text,
        type,
        retryAction
          ? { type: "retryWavePlan", sessionId, detail: retryDetail }
          : undefined,
      ),
    );
}

/** True when this conductor already has a wave that has not closed yet. */
function hasLiveWaveFor(
  state: WaveEngineState,
  conductorSessionId: string,
): boolean {
  return state.waves.some(
    (wave) =>
      wave.conductorSessionId === conductorSessionId && isWaveLive(wave),
  );
}

function admitCandidates(state: WaveEngineState): WaveEngineState {
  const graph = useConductorGraphStore.getState();
  const chat = useChatStore.getState();
  const conductors = conductorNodes(Object.values(graph.nodesById));
  if (conductors.length === 0) return state;

  const candidates = detectWavePlanCandidates({
    conductorSessionIds: conductors.map((node) => node.sessionId),
    messagesBySession: chat.messagesBySession,
    isProcessed: (planMessageId) =>
      scannedWithoutPlan.has(planMessageId) ||
      inFlightPlans.has(planMessageId) ||
      hasWaveTombstone(state, planMessageId),
    markScanned: (messageId) => scannedWithoutPlan.add(messageId),
  });

  let next = state;
  for (const candidate of candidates) {
    if (inFlightPlans.has(candidate.planMessageId)) continue;
    inFlightPlans.add(candidate.planMessageId);

    // One wave at a time per conductor. Admitting a second one while the first
    // is still live is the only unbounded cost path in the system: the
    // operator adds "and while you're in there…" mid-run, the conductor
    // answers with a plan because that is what it was told to do, and five
    // more sessions start editing the same working folder with no coordination
    // between the two waves. The refusal is tombstoned like any other, so it
    // is said once and not on every tick, and it is a warning rather than an
    // error because nobody did anything wrong.
    if (hasLiveWaveFor(next, candidate.conductorSessionId)) {
      next = withWaveTombstone(next, {
        planMessageId: candidate.planMessageId,
        conductorSessionId: candidate.conductorSessionId,
        outcome: "rejected",
        at: Date.now(),
      });
      setWaveEngineState(next);
      appendConductorNotice(
        candidate.conductorSessionId,
        waveConcurrentPlanNoticeText(),
        false,
        "warning",
      );
      next = getWaveEngineState();
      continue;
    }

    const admission = admitWavePlan(candidate.parse);
    if (admission.kind === "rejected") {
      // Tombstone first: a rejected plan must never re-error, even if
      // appending the notice throws.
      next = withWaveTombstone(next, {
        planMessageId: candidate.planMessageId,
        conductorSessionId: candidate.conductorSessionId,
        outcome: "rejected",
        at: Date.now(),
      });
      setWaveEngineState(next);
      appendConductorNotice(
        candidate.conductorSessionId,
        waveRejectionNoticeText(admission),
        true,
        "error",
        // Quoted back to the model when the operator asks for a new plan, so
        // the retry names the defect instead of asking blind (Q2 stays manual).
        admission.detail,
      );
      next = getWaveEngineState();
      continue;
    }

    const wave = createWaveState({
      waveId: crypto.randomUUID(),
      conductorSessionId: candidate.conductorSessionId,
      planMessageId: candidate.planMessageId,
      steps: admission.steps,
      createdAt: Date.now(),
    });
    next = withWave(
      // A new plan is a new root request, so this conductor's wave parked on
      // `needsOperator` (and the retry it backed) is stale and goes away.
      withoutParkedWavesFor(
        withWaveTombstone(next, {
          planMessageId: candidate.planMessageId,
          conductorSessionId: candidate.conductorSessionId,
          outcome: "spawned",
          at: Date.now(),
        }),
        candidate.conductorSessionId,
      ),
      wave,
    );
    setWaveEngineState(next);
  }
  return next;
}

function startSpawn(wave: WaveState, request: WaveSpawnRequest): void {
  const key = spawnKey(wave.waveId, request.stepIndex);
  inFlightSpawns.add(key);
  void (async () => {
    try {
      const { sessionId, runId } = await spawnConductorChildSession({
        parentSessionId: wave.conductorSessionId,
        role: "worker",
        managedBy: "wave",
        waveId: wave.waveId,
        stepIndex: request.stepIndex,
        anchorMessageId: wave.planMessageId,
        roleId: request.step.role,
        personaName: roleDisplayName(request.step.role),
        task: request.step.subtask,
        prompt: buildWaveStepPrompt(request.step, request.previousReports, {
          stepIndex: request.stepIndex,
          totalSteps: request.totalSteps,
        }),
      });
      updateWaveEngineState((state) => {
        const current = state.waves.find(
          (candidate) => candidate.waveId === wave.waveId,
        );
        if (!current) return state;
        return withWave(
          state,
          withWaveStepPhase(current, request.stepIndex, {
            phase: "spawned",
            sessionId,
            runId,
          }),
        );
      });
    } catch (error) {
      // No auto-retry (Q2): the step is marked failed so later `access: "all"`
      // steps stop waiting on it, and the operator sees why.
      updateWaveEngineState((state) => {
        const current = state.waves.find(
          (candidate) => candidate.waveId === wave.waveId,
        );
        if (!current) return state;
        return withWave(
          state,
          withWaveStepPhase(current, request.stepIndex, { phase: "failed" }),
        );
      });
      appendConductorNotice(
        wave.conductorSessionId,
        waveSpawnFailureText(
          request.stepIndex,
          error instanceof Error ? error.message : String(error),
        ),
        false,
      );
    } finally {
      inFlightSpawns.delete(key);
      // The spawn's own store writes already re-entered this tick and were
      // rejected by the guard; run once more now that it has settled.
      runWaveEngineTick();
    }
  })();
}

function advanceWaves(state: WaveEngineState): {
  state: WaveEngineState;
  pending: Array<{ wave: WaveState; request: WaveSpawnRequest }>;
} {
  const graph = useConductorGraphStore.getState();
  const nodes = Object.values(graph.nodesById);
  const resumeOrphanedSpawns = !hasResumedOrphanedSpawns;
  hasResumedOrphanedSpawns = true;

  let next = pruneOrphanedWaves(
    state,
    new Set(conductorNodes(nodes).map((node) => node.sessionId)),
  );
  const pending: Array<{ wave: WaveState; request: WaveSpawnRequest }> = [];

  for (const wave of [...next.waves]) {
    // Only a running wave schedules work. Everything past `running` belongs to
    // the digest/verdict pass, which must never see a new spawn appear under it.
    if (wave.phase !== "running") continue;
    const inFlight = new Set<number>();
    for (const step of wave.steps) {
      if (inFlightSpawns.has(spawnKey(wave.waveId, step.stepIndex))) {
        inFlight.add(step.stepIndex);
      }
    }
    const advanced = advanceWave(wave, {
      nodes,
      reportOf: graph.getReport,
      inFlight,
      resumeOrphanedSpawns,
    });
    let current = advanced.wave;
    if (advanced.complete) {
      // The wave is no longer *running*, but it is far from over: its reports
      // now have to reach the conductor and come back as a verdict. The record
      // stays and moves into the closed loop.
      next = withWave(next, withWavePhase(current, "digestPending"));
      continue;
    }
    for (const request of advanced.spawn) {
      current = withWaveStepPhase(current, request.stepIndex, {
        phase: "spawning",
      });
    }
    next = withWave(next, current);
    for (const request of advanced.spawn) {
      pending.push({ wave: current, request });
    }
  }
  return { state: next, pending };
}

/**
 * One pass of the engine: admit new plans, then move every live wave forward.
 *
 * Safe to call as often as the store subscription fires. It is synchronous up
 * to the point where the persisted state records each spawn as `spawning`; only
 * then are the spawns themselves started, so a crash mid-spawn resumes rather
 * than duplicates.
 */
export function runWaveEngineTick(): void {
  if (ticking) return;
  if (!useChatSessionStore.getState().hasHydratedSessions) return;
  ticking = true;
  let pending: Array<{ wave: WaveState; request: WaveSpawnRequest }> = [];
  let digests: PendingDigestDispatch[] = [];
  try {
    // Verdicts first: a `revise` verdict is an assistant message with a wave
    // fence in it, and this pass tombstones that message id before the plan
    // detector below ever looks at it. Without this order the revision would be
    // admitted a second time as a fresh root wave, outside the revision cap.
    // Both passes may have to hydrate a conductor transcript that was never
    // loaded in this process; when one lands, they re-run through this same
    // tick rather than waiting for an unrelated chat-store change.
    const judged = processWaveVerdicts(getWaveEngineState(), runWaveEngineTick);
    const admitted = admitCandidates(judged);
    const advanced = advanceWaves(admitted);
    const digested = processWaveDigests(advanced.state, runWaveEngineTick);
    setWaveEngineState(digested.state);
    pending = advanced.pending;
    digests = digested.pending;
  } finally {
    ticking = false;
  }
  for (const { wave, request } of pending) {
    startSpawn(wave, request);
  }
  for (const dispatch of digests) {
    startDigestDispatch(dispatch, runWaveEngineTick);
  }
}

/** Clears the process-local guards. Tests only. */
export function resetWaveRunnerForTests(): void {
  resetWaveLifecycleForTests();
  resetConductorTranscriptsForTests();
  inFlightPlans.clear();
  inFlightSpawns.clear();
  scannedWithoutPlan.clear();
  ticking = false;
  hasResumedOrphanedSpawns = false;
}
