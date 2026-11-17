import { create } from "zustand";
import { isRecord } from "@/shared/lib/isRecord";

export type BackgroundTaskState =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";
export interface BackgroundTask {
  id: string;
  state: BackgroundTaskState;
  name?: string;
  description?: string;
  summary?: string;
  outputFilePath?: string;
  /**
   * What kind of work it is, in the bridge's word: `shell` for a command,
   * `monitor`, `workflow`, and `turn` for a turn the agent took on its own.
   */
  taskType?: string;
  canStop?: boolean;
  /** When the host first saw the task, in epoch milliseconds. */
  startedAt?: number;
  /** When the host saw the task end, in epoch milliseconds. */
  endedAt?: number;
}

const states = new Set([
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
export const EMPTY_BACKGROUND_TASKS: readonly BackgroundTask[] = [];
export const NO_DISMISSED_BACKGROUND_TASKS: readonly string[] = [];

/** The host's ISO timestamp as epoch milliseconds, or nothing when it has none. */
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** True for a task that has not ended: it runs, or waits to run on. */
export function isBackgroundTaskLive(task: BackgroundTask): boolean {
  return task.state === "running" || task.state === "paused";
}

/** How many live background tasks a chat has, under any of its ids. */
export function liveBackgroundTaskCount(
  bySession: Readonly<Record<string, readonly BackgroundTask[]>>,
  sessionIds: ReadonlyArray<string | null | undefined>,
): number {
  let count = 0;
  const seen = new Set<string>();
  for (const sessionId of sessionIds) {
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    for (const task of bySession[sessionId] ?? []) {
      if (isBackgroundTaskLive(task)) count += 1;
    }
  }
  return count;
}

export const useBackgroundTasksStore = create<{
  bySession: Record<string, readonly BackgroundTask[]>;
  /**
   * The ended tasks the operator cleared from a chat's list, by task id. The
   * host keeps reporting them; they are only no longer shown.
   */
  dismissedBySession: Record<string, readonly string[]>;
  replace: (sessionId: string, value: unknown) => void;
  dismissEnded: (sessionId: string) => void;
}>((set) => ({
  bySession: {},
  dismissedBySession: {},
  dismissEnded: (sessionId) =>
    set((state) => ({
      dismissedBySession: {
        ...state.dismissedBySession,
        [sessionId]: (state.bySession[sessionId] ?? [])
          .filter((task) => !isBackgroundTaskLive(task))
          .map((task) => task.id),
      },
    })),
  replace: (sessionId, value) => {
    if (!Array.isArray(value)) return;
    const tasks: BackgroundTask[] = value
      .filter(
        (item): item is BackgroundTask =>
          isRecord(item) &&
          typeof item.id === "string" &&
          typeof item.state === "string" &&
          states.has(item.state),
      )
      .map((item) => ({
        id: item.id,
        state: item.state,
        ...Object.fromEntries(
          [
            "name",
            "description",
            "summary",
            "outputFilePath",
            "taskType",
          ].flatMap((key) => {
            const value = (item as unknown as Record<string, unknown>)[key];
            return typeof value === "string" ? [[key, value]] : [];
          }),
        ),
        canStop: item.canStop === true,
        ...Object.fromEntries(
          ["startedAt", "endedAt"].flatMap((key) => {
            const time = timestamp(
              (item as unknown as Record<string, unknown>)[key],
            );
            return time === undefined ? [] : [[key, time]];
          }),
        ),
      }));
    set((state) => {
      // A cleared task the host dropped needs no record of being cleared.
      const dismissed = state.dismissedBySession[sessionId];
      const kept = dismissed?.filter((id) =>
        tasks.some((task) => task.id === id),
      );
      return {
        bySession: { ...state.bySession, [sessionId]: tasks },
        ...(dismissed && kept && kept.length !== dismissed.length
          ? {
              dismissedBySession: {
                ...state.dismissedBySession,
                [sessionId]: kept,
              },
            }
          : {}),
      };
    });
  },
}));
