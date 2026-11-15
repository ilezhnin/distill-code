/**
 * The operator's hold on a conductor's new work.
 *
 * "Only finish what is started" used to be a sentence in the chat: the
 * conductor read it, planned a new wave of readers anyway, and the app
 * started them (11-14). A hold is the same instruction kept by the app.
 * While it is on, nothing new starts for that conductor — no wave, no
 * revision, no turn toward its goal, no session under its tree — and what
 * is already running finishes. It is set and lifted here, from the
 * operator's control above the composer, and by nothing an agent can call.
 */

import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import { createSystemNotificationMessage } from "@/shared/types/messages";

import { runWaveEngineTick } from "./waveRunner";
import {
  getWaveEngineState,
  isConductorHeld,
  updateWaveEngineState,
  withConductorHold,
} from "./waveStore";

const listeners = new Set<() => void>();

/** Subscribes to holds being set or lifted. Returns the unsubscribe. */
export function subscribeToConductorHolds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the operator holds this conductor's new work now. */
export function conductorHeld(sessionId: string | null | undefined): boolean {
  return isConductorHeld(getWaveEngineState(), sessionId);
}

/**
 * Sets or lifts the hold, and says so in the conductor's chat, where the
 * notice reaches the conductor too: it must know not to plan, and when it
 * may again.
 */
export function setConductorHold(sessionId: string, held: boolean): void {
  if (conductorHeld(sessionId) === held) return;
  updateWaveEngineState((state) => withConductorHold(state, sessionId, held));
  useChatStore
    .getState()
    .addMessage(
      sessionId,
      createSystemNotificationMessage(
        i18n.t(
          held
            ? "chat:conductor.hold.setNotice"
            : "chat:conductor.hold.liftedNotice",
        ),
        "warning",
      ),
    );
  for (const listener of listeners) listener();
  // A lifted hold lets the goal loop and queued work move again.
  if (!held) runWaveEngineTick();
}
