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
import {
  createSystemNotificationMessage,
  type Message,
} from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { stopOrchestratorSession } from "./orchestratorControls";
import { roleDisplayName, waveStepDisplayName } from "./roleLayers";
import { SpawnAclDeniedError } from "./spawnAcl";
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
import { startWaveGitProbe } from "./waveGitProbe";
import {
  bumpWaveTelemetryCounter,
  countPlanlessConductorTurn,
  recordWaveClose,
} from "./waveTelemetryStore";
import {
  processWaveDigests,
  processWaveVerdicts,
  resetWaveLifecycleForTests,
  startDigestDispatch,
  type PendingDigestDispatch,
} from "./waveLifecycle";
import {
  waveConcurrentPlanNoticeText,
  waveStepExplicitModelNoticeText,
  waveStepModelNoticeText,
  waveRejectionNoticeText,
  waveReportDegradedNoticeText,
  waveSpawnFailureText,
} from "./waveNotices";
import { isWaveLive } from "./waveVerdict";
import { buildWaveStepPrompt } from "./wavePrompts";
import {
  checkExplicitWaveStepModel,
  resolveExplicitWaveStepModel,
  resolveWaveStepTarget,
} from "./waveStepTarget";
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

/**
 * Wave ids whose conductor was missing from the graph on the previous tick.
 * A wave is only pruned when it is orphaned on TWO consecutive ticks: the
 * draft-id remap of a conductor session lands between ticks, so a live wave
 * can legitimately be "orphaned" for exactly one of them, and pruning on the
 * first sighting erased it — running children and all — with no digest and no
 * notice (risk №3 of the wave audit).
 */
let onceOrphanedWaveIds = new Set<string>();

/**
 * Hard ceiling on one child spawn: session creation plus prompt delivery,
 * normally seconds. Without it a hung backend held the step in `spawning`
 * forever and the wave never finished. On timeout the step fails per Q2 (no
 * auto-retry, operator told why); a session that still materializes later is
 * stopped rather than adopted — the step's failure was already announced.
 */
export const WAVE_SPAWN_TIMEOUT_MS = 120_000;

/**
 * How long a completed step may stay reportless before its dependents (and
 * the digest) proceed on a synthesized "result unknown" stub. The report
 * parse routinely lands a tick after the status flip; the grace turns that
 * race into a short wait for the real report instead of a stub the verdict
 * would then be rendered on. A report that truly never comes (a worker that
 * finished without emitting `distill-report`) still degrades to the stub —
 * after the grace, not instead of it.
 */
export const WAVE_REPORT_GRACE_MS = 20_000;

/** `waveId:stepIndex` → grace deadline for a completed-but-reportless step. */
const reportGraceDeadlines = new Map<string, number>();

/** Single pending wake-up so an expired grace re-ticks a quiet app. */
let graceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGraceTick(delayMs: number): void {
  if (graceTimer !== null) return;
  graceTimer = setTimeout(() => {
    graceTimer = null;
    runWaveEngineTick();
  }, delayMs + 50);
}

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
): string {
  const message = createSystemNotificationMessage(
    text,
    type,
    retryAction
      ? { type: "retryWavePlan", sessionId, detail: retryDetail }
      : undefined,
  );
  useChatStore.getState().addMessage(sessionId, message);
  return message.id;
}

/**
 * The concurrent-refusal card of one live wave, and how many plans it has
 * refused so far.
 *
 * The refusal used to be posted per refused plan, which is right as an audit
 * fact — every plan really was tombstoned — and wrong as something to read: a
 * message queue drained after a restart turns "one card per plan" into seven
 * identical walls of text in a row (seen 2026-08-25). One card per wave says
 * the rule once and carries the only thing that changes, the count.
 *
 * In memory on purpose: after a restart the wave may still be live and a fresh
 * card is the honest outcome — this process never posted the earlier one, and
 * a stale message id would silently update nothing.
 */
const concurrentRefusalNotices = new Map<
  string,
  { sessionId: string; messageId: string; count: number }
>();

function withNoticeText(message: Message, text: string): Message {
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "systemNotification" ? { ...part, text } : part,
    ),
  };
}

/** Posts — or, for a wave that already refused one, updates — the card. */
function noteConcurrentRefusal(
  state: WaveEngineState,
  sessionId: string,
  waveId: string,
): void {
  for (const knownWaveId of [...concurrentRefusalNotices.keys()]) {
    const stillLive = state.waves.some(
      (wave) => wave.waveId === knownWaveId && isWaveLive(wave),
    );
    if (!stillLive) concurrentRefusalNotices.delete(knownWaveId);
  }

  const existing = concurrentRefusalNotices.get(waveId);
  if (existing) {
    const count = existing.count + 1;
    concurrentRefusalNotices.set(waveId, { ...existing, count });
    useChatStore
      .getState()
      .updateMessage(existing.sessionId, existing.messageId, (message) =>
        withNoticeText(message, waveConcurrentPlanNoticeText(count)),
      );
    return;
  }

  const messageId = appendConductorNotice(
    sessionId,
    waveConcurrentPlanNoticeText(1),
    false,
    "warning",
  );
  concurrentRefusalNotices.set(waveId, { sessionId, messageId, count: 1 });
}

/** True when this conductor already has a wave that has not closed yet. */
function liveWaveFor(
  state: WaveEngineState,
  conductorSessionId: string,
): WaveState | undefined {
  return state.waves.find(
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
    markScanned: (messageId, context) => {
      scannedWithoutPlan.add(messageId);
      // The wave-rate denominator: a settled conductor turn that answered
      // directly. The telemetry store deduplicates re-scans after restarts.
      countPlanlessConductorTurn(context.conductorSessionId, context.createdAt);
    },
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
    const liveWave = liveWaveFor(next, candidate.conductorSessionId);
    if (liveWave) {
      next = withWaveTombstone(next, {
        planMessageId: candidate.planMessageId,
        conductorSessionId: candidate.conductorSessionId,
        outcome: "rejected",
        at: Date.now(),
      });
      setWaveEngineState(next);
      bumpWaveTelemetryCounter("concurrentRefusals");
      noteConcurrentRefusal(
        next,
        candidate.conductorSessionId,
        liveWave.waveId,
      );
      next = getWaveEngineState();
      continue;
    }

    // 4a/D5: a step's explicit model is checked against the live inventory
    // and limits HERE, while nothing is spawned — a refused plan costs the
    // conductor a replan, not a half-started wave.
    const admission = admitWavePlan(candidate.parse, {
      checkStepModel: checkExplicitWaveStepModel,
    });
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
      bumpWaveTelemetryCounter("rejectedPlans");
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
    bumpWaveTelemetryCounter("admittedWaves");
    // E3a baseline: what git saw in the working folder before any worker did
    // anything. Fire-and-forget — nothing waits on it; a baseline that never
    // lands just degrades the digest line to "not captured".
    startWaveGitProbe({
      waveId: wave.waveId,
      conductorSessionId: candidate.conductorSessionId,
      point: "admission",
    });
  }
  return next;
}

function startSpawn(wave: WaveState, request: WaveSpawnRequest): void {
  const key = spawnKey(wave.waveId, request.stepIndex);
  inFlightSpawns.add(key);
  // 4a: an explicit step model wins over the role's ranking — the plan said
  // exactly where this step runs; the ranking is the default for steps that
  // did not. The ranking is not even consulted, so its fallback/near-limit
  // notices cannot fire about a model that is not going to be used.
  const explicitModel = request.step.model;
  const stepTarget = explicitModel
    ? undefined
    : resolveWaveStepTarget(request.step.role);
  if (stepTarget && (stepTarget.fallback || stepTarget.nearLimit)) {
    // D5: a step that is not running on its first choice says so, once, where
    // the operator is already watching the wave.
    appendConductorNotice(
      wave.conductorSessionId,
      waveStepModelNoticeText({
        stepIndex: request.stepIndex,
        name: roleDisplayName(request.step.role),
        model: stepTarget.label,
        nearLimit: stepTarget.nearLimit,
      }),
      false,
      "warning",
    );
  }
  void (async () => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Resolved at spawn, not carried from admission: an `access: "all"`
      // step can start long after the plan was admitted, and the inventory is
      // read fresh so the target names the model as it exists now. A model
      // that vanished in between fails the step per Q2 — the throw lands in
      // the catch below with the resolver's own explanation — never a silent
      // inherit (D5). A window that merely filled up since admission does not
      // fail a mid-flight wave: the instruction is honoured and the operator
      // warned, because killing the step over a meter that moved is worse
      // than the cut-off the meter predicts.
      let executionTarget = stepTarget?.target;
      if (explicitModel) {
        const resolved = resolveExplicitWaveStepModel(explicitModel);
        if (!resolved.ok) throw new Error(resolved.detail);
        executionTarget = resolved.target;
        if (resolved.limit !== "clear") {
          appendConductorNotice(
            wave.conductorSessionId,
            waveStepExplicitModelNoticeText({
              stepIndex: request.stepIndex,
              name: roleDisplayName(request.step.role),
              model: resolved.label,
            }),
            false,
            "warning",
          );
        }
      }
      const spawnPromise = spawnConductorChildSession({
        parentSessionId: wave.conductorSessionId,
        role: "worker",
        managedBy: "wave",
        waveId: wave.waveId,
        stepIndex: request.stepIndex,
        anchorMessageId: wave.planMessageId,
        roleId: request.step.role,
        // "Scout · waveEngine", not three identical "Scout"s: the handle is
        // what makes chips, tabs and digests tell siblings apart. A label the
        // plan gave wins over the derived subtask handle.
        displayName: waveStepDisplayName(
          request.step.role,
          request.step.subtask,
          request.step.label,
        ),
        personaName: roleDisplayName(request.step.role),
        // The plan's explicit model when the step named one, else the role's
        // ranking walked against the live limits; `undefined` means "inherit
        // the conductor", which is what every wave child did before rankings
        // reached this path.
        ...(executionTarget ? { executionTarget } : {}),
        task: request.step.subtask,
        prompt: buildWaveStepPrompt(request.step, request.previousReports, {
          stepIndex: request.stepIndex,
          totalSteps: request.totalSteps,
        }),
      });
      // A spawn that beats the timeout after the step was already failed must
      // not run as an orphan worker: stop it instead of adopting it.
      spawnPromise
        .then(({ sessionId }) => {
          if (timedOut) void stopOrchestratorSession(sessionId);
        })
        .catch(() => {
          // The main await below reports this rejection; nothing to do here.
        });
      const { sessionId, runId } = await Promise.race([
        spawnPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `the child session did not start within ${Math.round(WAVE_SPAWN_TIMEOUT_MS / 1000)}s`,
              ),
            );
          }, WAVE_SPAWN_TIMEOUT_MS);
        }),
      ]);
      // Adopt the child only into a wave that is still running. A wave the
      // operator stopped (5b) — or one that was pruned — must not gain a
      // worker after the fact: the child was spawned with a real prompt and
      // would do real work that nothing manages, reports to, or stops. Same
      // reasoning as the timeout race above, one failure mode over.
      let adopted = false;
      updateWaveEngineState((state) => {
        const current = state.waves.find(
          (candidate) => candidate.waveId === wave.waveId,
        );
        if (!current || current.phase !== "running") return state;
        adopted = true;
        return withWave(
          state,
          withWaveStepPhase(current, request.stepIndex, {
            phase: "spawned",
            sessionId,
            runId,
          }),
        );
      });
      if (!adopted) void stopOrchestratorSession(sessionId);
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
      // A spawn the ACL refused already posted its own notice at the
      // chokepoint (spawnAcl.ts / spawnConductorChildSession); repeating it
      // as a generic spawn failure would say the same thing twice.
      if (!(error instanceof SpawnAclDeniedError)) {
        appendConductorNotice(
          wave.conductorSessionId,
          waveSpawnFailureText(
            request.stepIndex,
            error instanceof Error ? error.message : String(error),
          ),
          false,
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

  // Orphan cleanup, guarded twice. A graph that knows NO conductors while
  // waves are on the books is a hydration gap or a corrupt graph key — not a
  // world where every conductor chat vanished at once — so nothing is pruned
  // there. And a wave is only pruned on its second consecutive orphaned tick,
  // which rides out the conductor draft-id remap racing a tick.
  let next = state;
  const knownConductors = new Set(
    conductorNodes(nodes).map((node) => node.sessionId),
  );
  if (knownConductors.size > 0) {
    const orphaned = state.waves.filter(
      (wave) => !knownConductors.has(wave.conductorSessionId),
    );
    const prunable = new Set(
      orphaned
        .filter((wave) => onceOrphanedWaveIds.has(wave.waveId))
        .map((wave) => wave.waveId),
    );
    onceOrphanedWaveIds = new Set(orphaned.map((wave) => wave.waveId));
    if (prunable.size > 0) {
      // The prune erases these waves from the engine state; the telemetry
      // record is the only trace that they ran at all.
      for (const wave of orphaned) {
        if (prunable.has(wave.waveId)) recordWaveClose(wave, "pruned");
      }
      next = pruneOrphanedWaves(state, knownConductors, prunable);
    }
  } else {
    onceOrphanedWaveIds = new Set();
  }
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
      allowSyntheticReportFor: (stepIndex) => {
        const key = spawnKey(wave.waveId, stepIndex);
        const now = Date.now();
        const deadline = reportGraceDeadlines.get(key);
        if (deadline === undefined) {
          reportGraceDeadlines.set(key, now + WAVE_REPORT_GRACE_MS);
          scheduleGraceTick(WAVE_REPORT_GRACE_MS);
          return false;
        }
        if (now < deadline) {
          scheduleGraceTick(deadline - now);
          return false;
        }
        return true;
      },
    });
    // 5b: a step that just went terminal on the "result unknown" stub is
    // announced to the operator. The engine's persisted `reportDegraded` flag
    // keeps this to one notice per step; this loop is only the messenger.
    for (const stepIndex of advanced.degraded) {
      const step = advanced.wave.steps.find(
        (candidate) => candidate.stepIndex === stepIndex,
      );
      const child = nodes.find(
        (candidate) =>
          candidate.waveId === wave.waveId && candidate.stepIndex === stepIndex,
      );
      appendConductorNotice(
        wave.conductorSessionId,
        waveReportDegradedNoticeText(
          stepIndex,
          child?.displayName ??
            (step ? roleDisplayName(step.role) : `#${stepIndex + 1}`),
        ),
        false,
        "warning",
      );
    }
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
  concurrentRefusalNotices.clear();
  ticking = false;
  hasResumedOrphanedSpawns = false;
  onceOrphanedWaveIds = new Set();
  reportGraceDeadlines.clear();
  if (graceTimer !== null) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}
