/**
 * The operator's stop for a running wave (5b).
 *
 * The loop had exactly one hand on the wheel while a wave ran: the operator
 * could stop individual children chip by chip, but nothing stopped *the wave*
 * — its scheduler kept the remaining steps coming, and the only exits were
 * waiting it out or hoping a spawn failed. This module is the missing lever,
 * and it exists next to the degraded-report warning on purpose: "a step just
 * went terminal on a stub" is precisely the moment an operator may decide the
 * rest of the wave is wasted effort.
 *
 * Semantics follow the discipline of the rest of the loop:
 * - **Phase first.** The wave is parked on `needsOperator` before any child
 *   is told anything, so a crash mid-stop resumes into a wave the scheduler
 *   will never advance again — never into a half-stopped one that respawns.
 * - **No digest, no verdict.** Nothing is sent to the conductor to judge; the
 *   operator chose to cut the loop, and a model call spent grading work that
 *   was deliberately abandoned would be pure waste (the same reasoning as the
 *   interrupted-wave refusal).
 * - **Late spawns are covered elsewhere.** A spawn still in flight when the
 *   stop lands resolves into a wave that is no longer `running`, and the
 *   runner's adoption guard stops that session instead of adopting it.
 * - **Any live wave.** It used to be `running` only, on the reasoning that
 *   past `running` there is nothing left to stop. There is: the wave itself.
 *   A wave waiting on a digest or a verdict holds the conductor's only wave
 *   slot, so every later plan it makes is refused as concurrent — and if the
 *   answer never comes, that is permanent. The operator's lever has to reach
 *   the states where the loop can actually get stuck, not only the one where
 *   there are workers to interrupt. The parked wave is cleaned up by the same
 *   rule as every other `needsOperator` wave: the conductor's next admitted
 *   plan sweeps it.
 */

import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { stopOrchestratorSession } from "./orchestratorControls";
import {
  isTerminalRunStatus,
  withWavePhase,
  type WaveState,
} from "./waveEngine";
import { waveClosureNoticeText } from "./waveNotices";
import { isWaveLive } from "./waveVerdict";
import { updateWaveEngineState, withWave } from "./waveStore";
import { recordWaveClose } from "./waveTelemetryStore";

/**
 * Tells every spawned child of a wave to stop.
 *
 * The stop half of 5b, shared with the runner's blocked-step stop: whoever
 * decides a wave is over, its children are told the same way. Fire-and-forget
 * per child on purpose — one child that fails to stop must not keep the
 * others running — and callers park the wave *before* calling this, so a
 * crash mid-stop resumes into a wave the scheduler never advances again.
 */
export function stopWaveChildSessions(wave: WaveState): void {
  const graph = useConductorGraphStore.getState();
  for (const step of wave.steps) {
    if (!step.sessionId) continue;
    // A child that already finished has nothing to stop, and stopping it is
    // not harmless: the stop marks the node `cancelled`, which turns a
    // completed step into a cancelled one in the digest the stalled wave is
    // about to build — and re-derives a reportless child's report as
    // "cancelled" before that digest is read.
    const node = graph.getNode(step.sessionId);
    if (node && isTerminalRunStatus(node.status)) continue;
    void stopOrchestratorSession(step.sessionId);
  }
}

/**
 * Stops a running wave on the operator's order.
 *
 * Returns `true` when the wave was stopped, `false` when there was nothing to
 * stop — the wave is gone, belongs to another conductor, or has already left
 * the live phases. The false case is deliberate silence: the operator may be
 * pressing a button rendered for a state that has since moved on, and the
 * honest response to that is "nothing happened", not a second notice.
 */
export function stopWaveByOperator(sessionId: string, waveId: string): boolean {
  let parked: WaveState | undefined;
  updateWaveEngineState((state) => {
    const wave = state.waves.find((candidate) => candidate.waveId === waveId);
    if (!wave || wave.conductorSessionId !== sessionId) return state;
    if (!isWaveLive(wave)) return state;
    parked = withWavePhase(wave, "needsOperator");
    return withWave(state, parked);
  });
  if (!parked) return false;
  recordWaveClose(parked, "needs-operator", "operator-stopped");

  stopWaveChildSessions(parked);
  useChatStore
    .getState()
    .addMessage(
      sessionId,
      createSystemNotificationMessage(
        waveClosureNoticeText({ reason: "operator-stopped" }),
        "warning",
      ),
    );
  return true;
}
