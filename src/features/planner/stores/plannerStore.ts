/**
 * Where the planner's tasks live.
 *
 * A JSON document in the operator's Distill folder, beside their projects and
 * sessions — not `localStorage`, which is where this started and which was the
 * wrong home: invisible to a backup, unreadable by a person, and gone on a
 * reinstall. An old browser copy is migrated on first read and then removed.
 *
 * Reading salvages rather than validates: a task that cannot be read is
 * dropped and the rest of the list loads, because a list that refuses to open
 * because one row is malformed has lost everything the operator put in it.
 *
 * The store starts empty and is filled by `hydratePlannerStore`, because
 * reading a file is asynchronous and a store cannot block on it. Nothing is
 * written back before that read lands — an empty list persisted over a full
 * one during startup would delete the operator's tasks.
 */

import { create } from "zustand";

import { distillDocument } from "@/shared/lib/distillDocument";

import type { PlannerFenceRequest } from "../lib/plannerFence";
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

/** Path under the Distill root. */
export const PLANNER_DOCUMENT_PATH = "planner.json";

/** Where the list lived before the move; read once, then removed. */
export const PLANNER_STORAGE_KEY = "goose:planner";

/**
 * Upper bound on stored tasks. Completed work is trimmed first and oldest
 * first: the open list is the product, the archive is a courtesy.
 */
export const MAX_PLANNER_TASKS = 500;

/**
 * How many "this message has already been filed" tombstones are kept.
 *
 * They exist so that reopening the app does not re-file every task an agent
 * ever wrote, and they are bounded because a transcript is unbounded. Losing
 * the oldest ones is safe in practice: the messages they name are far behind
 * the live tail the sync ever re-reads.
 */
export const MAX_APPLIED_MESSAGE_IDS = 2000;

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
  /** Assistant message ids whose `distill-todo` block has already been read. */
  appliedMessageIds: string[];
  /** False until the stored document has been read. Writes wait for it. */
  hydrated: boolean;
}

interface PlannerActions {
  addTask: (draft: PlannerTaskDraft, nowMs?: number) => string;
  updateTask: (
    id: string,
    patch: Partial<Omit<PlannerTask, "id" | "createdAt">>,
  ) => void;
  toggleComplete: (id: string, nowMs?: number) => void;
  removeTask: (id: string) => void;
  /**
   * Files one agent message's `distill-todo` block, once.
   *
   * Returns what actually changed so the caller can tell the operator; a
   * message id already on file is a no-op and reports nothing.
   */
  applyAgentRequest: (
    messageId: string,
    sessionId: string,
    request: PlannerFenceRequest,
    nowMs?: number,
  ) => { added: number; completed: number };
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

export function parseAppliedMessageIds(value: unknown): string[] {
  const list = (value as { appliedMessageIds?: unknown })?.appliedMessageIds;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    )
    .slice(-MAX_APPLIED_MESSAGE_IDS);
}

/** Reads a stored payload into state, salvaging what it can. */
function stateFromDocument(parsed: unknown): PlannerState {
  return {
    tasks: capTasks(parsePlannerTasks(parsed)),
    appliedMessageIds: parseAppliedMessageIds(parsed),
    hydrated: true,
  };
}

const document = distillDocument<PlannerState>({
  path: PLANNER_DOCUMENT_PATH,
  legacyStorageKey: PLANNER_STORAGE_KEY,
  parse: stateFromDocument,
  serialize: (state) => ({
    version: 1,
    tasks: state.tasks,
    appliedMessageIds: state.appliedMessageIds,
  }),
});

/**
 * Fills the store from disk. Called once at startup.
 *
 * A second call is a no-op: re-reading after the operator has already added a
 * task would replace their work with what was on disk when the app opened.
 */
export async function hydratePlannerStore(): Promise<void> {
  if (usePlannerStore.getState().hydrated) return;
  const stored = await document.read();
  usePlannerStore.setState(
    stored ?? { tasks: [], appliedMessageIds: [], hydrated: true },
  );
}

/** Waits for a queued write to land. For tests and for shutdown. */
export function flushPlannerWrites(): Promise<void> {
  return document.flush();
}

/** Test seam: forces the store back to its pre-hydration state. */
export function resetPlannerHydrationForTests(): void {
  usePlannerStore.setState({
    tasks: [],
    appliedMessageIds: [],
    hydrated: false,
  });
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

function commit(
  tasks: PlannerTask[],
  appliedMessageIds: string[],
): PlannerState {
  const next = {
    tasks: capTasks(tasks),
    appliedMessageIds: appliedMessageIds.slice(-MAX_APPLIED_MESSAGE_IDS),
    hydrated: true,
  };
  // Never before the read lands: an empty list written over a full one during
  // startup would delete the operator's tasks, and they would not know why.
  if (usePlannerStore.getState().hydrated) document.write(next);
  return next;
}

/** Titles match the way a person would read them: trimmed, case-insensitive. */
function sameTitle(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Commit new tasks, keeping the tombstones the state already carries. */
function commitTasks(state: PlannerState, tasks: PlannerTask[]): PlannerState {
  return commit(tasks, state.appliedMessageIds);
}

function newTaskId(): string {
  return `task_${crypto.randomUUID()}`;
}

export const usePlannerStore = create<PlannerStore>((set, get) => ({
  tasks: [],
  appliedMessageIds: [],
  hydrated: false,

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
    set((state) => commit([...state.tasks, task], state.appliedMessageIds));
    return id;
  },

  updateTask: (id, patch) => {
    set((state) =>
      commitTasks(
        state,
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
      commitTasks(
        state,
        state.tasks.map((task) => (task.id === id ? next : task)),
      ),
    );
  },

  removeTask: (id) => {
    set((state) =>
      commitTasks(
        state,
        state.tasks.filter((task) => task.id !== id),
      ),
    );
  },

  applyAgentRequest: (messageId, sessionId, request, nowMs = Date.now()) => {
    const state = get();
    if (!messageId || state.appliedMessageIds.includes(messageId)) {
      return { added: 0, completed: 0 };
    }

    let tasks = state.tasks;
    let added = 0;
    for (const draft of request.add) {
      // An agent that repeats itself across turns must not stack duplicates:
      // an open task with the same title is already the task being asked for.
      if (
        tasks.some(
          (task) => !isComplete(task) && sameTitle(task.title, draft.title),
        )
      ) {
        continue;
      }
      tasks = [
        ...tasks,
        {
          id: newTaskId(),
          title: draft.title,
          createdAt: nowMs,
          dueAt: draft.dueAt,
          completedAt: null,
          priority: draft.priority,
          repeat: draft.repeat,
          createdBySessionId: sessionId,
          ...(draft.notes ? { notes: draft.notes } : {}),
        },
      ];
      added += 1;
    }

    let completed = 0;
    for (const title of request.complete) {
      const target = tasks.find(
        (task) => !isComplete(task) && sameTitle(task.title, title),
      );
      if (!target) continue;
      const next = completeTask(target, nowMs);
      tasks = tasks.map((task) => (task.id === target.id ? next : task));
      completed += 1;
    }

    // The tombstone is written even when nothing changed: the message has
    // been read, and re-reading it on the next store tick would only find
    // the same duplicates again.
    set(() => commit(tasks, [...state.appliedMessageIds, messageId]));
    return { added, completed };
  },

  replaceAll: (tasks) => {
    set((state) => commit(tasks, state.appliedMessageIds));
  },
}));
