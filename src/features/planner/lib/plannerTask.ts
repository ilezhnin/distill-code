/**
 * The planner's task model and every decision it makes about time.
 *
 * Pure on purpose, and every function that needs "now" takes it as an
 * argument: a planner whose behaviour depends on the wall clock is a planner
 * whose tests are flaky at midnight, and the one thing a task list must never
 * be is unsure which day it is.
 *
 * Days are local days. A due date is stored as the start of its local day, so
 * "due today" survives being written at 23:59 and read at 00:01, and no task
 * silently changes bucket because the user opened the app in a different hour.
 */

export type PlannerPriority = "normal" | "high";

/** Weekday numbers as JS reports them: 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type PlannerRepeat =
  | { kind: "daily" }
  | { kind: "weekly"; days: Weekday[] };

export interface PlannerTask {
  id: string;
  title: string;
  createdAt: number;
  /** Start of the local day this is due, or null for an undated task. */
  dueAt: number | null;
  /** When it was finished. A repeating task never carries this — it rolls. */
  completedAt: number | null;
  priority: PlannerPriority;
  repeat: PlannerRepeat | null;
  /** Set when an agent created it, so the list can say where it came from. */
  createdBySessionId?: string;
  /** Last time a repeating task was ticked off, for "done today" feedback. */
  lastCompletedAt?: number;
  notes?: string;
}

export type PlannerTab = "today" | "scheduled" | "all" | "completed";

export type PlannerGroupId = "overdue" | "today" | "scheduled" | "noDueDate";

export interface PlannerGroup {
  id: PlannerGroupId;
  tasks: PlannerTask[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the local day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function isSameLocalDay(left: number, right: number): boolean {
  return startOfLocalDay(left) === startOfLocalDay(right);
}

function weekdayOf(ms: number): Weekday {
  return new Date(ms).getDay() as Weekday;
}

/**
 * The next day a repeating task is due, strictly after `from`.
 *
 * A weekly repeat with no days is treated as weekly-on-the-day-it-was-due:
 * a stored task can always be read back, and refusing to schedule it at all
 * would drop it out of the list entirely.
 */
export function nextOccurrence(repeat: PlannerRepeat, from: number): number {
  const day = startOfLocalDay(from);
  if (repeat.kind === "daily") {
    return startOfLocalDay(day + DAY_MS + DAY_MS / 2);
  }
  const days = repeat.days.length > 0 ? repeat.days : [weekdayOf(day)];
  const wanted = new Set<number>(days);
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    // Half a day of slack absorbs daylight-saving shifts: adding exact
    // multiples of 24h across a DST boundary lands at 23:00 of the day
    // before, and startOfLocalDay would then hand back the wrong day.
    const candidate = startOfLocalDay(day + ahead * DAY_MS + DAY_MS / 2);
    if (wanted.has(weekdayOf(candidate))) return candidate;
  }
  return startOfLocalDay(day + DAY_MS + DAY_MS / 2);
}

/**
 * Ticking a task off.
 *
 * A one-off is completed. A repeating one is not: it rolls to its next
 * occurrence and records that this one was done, because a repeating task the
 * planner marks "completed" disappears from every list that matters and comes
 * back only if someone re-creates it by hand.
 */
export function completeTask(task: PlannerTask, nowMs: number): PlannerTask {
  if (!task.repeat) {
    return { ...task, completedAt: nowMs };
  }
  return {
    ...task,
    completedAt: null,
    lastCompletedAt: nowMs,
    dueAt: nextOccurrence(task.repeat, task.dueAt ?? nowMs),
  };
}

/** Undoing a completion. A rolled repeat cannot be un-rolled; it just clears. */
export function reopenTask(task: PlannerTask): PlannerTask {
  return { ...task, completedAt: null };
}

export function isComplete(task: PlannerTask): boolean {
  return task.completedAt !== null;
}

/** True when a repeating task has already been ticked off for today. */
export function isDoneForToday(task: PlannerTask, nowMs: number): boolean {
  return (
    task.repeat !== null &&
    task.lastCompletedAt !== undefined &&
    isSameLocalDay(task.lastCompletedAt, nowMs)
  );
}

export function isOverdue(task: PlannerTask, nowMs: number): boolean {
  return (
    !isComplete(task) &&
    task.dueAt !== null &&
    task.dueAt < startOfLocalDay(nowMs)
  );
}

export function isDueToday(task: PlannerTask, nowMs: number): boolean {
  return (
    !isComplete(task) &&
    task.dueAt !== null &&
    isSameLocalDay(task.dueAt, nowMs)
  );
}

/**
 * Sort within a group: high priority first, then by due date, then by age.
 *
 * Priority outranks the date on purpose — a high-priority task the operator
 * marked is the one they want to see first, and burying it under three
 * undated chores because those were typed earlier is how a list stops being
 * read at all.
 */
export function comparePlannerTasks(
  left: PlannerTask,
  right: PlannerTask,
): number {
  if (left.priority !== right.priority) {
    return left.priority === "high" ? -1 : 1;
  }
  if (left.dueAt !== right.dueAt) {
    if (left.dueAt === null) return 1;
    if (right.dueAt === null) return -1;
    return left.dueAt - right.dueAt;
  }
  return left.createdAt - right.createdAt;
}

function sorted(tasks: readonly PlannerTask[]): PlannerTask[] {
  return [...tasks].sort(comparePlannerTasks);
}

/** The tasks one tab shows, already grouped and sorted for rendering. */
export function groupTasksForTab(
  tasks: readonly PlannerTask[],
  tab: PlannerTab,
  nowMs: number,
): PlannerGroup[] {
  if (tab === "completed") {
    const done = tasks
      .filter(isComplete)
      .sort(
        (left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0),
      );
    return done.length > 0 ? [{ id: "today", tasks: done }] : [];
  }

  const open = tasks.filter((task) => !isComplete(task));
  const today = startOfLocalDay(nowMs);

  const overdue = open.filter((task) => isOverdue(task, nowMs));
  const dueToday = open.filter((task) => isDueToday(task, nowMs));
  const later = open.filter(
    (task) => task.dueAt !== null && task.dueAt > today,
  );
  const undated = open.filter((task) => task.dueAt === null);

  const groups: PlannerGroup[] = [];
  const push = (id: PlannerGroupId, list: PlannerTask[]) => {
    if (list.length > 0) groups.push({ id, tasks: sorted(list) });
  };

  if (tab === "today") {
    // Today is a working list, not a calendar: what is late and what is due.
    push("overdue", overdue);
    push("today", dueToday);
    return groups;
  }
  if (tab === "scheduled") {
    push("scheduled", later);
    return groups;
  }
  push("overdue", overdue);
  push("today", dueToday);
  push("scheduled", later);
  push("noDueDate", undated);
  return groups;
}

/** Count for a tab's badge — the same set the tab would render. */
export function countForTab(
  tasks: readonly PlannerTask[],
  tab: PlannerTab,
  nowMs: number,
): number {
  return groupTasksForTab(tasks, tab, nowMs).reduce(
    (total, group) => total + group.tasks.length,
    0,
  );
}
