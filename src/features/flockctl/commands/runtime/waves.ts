/**
 * Runtime helpers for the `wave` command group: reading the wave engine's
 * state into the wire shape, finding a wave by id, and the mutations the
 * conductor's tooling needs — cancel, steer, amend a pending step, skip one.
 *
 * Loaded dynamically from the command modules so the descriptors stay
 * import-pure (the engine store pulls in Tauri-backed documents).
 */

import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { ConductorRoadmap } from "@/features/conductor/flockRoadmap";
import {
  waveStepNode,
  withAmendedPendingStep,
  withWaveStepPhase,
  type WaveState,
  type WaveStepState,
} from "@/features/conductor/waveEngine";
import {
  waveStepAmendedNoticeText,
  waveStepSkippedNoticeText,
} from "@/features/conductor/waveNotices";
import { runWaveEngineTick } from "@/features/conductor/waveRunner";
import { stopWaveByOperator } from "@/features/conductor/waveStop";
import {
  getWaveEngineState,
  updateWaveEngineState,
  withWave,
} from "@/features/conductor/waveStore";
import { isWaveLive } from "@/features/conductor/waveVerdict";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { truncate } from "../helpers";
import { CommandError } from "../types";

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
  subtask: string | null;
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

/** Cancels a wave: a live one is stopped, a queued one is dropped. */
export function cancelWave(
  wave: WaveState,
): "stopped" | "dropped" | "already_closed" {
  const outcome = wave.phase === "queued" ? "dropped" : "stopped";
  if (!isWaveLive(wave) && wave.phase !== "queued") return "already_closed";
  const done = stopWaveByOperator(wave.conductorSessionId, wave.waveId);
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
export function skipWaveStep(wave: WaveState, step: number): void {
  const target = requirePendingStep(wave, step);
  updateWaveEngineState((state) => {
    const current = state.waves.find((row) => row.waveId === wave.waveId);
    if (!current) return state;
    return withWave(
      state,
      withWaveStepPhase(current, target.stepIndex, {
        phase: "failed",
        failureReason: "Skipped on the operator's order through flockctl.",
      }),
    );
  });
  postConductorNotice(
    wave.conductorSessionId,
    waveStepSkippedNoticeText(target.stepIndex),
  );
  runWaveEngineTick();
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
