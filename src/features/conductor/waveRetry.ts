/**
 * The manual retry behind a refused wave plan (decision Q2).
 *
 * A broken fence spawns nothing, shows its enumerated reason, and stops there.
 * The only way another plan is ever requested is the operator pressing the
 * button this module backs — there is no automatic retry anywhere in the
 * engine, and adding one would put the conductor in a loop it cannot see.
 *
 * The request rides the same cross-session send seam berdctl uses, so it is a
 * real user turn in the conductor's transcript rather than a hidden nudge.
 */

import { sendPromptToExistingSessionInBackground } from "@/features/berdctl/commands/runtime/sessionSend";

import { withWavePhase } from "./waveEngine";
import { WAVE_REPLAN_REQUEST_PROMPT } from "./wavePrompts";
import { runWaveEngineTick } from "./waveRunner";
import { updateWaveEngineState, withWave } from "./waveStore";

/** Asks a conductor session for a new wave plan. Fire and forget. */
export function requestWaveReplan(sessionId: string): void {
  void sendPromptToExistingSessionInBackground(
    sessionId,
    WAVE_REPLAN_REQUEST_PROMPT,
  ).catch((error: unknown) => {
    console.error("Failed to ask the conductor for a new plan:", error);
  });
}

/**
 * Re-delivers a finished wave's digest after the conductor's answer could not
 * be read as a verdict (decision Q5).
 *
 * Bumping `digestAttempt` is what makes this safe to press twice: the digest's
 * marker contains the attempt, so the re-delivered digest is a *new* anchor and
 * the already-judged answer can never be read again as the verdict for it. No
 * revision is spent — an unreadable verdict never cost one.
 *
 * A wave that is not parked on `needsOperator` is left alone: the operator may
 * be looking at an old notice whose wave has since moved on.
 */
export function retryWaveDigest(sessionId: string, waveId: string): void {
  updateWaveEngineState((state) => {
    const wave = state.waves.find((candidate) => candidate.waveId === waveId);
    if (!wave || wave.conductorSessionId !== sessionId) return state;
    if (wave.phase !== "needsOperator") return state;
    return withWave(state, {
      ...withWavePhase(wave, "digestPending"),
      digestAttempt: wave.digestAttempt + 1,
    });
  });
  // The wave store has no subscribers; without this the re-armed wave would sit
  // until some unrelated chat change happened to run a tick.
  runWaveEngineTick();
}
