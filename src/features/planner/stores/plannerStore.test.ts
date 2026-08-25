import { beforeEach, describe, expect, it } from "vitest";

import { startOfLocalDay, type PlannerTask } from "../lib/plannerTask";
import {
  capTasks,
  MAX_PLANNER_TASKS,
  parsePlannerTasks,
  PLANNER_STORAGE_KEY,
  usePlannerStore,
} from "./plannerStore";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 26, 10, 30).getTime();
const TODAY = startOfLocalDay(NOW);

function task(overrides: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: overrides.id ?? "t-1",
    title: "A task",
    createdAt: NOW,
    dueAt: null,
    completedAt: null,
    priority: "normal",
    repeat: null,
    ...overrides,
  };
}

describe("plannerStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePlannerStore.getState().replaceAll([]);
  });

  it("keeps a task across a reload", () => {
    usePlannerStore
      .getState()
      .addTask({ title: "Ship the planner", priority: "high" }, NOW);

    const stored = parsePlannerTasks(
      JSON.parse(window.localStorage.getItem(PLANNER_STORAGE_KEY) ?? "{}"),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Ship the planner");
    expect(stored[0].priority).toBe("high");
  });

  it("refuses a blank title rather than storing an unreadable row", () => {
    expect(usePlannerStore.getState().addTask({ title: "   " })).toBe("");
    expect(usePlannerStore.getState().tasks).toHaveLength(0);
  });

  it("stores a due date as the start of its local day", () => {
    const id = usePlannerStore
      .getState()
      .addTask({ title: "Dated", dueAt: NOW }, NOW);
    const stored = usePlannerStore.getState().tasks.find((t) => t.id === id);
    expect(stored?.dueAt).toBe(TODAY);
  });

  it("rolls a repeating task on completion instead of archiving it", () => {
    const id = usePlannerStore
      .getState()
      .addTask(
        { title: "Standup", dueAt: NOW, repeat: { kind: "daily" } },
        NOW,
      );

    usePlannerStore.getState().toggleComplete(id, NOW);

    const rolled = usePlannerStore.getState().tasks.find((t) => t.id === id);
    expect(rolled?.completedAt).toBeNull();
    expect(rolled?.dueAt).toBe(startOfLocalDay(TODAY + DAY));
  });

  it("completes and reopens a one-off", () => {
    const id = usePlannerStore.getState().addTask({ title: "One-off" }, NOW);

    usePlannerStore.getState().toggleComplete(id, NOW);
    expect(
      usePlannerStore.getState().tasks.find((t) => t.id === id)?.completedAt,
    ).toBe(NOW);

    usePlannerStore.getState().toggleComplete(id, NOW);
    expect(
      usePlannerStore.getState().tasks.find((t) => t.id === id)?.completedAt,
    ).toBeNull();
  });
});

describe("parsePlannerTasks", () => {
  it("keeps the readable rows of a half-broken list", () => {
    // A list that refuses to open because one row is malformed has lost
    // everything the user put in it.
    const parsed = parsePlannerTasks({
      tasks: [
        { id: "", title: "no id" },
        { id: "ok", title: "readable", createdAt: 1 },
        { id: "blank", title: "   " },
        "not an object",
      ],
    });

    expect(parsed.map((t) => t.id)).toEqual(["ok"]);
  });

  it("reads a bare array and repairs missing fields", () => {
    const parsed = parsePlannerTasks([{ id: "x", title: "Bare" }]);
    expect(parsed[0]).toMatchObject({
      priority: "normal",
      repeat: null,
      dueAt: null,
      completedAt: null,
    });
  });

  it("keeps a weekly repeat's days and drops impossible ones", () => {
    const parsed = parsePlannerTasks([
      {
        id: "w",
        title: "Weekly",
        repeat: { kind: "weekly", days: [1, 9, "x", 5] },
      },
    ]);
    expect(parsed[0].repeat).toEqual({ kind: "weekly", days: [1, 5] });
  });

  it("has no opinion on junk", () => {
    expect(parsePlannerTasks(null)).toEqual([]);
    expect(parsePlannerTasks("nope")).toEqual([]);
  });
});

describe("capTasks", () => {
  it("drops finished work before anything still open", () => {
    const tasks = [
      ...Array.from({ length: MAX_PLANNER_TASKS }, (_, index) =>
        task({ id: `open-${index}`, createdAt: index }),
      ),
      task({ id: "done", createdAt: -1, completedAt: NOW }),
    ];

    const capped = capTasks(tasks);
    expect(capped).toHaveLength(MAX_PLANNER_TASKS);
    expect(capped.some((entry) => entry.id === "done")).toBe(false);
  });

  it("leaves a list under the bound exactly as it is", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" })];
    expect(capTasks(tasks)).toEqual(tasks);
  });
});
