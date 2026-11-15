/**
 * When each session last sent anything, and which of its tool calls are still
 * running.
 *
 * The chat state says a turn is running; it does not say whether anything is
 * arriving. A provider at its limit can end a turn without a word, and the
 * session then reads as working for as long as nobody looks (11-14: a wave
 * step sat on a model whose weekly limit had run out, with no signal). The
 * pulse is what tells a model that has gone quiet from one that is thinking
 * or waiting on a tool it started: a turn with a tool call in flight is not
 * waiting on its provider at all.
 *
 * Kept outside the stores on purpose. It is written on every streamed
 * update, and nothing renders from it.
 */

interface Pulse {
  lastEventAt: number;
  toolsInFlight: Set<string>;
}

const pulses = new Map<string, Pulse>();

/** The shape of a session update the pulse reads; other fields are ignored. */
interface PulseUpdate {
  sessionUpdate?: string;
  toolCallId?: unknown;
  status?: unknown;
}

function settled(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

/** Records one live update of a session. Replayed history is no pulse. */
export function noteSessionUpdate(
  sessionId: string,
  update: PulseUpdate,
  now = Date.now(),
): void {
  let pulse = pulses.get(sessionId);
  if (!pulse) {
    pulse = { lastEventAt: now, toolsInFlight: new Set() };
    pulses.set(sessionId, pulse);
  }
  pulse.lastEventAt = now;
  const id = typeof update.toolCallId === "string" ? update.toolCallId : null;
  if (id === null) return;
  if (
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update"
  ) {
    if (settled(update.status)) pulse.toolsInFlight.delete(id);
    else pulse.toolsInFlight.add(id);
  }
}

/** A turn that ended has no tool call left running, whatever was reported. */
export function noteSessionTurnEnded(sessionId: string): void {
  pulses.get(sessionId)?.toolsInFlight.clear();
}

export interface SessionPulse {
  /** When the session last sent an update, in epoch milliseconds. */
  lastEventAt: number;
  /** Tool calls the session started that have not reported their end. */
  toolsInFlight: number;
}

/** What is known of a session's pulse; nothing for one never heard from. */
export function sessionPulse(sessionId: string): SessionPulse | undefined {
  const pulse = pulses.get(sessionId);
  if (!pulse) return undefined;
  return {
    lastEventAt: pulse.lastEventAt,
    toolsInFlight: pulse.toolsInFlight.size,
  };
}

export function resetSessionPulsesForTests(): void {
  pulses.clear();
}
