/**
 * Runtime helpers for the `wave` command group: reading the wave engine's
 * state into the wire shape, finding a wave by id, and the mutations the
 * conductor's tooling needs — cancel, steer, amend a pending step, skip one.
 *
 * Loaded dynamically from the command modules so the descriptors stay
 * import-pure (the engine store pulls in Tauri-backed documents).
 */

import { useAccountQuotaWaitStore } from "@/features/chat/lib/accountQuotaWait";
import { sessionPulse } from "@/features/chat/lib/sessionPulse";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { isWorkingStatus } from "@/features/conductor/brigadeActivity";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { ConductorRoadmap } from "@/features/conductor/flockRoadmap";
import {
  DEFAULT_WAVE_PARALLEL,
  parseFlockWave,
  parseWavePlanBody,
  WAVE_FENCE_TAG,
  type FlockWaveParse,
  type WaveStep,
} from "@/features/conductor/flockWave";
import { stopOrchestratorSession } from "@/features/conductor/orchestratorControls";
import {
  admitWavePlan,
  waveStepNode,
  withAmendedPendingStep,
  withRestartedStep,
  withWaveStepPhase,
  type WaveState,
  type WaveStepState,
} from "@/features/conductor/waveEngine";
import {
  waveStepAmendedNoticeText,
  waveStepRestartedNoticeText,
  waveStepSkippedNoticeText,
  type WaveCommandCaller,
} from "@/features/conductor/waveNotices";
import { runWaveEngineTick } from "@/features/conductor/waveRunner";
import {
  checkExplicitWaveStepModel,
  checkWaveStepRunSettings,
} from "@/features/conductor/waveStepTarget";
import { stopWaveByOperator } from "@/features/conductor/waveStop";
import {
  getWaveEngineState,
  updateWaveEngineState,
  withWave,
} from "@/features/conductor/waveStore";
import { isWaveLive } from "@/features/conductor/waveVerdict";
import { resetPersonaHandoff } from "@/shared/api/acpPersonaHandoff";
import {
  protocolBlocks,
  unreadProtocolBlockPlace,
  unreadProtocolBlocks,
} from "@/shared/lib/protocolFences";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { truncate } from "../helpers";
import { CommandError, type CommandContext } from "../types";
import {
  resolveFlockctlCaller,
  TOKEN_NOT_THIS_APPS,
  TOKEN_WHERE,
} from "./spawnGate";

export const WAVE_SUMMARY_LIMIT = 500;
export const WAVE_DETAIL_LIMIT = 4_000;

export interface WaveStepWire {
  step: number;
  role: string;
  label: string | null;
  access: "none" | "all";
  phase: WaveStepState["phase"];
  session_id: string | null;
  run_id: string | null;
  status: string | null;
  stop_reason: string | null;
  failure_reason: string | null;
  dispatch_note: string | null;
  resumed_from_session_id: string | null;
  report: { status: string; summary: string } | null;
  /**
   * How alive the step's executor is, while its run is not over: null
   * for a step with no session and for one that finished.
   */
  activity: WaveStepActivityWire | null;
  subtask: string | null;
}

/**
 * What the app last heard from a step's executor. A conductor used to
 * see `running` for a step that worked and for one whose provider had
 * gone silent an hour ago alike, and could only wait for a notice.
 */
export interface WaveStepActivityWire {
  /** When the executor last sent anything: text, a thought, a tool call. */
  last_event_at: string | null;
  /** Whole seconds since then; null when nothing was heard this run. */
  quiet_seconds: number | null;
  /** Tool calls it started and has not heard the end of. */
  tools_running: number;
  /** Tokens the session has used so far, when the provider reports them. */
  tokens_used: number | null;
  /** Set while the session's message waits for its provider. */
  provider_wait: {
    reason: "allowance_spent" | "rate_limited";
    until: string | null;
  } | null;
}

function isoTime(at: number | null | undefined): string | null {
  return typeof at === "number" && Number.isFinite(at) && at > 0
    ? new Date(at).toISOString()
    : null;
}

/** The activity of one live executor session, as of `now`. */
export function waveStepActivity(
  sessionId: string,
  now = Date.now(),
): WaveStepActivityWire {
  const pulse = sessionPulse(sessionId);
  const tokens =
    useChatStore.getState().sessionStateById[sessionId]?.tokenState;
  const used = tokens?.accumulatedTotal || tokens?.totalTokens;
  const wait = useAccountQuotaWaitStore.getState().waits[sessionId];
  return {
    last_event_at: isoTime(pulse?.lastEventAt),
    quiet_seconds: pulse
      ? Math.max(0, Math.floor((now - pulse.lastEventAt) / 1000))
      : null,
    tools_running: pulse?.toolsInFlight ?? 0,
    tokens_used: typeof used === "number" && used > 0 ? used : null,
    provider_wait: wait
      ? {
          reason:
            wait.reason === "rate_limit" ? "rate_limited" : "allowance_spent",
          until: isoTime(
            wait.reason === "rate_limit" ? wait.retryAt : wait.resetAt,
          ),
        }
      : null,
  };
}

export interface WaveWire {
  wave_id: string;
  conductor_session_id: string;
  phase: WaveState["phase"];
  live: boolean;
  created_at: string;
  revision: number;
  root_request_id: string;
  queued_position: number | null;
  closure: {
    reason: string;
    note: string | null;
    detail: string | null;
  } | null;
  steps: WaveStepWire[];
}

export function waveNotFoundMessage(waveId: string): string {
  return `No wave "${waveId}"; list waves with \`flockctl wave list\`.`;
}

/** Finds a wave by its full id or by an unambiguous prefix of it. */
export function requireWave(waveId: string): WaveState {
  const needle = waveId.trim().toLowerCase();
  const waves = getWaveEngineState().waves;
  const exact = waves.find((wave) => wave.waveId.toLowerCase() === needle);
  if (exact) return exact;
  const prefixed =
    needle.length >= 4
      ? waves.filter((wave) => wave.waveId.toLowerCase().startsWith(needle))
      : [];
  if (prefixed.length === 1) return prefixed[0];
  throw new CommandError(
    "wave_not_found",
    prefixed.length > 1
      ? `"${waveId}" matches ${prefixed.length} waves; give more of the id.`
      : waveNotFoundMessage(waveId),
  );
}

/** A command that changes a wave, as its refusal names it. */
export type WaveChangeVerb = "cancel" | "steer" | "amend" | "skip" | "restart";

/**
 * Finds the wave a changing command names, and refuses a session that does
 * not conduct it.
 *
 * Until 2026-11-24 these commands read no caller at all. A worker could add
 * to the brief of the step that checks its own work, skip that step, or have
 * a sibling's step run again in a new session, each with one command, and
 * what the app wrote down said only that "an agent" had asked. A wave is its
 * conductor's to change: an agent's call has to prove it comes from that
 * chat, with the token `session create` takes. The operator's own terminal
 * and the app itself carry no agent mark and are read as before.
 *
 * A guardrail, like the spawn gate it borrows the proof from: it stops a
 * confused or prompt-injected executor, not a process that sets out to pass
 * as the conductor.
 */
export async function requireWaveForChange(
  waveId: string,
  verb: WaveChangeVerb,
  ctx: Pick<CommandContext, "actor" | "fromAgent">,
  sessionToken: string | undefined,
): Promise<WaveState> {
  const named = requireWave(waveId);
  const caller = await resolveFlockctlCaller({
    actor: ctx.actor,
    fromAgent: ctx.fromAgent,
    sessionToken,
  });
  if (caller.kind === "bad-token") {
    throw new CommandError("wave_not_allowed", TOKEN_NOT_THIS_APPS);
  }
  if (caller.kind === "unproven") {
    // The caller may be the conductor with its context compacted away: its
    // next message carries the context, and so the token, again.
    resetPersonaHandoff(named.conductorSessionId);
    throw new CommandError(
      "wave_not_allowed",
      `This call comes from an agent's shell and does not prove which session makes it, so \`wave ${verb}\` is refused: only the chat that conducts wave "${named.waveId}" can change it. ${TOKEN_WHERE} If you conduct this wave and no longer have the token, the app sends that context again with the next message your chat receives. Any session may still read waves with \`flockctl wave list\` and \`flockctl wave get\`.`,
    );
  }
  if (
    caller.kind === "session" &&
    caller.sessionId !== named.conductorSessionId
  ) {
    throw new CommandError(
      "wave_not_allowed",
      `Wave "${named.waveId}" is conducted by session "${named.conductorSessionId}", not by session "${caller.sessionId}" that this call is made for, so \`wave ${verb}\` is refused: only the chat that conducts a wave can change it. Any session may still read waves with \`flockctl wave list\` and \`flockctl wave get\`.`,
    );
  }
  // The proof is checked across an await: read the wave again, as it is now.
  return requireWave(named.waveId);
}

function queuedPosition(wave: WaveState): number | null {
  if (wave.phase !== "queued") return null;
  const queue = getWaveEngineState()
    .waves.filter(
      (candidate) =>
        candidate.conductorSessionId === wave.conductorSessionId &&
        candidate.phase === "queued",
    )
    .sort((left, right) => left.createdAt - right.createdAt);
  return queue.findIndex((candidate) => candidate.waveId === wave.waveId) + 1;
}

export function waveToWire(
  wave: WaveState,
  detail: "summary" | "full",
): WaveWire {
  const graph = useConductorGraphStore.getState();
  const nodes = Object.values(graph.nodesById);
  const limit = detail === "full" ? WAVE_DETAIL_LIMIT : WAVE_SUMMARY_LIMIT;
  return {
    wave_id: wave.waveId,
    conductor_session_id: wave.conductorSessionId,
    phase: wave.phase,
    live: isWaveLive(wave),
    created_at: new Date(wave.createdAt).toISOString(),
    revision: wave.revisionCount,
    root_request_id: wave.rootRequestId,
    queued_position: queuedPosition(wave),
    closure: wave.closure
      ? {
          reason: wave.closure.reason,
          note: wave.closure.note ?? null,
          detail: wave.closure.detail ?? null,
        }
      : null,
    steps: [...wave.steps]
      .sort((left, right) => left.stepIndex - right.stepIndex)
      .map((step) => {
        const node = waveStepNode(wave, step.stepIndex, nodes);
        const report = step.runId ? graph.getReport(step.runId) : undefined;
        return {
          step: step.stepIndex + 1,
          role: step.role,
          label: step.label ?? null,
          access: step.access === "all" ? "all" : "none",
          phase: step.phase,
          session_id: step.sessionId ?? node?.sessionId ?? null,
          run_id: step.runId ?? node?.runId ?? null,
          status: node?.status ?? null,
          stop_reason: node?.stopReason ?? null,
          failure_reason: step.failureReason ?? null,
          dispatch_note: step.dispatchNote ?? null,
          resumed_from_session_id: step.resumedFromSessionId ?? null,
          report: report
            ? {
                status: report.status,
                summary: truncate(report.summary, limit),
              }
            : null,
          activity:
            node && isWorkingStatus(node.status)
              ? waveStepActivity(node.sessionId)
              : null,
          subtask: detail === "full" ? truncate(step.subtask, limit) : null,
        };
      }),
  };
}

export function roadmapToWire(roadmap: ConductorRoadmap) {
  return {
    conductor_session_id: roadmap.conductorSessionId,
    goal: roadmap.goal,
    status: roadmap.status,
    note: roadmap.note ?? null,
    updated_at: new Date(roadmap.updatedAt).toISOString(),
    continue_turns: roadmap.continueTurns,
    continue_turn_in_flight: roadmap.continueTurn
      ? {
          attempt: roadmap.continueTurn.attempt,
          phase: roadmap.continueTurn.phase,
        }
      : null,
    stages: roadmap.stages.map((stage, index) => ({
      stage: index + 1,
      title: stage.title,
      status: stage.status,
      evidence: stage.evidence,
    })),
  };
}

function postConductorNotice(sessionId: string, text: string): void {
  useChatStore
    .getState()
    .addMessage(sessionId, createSystemNotificationMessage(text, "warning"));
}

/**
 * Who ran a wave command. A call from an agent's shell carries the app's
 * agent-shell mark, or a harness's own actor; one with neither is the
 * operator's terminal. What the command leaves in the wave and in the
 * conductor's chat names the caller it had, so a step an agent skipped
 * or a wave it cancelled is never recorded as the operator's order.
 */
export function waveCommandCaller(
  ctx: Pick<CommandContext, "actor" | "fromAgent"> | undefined,
): WaveCommandCaller {
  return ctx?.fromAgent || ctx?.actor ? "agent" : "operator";
}

/** Cancels a wave: a live one is stopped, a queued one is dropped. */
export function cancelWave(
  wave: WaveState,
  by: WaveCommandCaller = "operator",
): "stopped" | "dropped" | "already_closed" {
  const outcome = wave.phase === "queued" ? "dropped" : "stopped";
  if (!isWaveLive(wave) && wave.phase !== "queued") return "already_closed";
  const done = stopWaveByOperator(wave.conductorSessionId, wave.waveId, by);
  if (!done) return "already_closed";
  runWaveEngineTick();
  return outcome;
}

/** Appends text to a pending step's brief; refuses a step already dispatched. */
export function amendWaveStep(
  wave: WaveState,
  step: number,
  text: string,
): void {
  const target = requirePendingStep(wave, step);
  updateWaveEngineState((state) => {
    const current = state.waves.find((row) => row.waveId === wave.waveId);
    if (!current) return state;
    return withWave(
      state,
      withAmendedPendingStep(current, target.stepIndex, text),
    );
  });
  postConductorNotice(
    wave.conductorSessionId,
    waveStepAmendedNoticeText(target.stepIndex),
  );
}

/** Marks a pending step as skipped so its dependents proceed without it. */
export function skipWaveStep(
  wave: WaveState,
  step: number,
  by: WaveCommandCaller = "operator",
): void {
  const target = requirePendingStep(wave, step);
  updateWaveEngineState((state) => {
    const current = state.waves.find((row) => row.waveId === wave.waveId);
    if (!current) return state;
    return withWave(
      state,
      withWaveStepPhase(current, target.stepIndex, {
        phase: "failed",
        failureReason:
          by === "agent"
            ? "Skipped at an agent's request through flockctl."
            : "Skipped on the operator's order through flockctl.",
      }),
    );
  });
  postConductorNotice(
    wave.conductorSessionId,
    waveStepSkippedNoticeText(target.stepIndex, by),
  );
  runWaveEngineTick();
}

/**
 * Checks a plan as admission would, and runs nothing: the parse, then each
 * step's model and run settings against what this installation offers now.
 * `text` is the JSON of a plan block or a whole message carrying one.
 */
export function validateWavePlan(text: string, conductorSessionId?: string) {
  const body = text.trim();
  const bare = parseWavePlanBody(body);
  // A whole message is read by the reader the engine reads it with, so a
  // block the engine would not run is not validated as one it would.
  const blocks = protocolBlocks(text, WAVE_FENCE_TAG);
  const unread =
    blocks.length === 0 && bare.kind !== "plan"
      ? unreadProtocolBlocks(text, WAVE_FENCE_TAG)[0]
      : undefined;
  if (unread) {
    return {
      ok: false as const,
      reason: "not-top-level",
      detail: `The ${WAVE_FENCE_TAG} block in this text is ${unreadProtocolBlockPlace(unread.reason)}, so the app would not run it. A plan runs only from a ${WAVE_FENCE_TAG} block that stands at the top level of the reply.`,
      step: null,
    };
  }
  const parse: FlockWaveParse =
    blocks.length > 0
      ? parseFlockWave(text)
      : bare.kind === "plan"
        ? { ...bare, planText: body, prose: "" }
        : bare;
  if (parse.kind === "none") {
    return {
      ok: false as const,
      reason: "steps-empty",
      detail: "There is no wave plan in this text to check.",
      step: null,
    };
  }
  const admission = admitWavePlan(parse, {
    checkStepModel: checkExplicitWaveStepModel,
    ...(conductorSessionId
      ? {
          checkStepRunSettings: (step: WaveStep) =>
            checkWaveStepRunSettings(step, conductorSessionId),
        }
      : {}),
  });
  if (admission.kind === "rejected") {
    return {
      ok: false as const,
      reason: admission.reason,
      detail: admission.detail,
      step: admission.stepIndex === undefined ? null : admission.stepIndex + 1,
    };
  }
  return {
    ok: true as const,
    executors: admission.steps.length,
    parallel: admission.parallel ?? DEFAULT_WAVE_PARALLEL,
    steps: admission.steps.map((step, index) => ({
      step: index + 1,
      role: step.role,
      label: step.label ?? null,
      access: step.access === "all" ? "all" : "none",
      model: step.model ?? null,
    })),
  };
}

/** Why a session a restart replaced was stopped, as its chip says it. */
const STEP_RESTART_STOP_REASON: Record<WaveCommandCaller, string> = {
  operator:
    "Stopped by the operator through flockctl: its step is being run again.",
  agent:
    "Stopped at an agent's request through flockctl: its step is being run again.",
};

/**
 * Runs a dispatched step again in a new session: stops the one at work on
 * it, sends the step back to pending with the correction, and lets the
 * engine dispatch it. Returns the session that was replaced, when the
 * step had one.
 */
export async function restartWaveStep(
  wave: WaveState,
  step: number,
  text?: string,
  by: WaveCommandCaller = "operator",
): Promise<string | null> {
  const target = wave.steps.find((row) => row.stepIndex === step - 1);
  if (!target) {
    throw new CommandError(
      "invalid_args",
      `Wave "${wave.waveId}" has ${wave.steps.length} steps; there is no step ${step}.`,
    );
  }
  if (wave.phase !== "running") {
    throw new CommandError(
      "wave_not_running",
      `Wave "${wave.waveId}" is ${wave.phase}: its steps are no longer being run, so none can be run again. Plan a new wave for the work.`,
    );
  }
  if (target.phase !== "spawned" && target.phase !== "failed") {
    throw new CommandError(
      "wave_step_not_dispatched",
      `Step ${step} of wave "${wave.waveId}" is ${target.phase}; only a step that was dispatched can be run again. Use \`wave amend\` to change one that has not started.`,
    );
  }
  const nodes = Object.values(useConductorGraphStore.getState().nodesById);
  const node = waveStepNode(wave, target.stepIndex, nodes);
  const replaced = node?.sessionId ?? target.sessionId ?? null;
  if (
    node &&
    (node.status === "running" ||
      node.status === "starting" ||
      node.status === "waiting")
  ) {
    await stopOrchestratorSession(node.sessionId, STEP_RESTART_STOP_REASON[by]);
  }
  updateWaveEngineState((state) => {
    const current = state.waves.find((row) => row.waveId === wave.waveId);
    if (!current) return state;
    // The step's record of the session it is taken from is what keeps
    // the engine from reading that session as its executor again.
    const withSession =
      replaced && target.sessionId !== replaced
        ? withWaveStepPhase(current, target.stepIndex, {
            phase: "spawned",
            sessionId: replaced,
          })
        : current;
    return withWave(
      state,
      withRestartedStep(withSession, target.stepIndex, text),
    );
  });
  postConductorNotice(
    wave.conductorSessionId,
    waveStepRestartedNoticeText(target.stepIndex, Boolean(text?.trim()), by),
  );
  runWaveEngineTick();
  return replaced;
}

function requirePendingStep(wave: WaveState, step: number): WaveStepState {
  const target = wave.steps.find((row) => row.stepIndex === step - 1);
  if (!target) {
    throw new CommandError(
      "invalid_args",
      `Wave "${wave.waveId}" has ${wave.steps.length} steps; there is no step ${step}.`,
    );
  }
  if (
    target.phase !== "pending" ||
    (!isWaveLive(wave) && wave.phase !== "queued")
  ) {
    throw new CommandError(
      "wave_step_not_pending",
      `Step ${step} of wave "${wave.waveId}" is ${target.phase}; only a step that has not been dispatched can be changed.`,
    );
  }
  return target;
}

/** The sessions of a wave's steps that are still running, for steering. */
export function runningWaveSessionIds(wave: WaveState): string[] {
  const graph = useConductorGraphStore.getState();
  const nodes = Object.values(graph.nodesById);
  return wave.steps.flatMap((step) => {
    const node = waveStepNode(wave, step.stepIndex, nodes);
    if (!node) return [];
    return node.status === "running" ||
      node.status === "starting" ||
      node.status === "waiting"
      ? [node.sessionId]
      : [];
  });
}
