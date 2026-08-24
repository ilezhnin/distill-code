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
import { roleStage } from "./roleLayers";
import type { RunStatus, SessionNode, StructuredReport } from "./types";
import type { CompletedWaveStepReport } from "./wavePrompts";

/**
 * Every lifecycle a single step inside a persisted wave can be in.
 *
 * This array is the single source of truth: the type is derived from it, and
 * `waveStore.ts`'s persistence guard reads it rather than hand-writing a second
 * copy of the same list. A hand-written second copy is exactly how a `"failed"`
 * step came to be unreadable on reload, which deleted the whole wave.
 */
export const WAVE_STEP_PHASES = [
  /** Not started. Waiting on its `access` precondition, or just created. */
  "pending",
  /** A spawn was started for this step; the child node is not visible yet. */
  "spawning",
  /** A graph node exists for this step; the graph owns its status from here. */
  "spawned",
  /**
   * The spawn itself threw and no child exists. Terminal: there is no
   * auto-retry (Q2), and later steps must not wait on it forever.
   */
  "failed",
] as const;

/** Lifecycle of a single step inside a persisted wave. */
export type WaveStepPhase = (typeof WAVE_STEP_PHASES)[number];

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
  /**
   * True once this completed-but-reportless step was allowed to go terminal
   * on the synthesized "result unknown" stub after the runner's grace expired
   * (risk №4's escape hatch, made visible — 5b). Persisted so the operator is
   * told exactly once, restarts included.
   */
  reportDegraded?: boolean;
}

/**
 * Where a wave sits in the closed loop (D4).
 *
 * `running` is the only phase that spawns anything. Everything after it is the
 * digest/verdict cycle: the wave's reports are collected, delivered to the
 * conductor as a real user message, and the conductor's next settled answer is
 * read as a verdict.
 *
 * `accepted` and `needsOperator` are terminal. `revising` is not a phase of the
 * *old* wave — a revision is a new wave — so it never appears here; the old
 * wave lands on `accepted` semantics only through its own verdict, and a
 * revised wave closes as `revised`.
 *
 * Like {@link WAVE_STEP_PHASES}, the array is the source of truth the
 * persistence guard reads, so a phase added here cannot go missing there.
 */
export const WAVE_PHASES = [
  /** Steps are still being scheduled, spawned or executed. */
  "running",
  /** Every step is terminal; the digest has not been built yet. */
  "digestPending",
  /** The digest is being delivered to the conductor. */
  "dispatchingDigest",
  /** The digest landed; the conductor's next settled answer is the verdict. */
  "awaitingVerdict",
  /** The conductor accepted the result. Terminal. */
  "accepted",
  /** The conductor asked for another wave, which now exists. Terminal here. */
  "revised",
  /** The loop stopped and the operator has to look at it. Terminal. */
  "needsOperator",
] as const;

export type WavePhase = (typeof WAVE_PHASES)[number];

/**
 * Why the conductor's last answer to this wave's digest was not a verdict.
 *
 * Persisted on the wave so the operator's manual retry (Q5) can re-ask in
 * terms the model can act on — "you sent no fence" and "your fence did not
 * parse" are different mistakes and need different corrections.
 */
export interface WaveVerdictIssue {
  /** `missing` — no verdict fence at all. `invalid` — a fence that failed. */
  reason: "missing" | "invalid";
  /** The parser's explanation, when there was one. */
  detail?: string;
}

export interface WaveState {
  waveId: string;
  /** Conductor session that authored the plan; the children's parent. */
  conductorSessionId: string;
  /** Assistant message that carried the `distill-wave` fence. */
  planMessageId: string;
  createdAt: number;
  steps: WaveStepState[];
  /** Position in the closed loop. Waves persisted before 3a resume `running`. */
  phase: WavePhase;
  /**
   * Identity of the *root operator request* this wave serves. The first wave
   * of a request uses its own `planMessageId`; every revision wave inherits it
   * unchanged. This is what makes the revision cap "per root request" (D4)
   * rather than "per wave".
   */
  rootRequestId: string;
  /**
   * How many revision waves the root request has already spent. `0` on the
   * first wave; a revision spawned from this wave carries `revisionCount + 1`.
   */
  revisionCount: number;
  /**
   * Which digest delivery attempt this wave is on. Bumped only by the operator
   * pressing the manual retry (Q5); it is part of the digest's marker, so the
   * verdict scan always anchors on the newest digest.
   */
  digestAttempt: number;
  /**
   * Reports of the previous wave of this root request, handed to this wave's
   * `access: "all"` steps ahead of its own earlier steps (handoff §6/Q4).
   * Empty on a first wave.
   */
  carriedReports?: CompletedWaveStepReport[];
  /**
   * What went wrong with the last answer to this wave's digest. Set only while
   * the wave is parked on `needsOperator` for an unreadable verdict; the next
   * digest quotes it so the retry is not the same question twice.
   */
  verdictIssue?: WaveVerdictIssue;
  /**
   * App-measured count of files with uncommitted changes in the conductor's
   * working folder when this wave was admitted (E3a, `waveGitProbe.ts`).
   * Absent while the probe is in flight, when it failed, or when the folder
   * is not a git repository.
   */
  gitDirtyAtAdmission?: number;
  /** The same count, taken when the wave finished and before its digest. */
  gitDirtyAtDigest?: number;
  /**
   * True once the digest-time probe has settled — with or without a number.
   * The digest pass waits on this so the one non-model-authored fact makes it
   * into the digest; a failed probe still sets it, so evidence can be missing
   * but can never block the loop.
   */
  gitDigestProbed?: boolean;
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
  | "step-model-unsupported"
  /**
   * The plan builds something inspectable but never inspects it (E1). The
   * protocol prompt has asked for a closing verification step since `81b29ef`;
   * this is the floor under that instruction, so "the conductor forgot" is a
   * refused plan the operator can see rather than an accept nobody checked.
   */
  | "verification-step-missing";

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

/**
 * Role stages that make a wave *checkable*.
 *
 * `prod` is the stage of the roles that build the thing — integrator, brigade,
 * unity-worker, unity-asset-integrator, artist, audio, writer. When one of them
 * is in the plan there is an artifact to look at afterwards, and looking at it
 * is the only external signal this loop ever gets.
 *
 * Deliberately narrow. `pre` work (research, design, scouting) and `post` work
 * (marketing, playtesting) have nothing to inspect, and `release` roles
 * (pr-submitter, localizer, devops) act on an artifact someone else already
 * built and verified — widening the trigger to them would refuse plans that are
 * genuinely uncheckable, and a false refusal costs the operator a replan on
 * work that never needed a verifier.
 */
export const VERIFICATION_TRIGGER_STAGES: readonly string[] = ["prod"];

/** Stage a wave's closing verification step must carry. */
export const VERIFICATION_STAGE = "verify";

interface WaveStepShape {
  role: string;
  access: WaveStepAccess;
}

/**
 * True when a plan produces something that can be checked by looking at it,
 * and is therefore required to end by looking at it.
 *
 * A one-step wave is exempt: the single worker is the work, there is no
 * handoff to lose, and demanding a second session to check one step doubles
 * the cost of the cheapest useful wave.
 */
export function waveRequiresVerification(
  steps: readonly WaveStepShape[],
): boolean {
  if (steps.length < 2) return false;
  return steps.some((step) =>
    VERIFICATION_TRIGGER_STAGES.includes(roleStage(step.role) ?? ""),
  );
}

/**
 * The plan's closing verification step, or `null` when it does not have one.
 *
 * Both halves are load-bearing: a `verify`-stage role because that is what the
 * catalog says inspects work, and `access: "all"` because a verifier that
 * cannot see the earlier steps' reports cannot know what it is verifying.
 */
export function waveVerificationStep<Step extends WaveStepShape>(
  steps: readonly Step[],
): Step | null {
  const last = steps.at(-1);
  if (!last) return null;
  if (roleStage(last.role) !== VERIFICATION_STAGE) return null;
  if (last.access !== "all") return null;
  return last;
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

  if (
    waveRequiresVerification(parse.steps) &&
    !waveVerificationStep(parse.steps)
  ) {
    return rejected(
      "verification-step-missing",
      `This wave builds something that can be inspected, so its last step must inspect it: role "acceptor" (or "adversary") with "access":"all", and a subtask that checks the artifact itself rather than re-reading the other steps' reports. Re-send the plan with that step, or — if there is genuinely nothing to inspect — without the step that builds one.`,
      parse.steps.length - 1,
    );
  }

  return { kind: "accepted", steps: parse.steps };
}

/**
 * Builds the initial persisted state for an admitted plan.
 *
 * A first wave omits `rootRequestId`/`revisionCount`/`carriedReports` and gets
 * the defaults; a revision wave passes the previous wave's root identity, its
 * revision count plus one, and the reports the revision must see.
 */
export function createWaveState(args: {
  waveId: string;
  conductorSessionId: string;
  planMessageId: string;
  steps: readonly WaveStep[];
  createdAt: number;
  rootRequestId?: string;
  revisionCount?: number;
  carriedReports?: readonly CompletedWaveStepReport[];
}): WaveState {
  return {
    waveId: args.waveId,
    conductorSessionId: args.conductorSessionId,
    planMessageId: args.planMessageId,
    createdAt: args.createdAt,
    phase: "running",
    rootRequestId: args.rootRequestId ?? args.planMessageId,
    revisionCount: args.revisionCount ?? 0,
    digestAttempt: 0,
    ...(args.carriedReports?.length
      ? { carriedReports: [...args.carriedReports] }
      : {}),
    steps: args.steps.map((step, stepIndex) => ({
      stepIndex,
      role: step.role,
      subtask: step.subtask,
      access: step.access,
      phase: "pending" as const,
    })),
  };
}

/** Returns a wave with a new lifecycle phase, or the same object if unchanged. */
export function withWavePhase(wave: WaveState, phase: WavePhase): WaveState {
  return wave.phase === phase ? wave : { ...wave, phase };
}

/**
 * Returns a wave carrying the Q5 retry note, or with it removed.
 *
 * Removal matters as much as the note: a wave whose verdict was finally read
 * must not keep quoting an older failure at the conductor on a later retry.
 */
export function withVerdictIssue(
  wave: WaveState,
  issue: WaveVerdictIssue | undefined,
): WaveState {
  if (issue) {
    if (
      wave.verdictIssue?.reason === issue.reason &&
      wave.verdictIssue?.detail === issue.detail
    ) {
      return wave;
    }
    return { ...wave, verdictIssue: issue };
  }
  if (!wave.verdictIssue) return wave;
  const { verdictIssue: _cleared, ...rest } = wave;
  return rest;
}

/**
 * True when at least one step of the wave produced a real report.
 *
 * The wave engine treats any terminal step as "over", which is right while the
 * app runs: a step that stopped is not coming back. Across a restart it is
 * only half the story — the startup reconcile demotes every child whose
 * runtime died with the process, so a wave interrupted mid-flight looks
 * exactly like a wave that finished, except that not one step ever reported.
 * That difference is the whole signal, and it is this predicate.
 */
export function hasAttestedWaveStepReport(
  wave: WaveState,
  reportOf: (runId: string | null | undefined) => StructuredReport | undefined,
): boolean {
  return wave.steps.some((step) =>
    step.runId ? reportOf(step.runId) !== undefined : false,
  );
}

/**
 * The reports of a finished wave, in step order, as an `access: "all"` handoff.
 *
 * Used for two things: the digest handed to the conductor, and the
 * `carriedReports` a revision wave inherits (Q4 — a revision must see what the
 * previous wave of the same root produced, or "the revision sees what happened"
 * does not mechanically exist).
 */
export function collectWaveStepReports(
  wave: WaveState,
  reportOf: (runId: string | null | undefined) => StructuredReport | undefined,
): CompletedWaveStepReport[] {
  return [...wave.steps]
    .sort((left, right) => left.stepIndex - right.stepIndex)
    .map((step) => {
      const fallbackRunId =
        step.runId ?? `${wave.waveId}:step:${step.stepIndex}`;
      const report =
        (step.runId ? reportOf(step.runId) : undefined) ??
        (step.phase === "failed"
          ? synthesizeMissingStepReport(
              fallbackRunId,
              "failed",
              UNSTARTED_STEP_REPORT_SUMMARY,
            )
          : synthesizeMissingStepReport(fallbackRunId, "completed"));
      return {
        stepIndex: step.stepIndex,
        role: step.role,
        subtask: step.subtask,
        report,
      };
    });
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
  /**
   * Whether a step that completed WITHOUT a report may be treated as terminal
   * now, handing dependents (and the digest) a synthesized "result unknown"
   * stub. A completed run's status routinely lands one tick before its report
   * parse, and the stub used to be handed out in that window — once, with no
   * second chance — so the verdict was rendered on it (risk №4). The runner
   * answers false while a short grace is running and true after it expires;
   * absent means the old immediate behavior.
   */
  allowSyntheticReportFor?: (stepIndex: number) => boolean;
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
  /**
   * Step indexes that were downgraded to the synthetic stub by THIS advance
   * (their `reportDegraded` flag was just set). The shell announces each one
   * to the operator; the persisted flag is what keeps the announcement to
   * exactly once.
   */
  degraded: readonly number[];
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
 * The one exception is `failed`: a spawn that threw after registering its node
 * was already announced to the operator (Q2 — no auto-retry), so the node's
 * existence must not silently resurrect the step to `spawned` on the next
 * tick — that left the wave running forever with a step the operator was told
 * had died.
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
  const reconciled = wave.steps.map((step) => {
    const node = nodeByStepIndex.get(step.stepIndex);
    let next: WaveStepState = step;
    if (node && step.phase !== "failed") {
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
  for (const step of reconciled) {
    const node = nodeByStepIndex.get(step.stepIndex);
    if (node) statusByStepIndex.set(step.stepIndex, node.status);
  }

  // Risk №4's escape hatch, made visible (5b): a completed step whose report
  // never came may go terminal on the synthesized stub once the runner's
  // grace has expired. The downgrade is recorded on the step — exactly once,
  // and as persisted state — so the shell can announce it to the operator
  // without a restart ever producing a second announcement.
  const degraded: number[] = [];
  const steps = reconciled.map((step) => {
    if (step.reportDegraded || step.phase !== "spawned") return step;
    if (statusByStepIndex.get(step.stepIndex) !== "completed") return step;
    if (context.reportOf(step.runId) !== undefined) return step;
    if (context.allowSyntheticReportFor?.(step.stepIndex) !== true) return step;
    degraded.push(step.stepIndex);
    changed = true;
    return { ...step, reportDegraded: true };
  });

  const isStepTerminal = (step: WaveStepState): boolean => {
    if (step.phase === "failed") return true;
    if (step.phase !== "spawned") return false;
    const status = statusByStepIndex.get(step.stepIndex);
    if (status === undefined || !isTerminalRunStatus(status)) return false;
    // Completed but reportless: the report parse usually lands one tick after
    // the status flip. Holding terminality until the runner's grace expires
    // means dependents and the digest get the real report instead of the
    // "result unknown" stub whenever the report is merely late, not missing.
    // A step already marked `reportDegraded` is past all that: its grace was
    // spent and announced, and re-waiting after a restart (whose fresh process
    // has no deadline for it) would only delay the digest a second time.
    if (
      status === "completed" &&
      !step.reportDegraded &&
      context.reportOf(step.runId) === undefined &&
      context.allowSyntheticReportFor !== undefined &&
      !context.allowSyntheticReportFor(step.stepIndex)
    ) {
      return false;
    }
    return true;
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

    // Q4: a revision wave's `"all"` steps see the previous wave of the root
    // ahead of this wave's own earlier steps. Carried reports are already in
    // step order and are marked so the prompt can say which wave they are from.
    const previousReports: CompletedWaveStepReport[] =
      step.access === "all"
        ? [
            ...(wave.carriedReports ?? []).map((entry) => ({
              ...entry,
              fromPreviousWave: true as const,
            })),
            ...earlier.map(reportForEarlierStep),
          ]
        : [];

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
    degraded,
  };
}
