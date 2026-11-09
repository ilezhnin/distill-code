import {
  liveBackgroundTaskCount,
  useBackgroundTasksStore,
} from "@/features/chat/stores/backgroundTasksStore";
import { useMonitorJobStore } from "./monitorJobStore";

/**
 * How long a session still counts as working after its background work
 * ended. The end of a background task and the agent's reply to it are two
 * events: Claude Code wakes the agent a moment after the task reports its
 * end, and a flock-monitor job's last line arrives as a message after the job
 * record says it ended. Read in between, the run looked finished and its
 * "I'll pick up when the wait finishes" went out as the report.
 */
export const BACKGROUND_WORK_SETTLE_MS = 15_000;

const lastLiveAt = new Map<string, number>();
const settleListeners = new Set<() => void>();
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleAt = Number.POSITIVE_INFINITY;

function scheduleSettle(at: number): void {
  if (settleTimer !== null && settleAt <= at) return;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleAt = at;
  settleTimer = setTimeout(
    () => {
      settleTimer = null;
      settleAt = Number.POSITIVE_INFINITY;
      for (const listener of settleListeners) listener();
    },
    Math.max(0, at - Date.now()) + 50,
  );
}

/**
 * Calls `listener` when a session's settle window has run out, so whoever
 * holds a run open on this answer can look again. Returns the unsubscribe.
 */
export function onBackgroundWorkSettled(listener: () => void): () => void {
  settleListeners.add(listener);
  return () => {
    settleListeners.delete(listener);
  };
}

/** A background task or a flock-monitor job of the session runs now. */
function taskOrJobLive(sessionId: string): boolean {
  const { bySession } = useBackgroundTasksStore.getState();
  if (liveBackgroundTaskCount(bySession, [sessionId]) > 0) return true;
  return useMonitorJobStore.getState().liveOwnerIds.has(sessionId);
}

/**
 * True while a session has work running that outlived its own turn: a
 * background task its agent started (a background shell), the reply its
 * agent continues on its own once such a task ends, or a flock-monitor job
 * the session owns — and for a short settle window after that work ended.
 *
 * A worker that starts a long command in the background and ends its turn
 * has not finished: it is woken when the command ends and reports then. On
 * 2026-11-08 such a worker read as finished the moment its turn ended, its
 * "I'll pick up when the background wait finishes" went to the wave as its
 * report, and the sidebar showed it idle while its compile ran.
 */
export function sessionBackgroundWorkLive(
  sessionId: string,
  activeRunId?: string | null,
  now = Date.now(),
): boolean {
  // Only a task or a job opens the settle window: a run id alone is also
  // what any ordinary turn carries, and every step would end late.
  if (taskOrJobLive(sessionId)) {
    lastLiveAt.set(sessionId, now);
    return true;
  }
  if (activeRunId) return true;
  const last = lastLiveAt.get(sessionId);
  if (last === undefined) return false;
  const settlesAt = last + BACKGROUND_WORK_SETTLE_MS;
  if (now < settlesAt) {
    scheduleSettle(settlesAt);
    return true;
  }
  lastLiveAt.delete(sessionId);
  return false;
}

export function resetBackgroundWorkForTests(): void {
  lastLiveAt.clear();
  settleListeners.clear();
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  settleAt = Number.POSITIVE_INFINITY;
}
