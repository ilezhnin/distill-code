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
 * - **Only `running` waves.** Past `running` there is nothing left to stop —
 *   the workers are done and the digest/verdict cycle is between the app and
 *   the conductor. The parked wave is cleaned up by the same rule as every
 *   other `needsOperator` wave: the conductor's next admitted plan sweeps it.
 */

import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { stopOrchestratorSession } from "./orchestratorControls";
import { withWavePhase, type WaveState } from "./waveEngine";
import { waveClosureNoticeText } from "./waveNotices";
import { updateWaveEngineState, withWave } from "./waveStore";
import { recordWaveClose } from "./waveTelemetryStore";

/**
 * Stops a running wave on the operator's order.
 *
 * Returns `true` when the wave was stopped, `false` when there was nothing to
 * stop — the wave is gone, belongs to another conductor, or has already left
 * `running`. The false case is deliberate silence: the operator may be
 * pressing a button rendered for a state that has since moved on, and the
 * honest response to that is "nothing happened", not a second notice.
 */
export function stopWaveByOperator(sessionId: string, waveId: string): boolean {
  let parked: WaveState | undefined;
  let childSessionIds: string[] = [];
  updateWaveEngineState((state) => {
    const wave = state.waves.find((candidate) => candidate.waveId === waveId);
    if (!wave || wave.conductorSessionId !== sessionId) return state;
    if (wave.phase !== "running") return state;
    childSessionIds = wave.steps.flatMap((step) =>
      step.sessionId ? [step.sessionId] : [],
    );
    parked = withWavePhase(wave, "needsOperator");
    return withWave(state, parked);
  });
  if (!parked) return false;
  recordWaveClose(parked, "needs-operator", "operator-stopped");

  for (const childSessionId of childSessionIds) {
    void stopOrchestratorSession(childSessionId);
  }
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
