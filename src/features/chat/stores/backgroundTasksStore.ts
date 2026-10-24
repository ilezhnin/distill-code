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
