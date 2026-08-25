import { describe, expect, it } from "vitest";

import {
  completeTask,
  countForTab,
  groupTasksForTab,
  isDoneForToday,
  isOverdue,
  nextOccurrence,
  reopenTask,
  startOfLocalDay,
  type PlannerTask,
} from "./plannerTask";

const DAY = 24 * 60 * 60 * 1000;
/** A Wednesday, mid-morning, in local time. */
const NOW = new Date(2026, 7, 26, 10, 30).getTime();
const TODAY = startOfLocalDay(NOW);

function task(overrides: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: overrides.id ?? "t-1",
    title: "Write the release note",
    createdAt: TODAY - 5 * DAY,
    dueAt: null,
    completedAt: null,
    priority: "normal",
    repeat: null,
    ...overrides,
  };
}

describe("startOfLocalDay", () => {
  it("is stable across the hours of one day", () => {
    const early = new Date(2026, 7, 26, 0, 1).getTime();
    const late = new Date(2026, 7, 26, 23, 59).getTime();
    expect(startOfLocalDay(early)).toBe(startOfLocalDay(late));
  });
});

describe("nextOccurrence", () => {
  it("moves a daily repeat to tomorrow", () => {
    expect(nextOccurrence({ kind: "daily" }, TODAY)).toBe(
      startOfLocalDay(TODAY + DAY),
    );
  });

  it("moves a weekly repeat to its next chosen day", () => {
    // Wednesday is 3; the next chosen day is Friday.
    const next = nextOccurrence({ kind: "weekly", days: [1, 5] }, TODAY);
    expect(new Date(next).getDay()).toBe(5);
    expect(next).toBe(startOfLocalDay(TODAY + 2 * DAY));
  });

  it("wraps into next week when today is the only chosen day", () => {
    const next = nextOccurrence({ kind: "weekly", days: [3] }, TODAY);
    expect(next).toBe(startOfLocalDay(TODAY + 7 * DAY));
  });

  it("still schedules a weekly repeat that lost its days", () => {
    // A stored task must always be readable back into something schedulable;
    // refusing would drop it out of every list.
    const next = nextOccurrence({ kind: "weekly", days: [] }, TODAY);
    expect(next).toBeGreaterThan(TODAY);
  });
});

describe("completeTask", () => {
  it("finishes a one-off", () => {
    const done = completeTask(task({ dueAt: TODAY }), NOW);
    expect(done.completedAt).toBe(NOW);
  });

  it("rolls a repeating task instead of finishing it", () => {
    // A repeating task marked "completed" vanishes from every list that
    // matters and only comes back if someone re-creates it by hand.
    const rolled = completeTask(
      task({ dueAt: TODAY, repeat: { kind: "daily" } }),
      NOW,
    );

    expect(rolled.completedAt).toBeNull();
    expect(rolled.lastCompletedAt).toBe(NOW);
    expect(rolled.dueAt).toBe(startOfLocalDay(TODAY + DAY));
    expect(isDoneForToday(rolled, NOW)).toBe(true);
  });

  it("rolls from today when a repeating task had no due date", () => {
    const rolled = completeTask(task({ repeat: { kind: "daily" } }), NOW);
    expect(rolled.dueAt).toBe(startOfLocalDay(TODAY + DAY));
  });

  it("reopens what it completed", () => {
    const done = completeTask(task(), NOW);
    expect(reopenTask(done).completedAt).toBeNull();
  });
});

describe("isOverdue", () => {
  it("counts yesterday, not this morning", () => {
    expect(isOverdue(task({ dueAt: TODAY - DAY }), NOW)).toBe(true);
    expect(isOverdue(task({ dueAt: TODAY }), NOW)).toBe(false);
  });

  it("never counts something already done", () => {
    expect(isOverdue(task({ dueAt: TODAY - DAY, completedAt: NOW }), NOW)).toBe(
      false,
    );
  });
});

describe("groupTasksForTab", () => {
  const tasks = [
    task({ id: "late", title: "Late", dueAt: TODAY - 2 * DAY }),
    task({ id: "now", title: "Today", dueAt: TODAY }),
    task({ id: "soon", title: "Soon", dueAt: TODAY + 3 * DAY }),
    task({ id: "someday", title: "Someday" }),
    task({ id: "done", title: "Done", completedAt: NOW - DAY }),
  ];

  it("shows today's work as what is late and what is due", () => {
    const groups = groupTasksForTab(tasks, "today", NOW);
    expect(groups.map((group) => group.id)).toEqual(["overdue", "today"]);
    expect(groups[0].tasks.map((entry) => entry.id)).toEqual(["late"]);
    expect(groups[1].tasks.map((entry) => entry.id)).toEqual(["now"]);
  });

  it("shows only the future under Scheduled", () => {
    const groups = groupTasksForTab(tasks, "scheduled", NOW);
    expect(groups.map((group) => group.id)).toEqual(["scheduled"]);
    expect(groups[0].tasks.map((entry) => entry.id)).toEqual(["soon"]);
  });

  it("shows every open task under All, in its own bucket", () => {
    const groups = groupTasksForTab(tasks, "all", NOW);
    expect(groups.map((group) => group.id)).toEqual([
      "overdue",
      "today",
      "scheduled",
      "noDueDate",
    ]);
    expect(
      groups.flatMap((group) => group.tasks).map((e) => e.id),
    ).not.toContain("done");
  });

  it("shows finished work newest first", () => {
    const groups = groupTasksForTab(
      [
        task({ id: "older", completedAt: NOW - 2 * DAY }),
        task({ id: "newer", completedAt: NOW - DAY }),
      ],
      "completed",
      NOW,
    );
    expect(groups[0].tasks.map((entry) => entry.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("drops an empty group rather than rendering a bare heading", () => {
    expect(groupTasksForTab([], "all", NOW)).toEqual([]);
  });

  it("puts a high-priority task above an earlier-dated one", () => {
    const groups = groupTasksForTab(
      [
        task({ id: "plain", dueAt: TODAY, createdAt: 1 }),
        task({ id: "urgent", dueAt: TODAY, priority: "high", createdAt: 2 }),
      ],
      "today",
      NOW,
    );
    expect(groups[0].tasks.map((entry) => entry.id)).toEqual([
      "urgent",
      "plain",
    ]);
  });

  it("counts a tab as exactly what that tab renders", () => {
    expect(countForTab(tasks, "today", NOW)).toBe(2);
    expect(countForTab(tasks, "completed", NOW)).toBe(1);
  });
});
