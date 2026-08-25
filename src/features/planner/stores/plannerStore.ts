/**
 * Where the planner's tasks live.
 *
 * localStorage, like the conductor's graph and wave stores: this is operator
 * state that belongs to this machine, it must survive a reload, and it must
 * never be the reason the app fails to start. Reading is therefore salvaging
 * rather than validating — a task that cannot be read is dropped and the rest
 * of the list loads, because a list that refuses to open because one row is
 * malformed has lost everything the user put in it.
 */

import { create } from "zustand";

import {
  completeTask,
  isComplete,
  reopenTask,
  startOfLocalDay,
  type PlannerPriority,
  type PlannerRepeat,
  type PlannerTask,
  type Weekday,
} from "../lib/plannerTask";

export const PLANNER_STORAGE_KEY = "goose:planner";

/**
 * Upper bound on stored tasks. Completed work is trimmed first and oldest
 * first: the open list is the product, the archive is a courtesy.
 */
export const MAX_PLANNER_TASKS = 500;

export interface PlannerTaskDraft {
  title: string;
  dueAt?: number | null;
  priority?: PlannerPriority;
  repeat?: PlannerRepeat | null;
  notes?: string;
  /** Set when an agent created this from a chat. */
  createdBySessionId?: string;
}

interface PlannerState {
  tasks: PlannerTask[];
}

interface PlannerActions {
  addTask: (draft: PlannerTaskDraft, nowMs?: number) => string;
  updateTask: (
    id: string,
    patch: Partial<Omit<PlannerTask, "id" | "createdAt">>,
  ) => void;
  toggleComplete: (id: string, nowMs?: number) => void;
  removeTask: (id: string) => void;
  /** Test seam and hard reset. */
  replaceAll: (tasks: PlannerTask[]) => void;
}

export type PlannerStore = PlannerState & PlannerActions;

function isPriority(value: unknown): value is PlannerPriority {
  return value === "normal" || value === "high";
}

function parseRepeat(value: unknown): PlannerRepeat | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { kind?: unknown; days?: unknown };
  if (raw.kind === "daily") return { kind: "daily" };
  if (raw.kind !== "weekly") return null;
  const days = Array.isArray(raw.days)
    ? raw.days.filter(
        (day): day is Weekday =>
          typeof day === "number" &&
          Number.isInteger(day) &&
          day >= 0 &&
          day <= 6,
      )
    : [];
  return { kind: "weekly", days };
}

function parseTask(value: unknown): PlannerTask | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PlannerTask>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  return {
    id: raw.id,
    title,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    dueAt: typeof raw.dueAt === "number" ? startOfLocalDay(raw.dueAt) : null,
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : null,
    priority: isPriority(raw.priority) ? raw.priority : "normal",
    repeat: parseRepeat(raw.repeat),
    ...(typeof raw.createdBySessionId === "string"
      ? { createdBySessionId: raw.createdBySessionId }
      : {}),
    ...(typeof raw.lastCompletedAt === "number"
      ? { lastCompletedAt: raw.lastCompletedAt }
      : {}),
    ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
  };
}

export function parsePlannerTasks(value: unknown): PlannerTask[] {
  const list = Array.isArray(value)
    ? value
    : ((value as { tasks?: unknown })?.tasks ?? null);
  if (!Array.isArray(list)) return [];
  return list
    .map(parseTask)
    .filter((task): task is PlannerTask => task !== null);
}

function loadPersistedTasks(): PlannerTask[] {
  try {
    const raw = window.localStorage.getItem(PLANNER_STORAGE_KEY);
    if (!raw) return [];
    return capTasks(parsePlannerTasks(JSON.parse(raw)));
  } catch {
    return [];
  }
}

/** Trims to the bound, oldest completed first, then oldest open. */
export function capTasks(tasks: PlannerTask[]): PlannerTask[] {
  if (tasks.length <= MAX_PLANNER_TASKS) return tasks;
  const evictable = [...tasks]
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftDone = isComplete(left.task) ? 0 : 1;
      const rightDone = isComplete(right.task) ? 0 : 1;
      if (leftDone !== rightDone) return leftDone - rightDone;
      return left.task.createdAt - right.task.createdAt;
    });
  const drop = new Set(
    evictable.slice(0, tasks.length - MAX_PLANNER_TASKS).map((e) => e.index),
  );
  return tasks.filter((_, index) => !drop.has(index));
}

function persist(tasks: PlannerTask[]): void {
  try {
    window.localStorage.setItem(
      PLANNER_STORAGE_KEY,
      JSON.stringify({ version: 1, tasks }),
    );
  } catch {
    // localStorage may be unavailable; the list still works for this session.
  }
}

function commit(tasks: PlannerTask[]): PlannerState {
  const capped = capTasks(tasks);
  persist(capped);
  return { tasks: capped };
}

function newTaskId(): string {
  return `task_${crypto.randomUUID()}`;
}

export const usePlannerStore = create<PlannerStore>((set, get) => ({
  tasks: loadPersistedTasks(),

  addTask: (draft, nowMs = Date.now()) => {
    const title = draft.title.trim();
    if (!title) return "";
    const id = newTaskId();
    const task: PlannerTask = {
      id,
      title,
      createdAt: nowMs,
      dueAt:
        typeof draft.dueAt === "number" ? startOfLocalDay(draft.dueAt) : null,
      completedAt: null,
      priority: draft.priority ?? "normal",
      repeat: draft.repeat ?? null,
      ...(draft.createdBySessionId
        ? { createdBySessionId: draft.createdBySessionId }
        : {}),
      ...(draft.notes ? { notes: draft.notes } : {}),
    };
    set((state) => commit([...state.tasks, task]));
    return id;
  },

  updateTask: (id, patch) => {
    set((state) =>
      commit(
        state.tasks.map((task) =>
          task.id === id
            ? {
                ...task,
                ...patch,
                ...(patch.dueAt !== undefined
                  ? {
                      dueAt:
                        typeof patch.dueAt === "number"
                          ? startOfLocalDay(patch.dueAt)
                          : null,
                    }
                  : {}),
              }
            : task,
        ),
      ),
    );
  },

  toggleComplete: (id, nowMs = Date.now()) => {
    const current = get().tasks.find((task) => task.id === id);
    if (!current) return;
    const next = isComplete(current)
      ? reopenTask(current)
      : completeTask(current, nowMs);
    set((state) =>
      commit(state.tasks.map((task) => (task.id === id ? next : task))),
    );
  },

  removeTask: (id) => {
    set((state) => commit(state.tasks.filter((task) => task.id !== id)));
  },

  replaceAll: (tasks) => {
    set(() => commit(tasks));
  },
}));
