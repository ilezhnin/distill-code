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

import { WAVE_REPLAN_REQUEST_PROMPT } from "./wavePrompts";

/** Asks a conductor session for a new wave plan. Fire and forget. */
export function requestWaveReplan(sessionId: string): void {
  void sendPromptToExistingSessionInBackground(
    sessionId,
    WAVE_REPLAN_REQUEST_PROMPT,
  ).catch((error: unknown) => {
    console.error("Failed to ask the conductor for a new plan:", error);
  });
}
