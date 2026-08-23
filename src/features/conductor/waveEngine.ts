/**
 * The wave engine's decision logic, as pure functions.
 *
 * Everything that decides *what should happen* to a wave lives here: whether a
 * parsed plan may run at all (`admitWavePlan`), and — given the wave's persisted
 * state plus the current graph nodes and reports — which steps must be spawned
 * right now and what the wave's next state is (`advanceWave`).
 *
 * Nothing in this module touches a store, spawns a session, or renders a
 * notice. `waveRunner.ts` is the thin effectful shell around it.
 */

import type {
  DistillWaveParse,
  WaveInvalid,
  WaveInvalidReason,
  WavePlan,
  WaveStep,
  WaveStepAccess,
} from "./distillWave";
import type { RunStatus, SessionNode, StructuredReport } from "./types";
import type { CompletedWaveStepReport } from "./wavePrompts";

/** Lifecycle of a single step inside a persisted wave. */
export type WaveStepPhase =
  /** Not started. Waiting on its `access` precondition, or just created. */
  | "pending"
  /** A spawn was started for this step; the child node is not visible yet. */
  | "spawning"
  /** A graph node exists for this step; the graph owns its status from here. */
  | "spawned"
  /**
   * The spawn itself threw and no child exists. Terminal: there is no
   * auto-retry (Q2), and later steps must not wait on it forever.
   */
  | "failed";

export interface WaveStepState {
  stepIndex: number;
  role: string;
  subtask: string;
  access: WaveStepAccess;
  phase: WaveStepPhase;
  /** Child session id, once the spawn produced one. */
  sessionId?: string;
  /** Child run id, once the spawn produced one. */
  runId?: string;
}

export interface WaveState {
  waveId: string;
  /** Conductor session that authored the plan; the children's parent. */
  conductorSessionId: string;
  /** Assistant message that carried the `distill-wave` fence. */
  planMessageId: string;
  createdAt: number;
  steps: WaveStepState[];
}

/**
 * Why a plan was refused. Every `WaveInvalidReason` from the parser, plus the
 * reasons the engine itself adds on top of a syntactically valid plan.
 */
export type WaveRejectionReason =
  | WaveInvalidReason
  /**
   * A step carries `model`. Per-step model resolution ships in 4a; until then
   * honouring the field would silently run the step on the conductor's model,
   * which D5 forbids. The whole plan is refused, before any spawn.
   */
  | "step-model-unsupported";

export type WaveAdmission =
  | { kind: "accepted"; steps: readonly WaveStep[] }
  | {
      kind: "rejected";
      reason: WaveRejectionReason;
      /** Operator-readable explanation from the parser or the engine. */
      detail: string;
      /** Zero-based offending step, when the reason is per-step. */
      stepIndex?: number;
    };

/** Statuses a run can no longer leave on its own. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "stopped"
  );
}

/** Report status for a terminal run. `stopped` reports as `failed`. */
export function reportStatusForTerminalRun(
  status: RunStatus,
): StructuredReport["status"] {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * Summary used when a terminal step never produced a report.
 *
 * This is prompt text handed to a later worker, not operator chrome, so it is
 * a plain constant like everything else in `wavePrompts.ts`.
 */
export const MISSING_STEP_REPORT_SUMMARY =
  "This step finished without a report. Treat its result as unknown.";

/** Summary used for a step whose worker could never be started at all. */
export const UNSTARTED_STEP_REPORT_SUMMARY =
  "This step could not be started, so it produced no result.";

/**
 * Stand-in report for a terminal step the graph has no report for.
 *
 * A wave must never wait forever on a report that is not coming: a step that is
 * terminal is handed on with a synthesized report that says exactly that, and
 * `needsOperator` set so the gap is visible downstream.
 */
export function synthesizeMissingStepReport(
  runId: string,
  status: RunStatus,
  summary: string = MISSING_STEP_REPORT_SUMMARY,
): StructuredReport {
  return {
    runId,
    status: reportStatusForTerminalRun(status),
    summary,
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: true,
    nextSuggestedTask: null,
  };
}

function rejected(
  reason: WaveRejectionReason,
  detail: string,
  stepIndex?: number,
): WaveAdmission {
  return stepIndex === undefined
    ? { kind: "rejected", reason, detail }
    : { kind: "rejected", reason, detail, stepIndex };
}

/**
 * Decides whether a parsed conductor message may become a running wave.
 *
 * A `{ kind: "none" }` parse is not a plan at all and must never reach here —
 * callers filter it out; passing it is treated as "nothing to admit" by
 * returning a rejection the caller can ignore, never by throwing.
 *
 * The D5 gap-guard is enforced here, before the caller has spawned anything:
 * a plan where *any* step carries `model` is refused whole.
 */
export function admitWavePlan(
  parse: WavePlan | WaveInvalid | DistillWaveParse,
): WaveAdmission {
  if (parse.kind === "invalid") {
    return rejected(parse.reason, parse.detail, parse.stepIndex);
  }
  if (parse.kind !== "plan") {
    return rejected(
      "steps-empty",
      "There is no wave plan in this message to run.",
    );
  }

  const modelStepIndex = parse.steps.findIndex((step) => step.model);
  if (modelStepIndex >= 0) {
    const step = parse.steps[modelStepIndex];
    return rejected(
      "step-model-unsupported",
      `Step ${modelStepIndex + 1} asks for model "${step.model}". Per-step models are not supported yet, and running the step on another model would be a silent substitution, so the whole wave was refused. Re-send the plan without "model".`,
      modelStepIndex,
    );
  }

  return { kind: "accepted", steps: parse.steps };
}

/** Builds the initial persisted state for an admitted plan. */
export function createWaveState(args: {
  waveId: string;
  conductorSessionId: string;
  planMessageId: string;
  steps: readonly WaveStep[];
  createdAt: number;
}): WaveState {
  return {
    waveId: args.waveId,
    conductorSessionId: args.conductorSessionId,
    planMessageId: args.planMessageId,
    createdAt: args.createdAt,
    steps: args.steps.map((step, stepIndex) => ({
      stepIndex,
      role: step.role,
      subtask: step.subtask,
      access: step.access,
      phase: "pending" as const,
    })),
  };
}

/** Returns a wave with one step's spawn bookkeeping replaced. */
export function withWaveStepPhase(
  wave: WaveState,
  stepIndex: number,
  patch: {
    phase: WaveStepPhase;
    sessionId?: string;
    runId?: string;
  },
): WaveState {
  let changed = false;
  const steps = wave.steps.map((step) => {
    if (step.stepIndex !== stepIndex) return step;
    const next: WaveStepState = {
      stepIndex: step.stepIndex,
      role: step.role,
      subtask: step.subtask,
      access: step.access,
      phase: patch.phase,
      ...((patch.sessionId ?? step.sessionId)
        ? { sessionId: patch.sessionId ?? step.sessionId }
        : {}),
      ...((patch.runId ?? step.runId)
        ? { runId: patch.runId ?? step.runId }
        : {}),
    };
    if (!sameStep(step, next)) changed = true;
    return next;
  });
  return changed ? { ...wave, steps } : wave;
}

export interface WaveSpawnRequest {
  stepIndex: number;
  /** The step to spawn, rebuilt from the persisted state. */
  step: WaveStep;
  /** Reports of every earlier step. Empty unless `step.access` is `"all"`. */
  previousReports: readonly CompletedWaveStepReport[];
  totalSteps: number;
}

export interface WaveAdvanceContext {
  /** Graph nodes to match against; non-wave nodes are ignored. */
  nodes: readonly SessionNode[];
  /** Report lookup by run id. */
  reportOf: (runId: string | null | undefined) => StructuredReport | undefined;
  /**
   * Step indexes whose spawn is in flight *in this process*. They are never
   * re-requested and never reset, however this advance is configured.
   */
  inFlight?: ReadonlySet<number>;
  /**
   * Reset steps stuck in `spawning` with no node back to `pending`.
   *
   * Only true on the first advance after app start: mid-session a `spawning`
   * step is simply an awaited spawn that has not registered its node yet.
   */
  resumeOrphanedSpawns?: boolean;
}

export interface WaveAdvance {
  /** The wave with node facts folded back in. Replaces the stored state. */
  wave: WaveState;
  /** True when `wave` differs from the input; lets callers skip a write. */
  changed: boolean;
  /** Steps to spawn now, in step order. */
  spawn: readonly WaveSpawnRequest[];
  /** Every step is spawned and terminal — the wave is over. */
  complete: boolean;
}

function stepToWaveStep(state: WaveStepState): WaveStep {
  return { role: state.role, subtask: state.subtask, access: state.access };
}

function sameStep(left: WaveStepState, right: WaveStepState): boolean {
  return (
    left.phase === right.phase &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId
  );
}

/**
 * Folds the graph's view of a wave back into the wave's own state and returns
 * the steps that may start now.
 *
 * Reconciliation is what makes a restart safe: a step whose child node exists
 * is `spawned` no matter what the persisted phase said, so a wave resumed from
 * localStorage never spawns a second worker for a step that already has one.
 *
 * Scheduling follows D2: `access: []` steps start immediately and in parallel;
 * an `access: "all"` step waits until *every* earlier step of its wave is
 * terminal and then receives their reports. A failed earlier step does not
 * block — its failure report is part of the handoff — and a terminal step with
 * no report at all contributes {@link synthesizeMissingStepReport} rather than
 * stalling the wave forever.
 */
export function advanceWave(
  wave: WaveState,
  context: WaveAdvanceContext,
): WaveAdvance {
  const inFlight = context.inFlight ?? new Set<number>();
  const nodeByStepIndex = new Map<number, SessionNode>();
  for (const node of context.nodes) {
    if (node.waveId !== wave.waveId) continue;
    if (typeof node.stepIndex !== "number") continue;
    nodeByStepIndex.set(node.stepIndex, node);
  }

  let changed = false;
  const steps = wave.steps.map((step) => {
    const node = nodeByStepIndex.get(step.stepIndex);
    let next: WaveStepState = step;
    if (node) {
      next = {
        ...step,
        phase: "spawned",
        sessionId: node.sessionId,
        runId: node.runId ?? undefined,
      };
    } else if (
      step.phase === "spawning" &&
      context.resumeOrphanedSpawns &&
      !inFlight.has(step.stepIndex)
    ) {
      next = {
        stepIndex: step.stepIndex,
        role: step.role,
        subtask: step.subtask,
        access: step.access,
        phase: "pending",
      };
    }
    if (!sameStep(step, next)) changed = true;
    return next;
  });

  const statusByStepIndex = new Map<number, RunStatus>();
  for (const step of steps) {
    const node = nodeByStepIndex.get(step.stepIndex);
    if (node) statusByStepIndex.set(step.stepIndex, node.status);
  }

  const isStepTerminal = (step: WaveStepState): boolean => {
    if (step.phase === "failed") return true;
    if (step.phase !== "spawned") return false;
    const status = statusByStepIndex.get(step.stepIndex);
    return status !== undefined && isTerminalRunStatus(status);
  };

  const reportForEarlierStep = (
    previous: WaveStepState,
  ): CompletedWaveStepReport => {
    const fallbackRunId =
      previous.runId ?? `${wave.waveId}:step:${previous.stepIndex}`;
    const existing = previous.runId
      ? context.reportOf(previous.runId)
      : undefined;
    const report =
      existing ??
      (previous.phase === "failed"
        ? synthesizeMissingStepReport(
            fallbackRunId,
            "failed",
            UNSTARTED_STEP_REPORT_SUMMARY,
          )
        : synthesizeMissingStepReport(
            fallbackRunId,
            statusByStepIndex.get(previous.stepIndex) ?? "completed",
          ));
    return {
      stepIndex: previous.stepIndex,
      role: previous.role,
      subtask: previous.subtask,
      report,
    };
  };

  const spawn: WaveSpawnRequest[] = [];
  for (const step of steps) {
    if (step.phase !== "pending") continue;
    if (inFlight.has(step.stepIndex)) continue;

    const earlier = steps.filter(
      (candidate) => candidate.stepIndex < step.stepIndex,
    );
    if (step.access === "all" && !earlier.every(isStepTerminal)) continue;

    const previousReports: CompletedWaveStepReport[] =
      step.access === "all" ? earlier.map(reportForEarlierStep) : [];

    spawn.push({
      stepIndex: step.stepIndex,
      step: stepToWaveStep(step),
      previousReports,
      totalSteps: steps.length,
    });
  }

  const complete = steps.every(isStepTerminal);

  return {
    wave: changed ? { ...wave, steps } : wave,
    changed,
    spawn,
    complete,
  };
}
