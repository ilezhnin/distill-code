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
  canStop?: boolean;
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
  replace: (sessionId: string, value: unknown) => void;
}>((set) => ({
  bySession: {},
  replace: (sessionId, value) => {
    if (!Array.isArray(value)) return;
    const tasks = value
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
          ["name", "description", "summary", "outputFilePath"].flatMap(
            (key) => {
              const value = (item as unknown as Record<string, unknown>)[key];
              return typeof value === "string" ? [[key, value]] : [];
            },
          ),
        ),
        canStop: item.canStop === true,
      }));
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: tasks } }));
  },
}));
