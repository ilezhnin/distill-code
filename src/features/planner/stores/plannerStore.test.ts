import { beforeEach, describe, expect, it } from "vitest";

import type { PlannerFenceRequest } from "../lib/plannerFence";
import { startOfLocalDay, type PlannerTask } from "../lib/plannerTask";
import {
  capTasks,
  flushPlannerWrites,
  MAX_APPLIED_MESSAGE_IDS,
  MAX_PLANNER_TASKS,
  parseAppliedMessageIds,
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
    // Hydration is what unlocks writing; outside the desktop app the document
    // layer falls back to the same localStorage key these cases read.
    usePlannerStore.setState({ hydrated: true });
    usePlannerStore.getState().replaceAll([]);
  });

  it("keeps a task across a reload", async () => {
    usePlannerStore
      .getState()
      .addTask({ title: "Ship the planner", priority: "high" }, NOW);
    await flushPlannerWrites();

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

function request(
  overrides: Partial<PlannerFenceRequest> = {},
): PlannerFenceRequest {
  return { add: [], complete: [], ...overrides };
}

describe("applyAgentRequest", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePlannerStore.setState({
      tasks: [],
      appliedMessageIds: [],
      hydrated: true,
    });
  });

  it("files an agent's task and records where it came from", () => {
    const result = usePlannerStore.getState().applyAgentRequest(
      "m-1",
      "session-7",
      request({
        add: [
          {
            title: "Renew the certificate",
            dueAt: TODAY,
            priority: "high",
            repeat: null,
          },
        ],
      }),
      NOW,
    );

    expect(result).toEqual({ added: 1, completed: 0 });
    const [stored] = usePlannerStore.getState().tasks;
    expect(stored).toMatchObject({
      title: "Renew the certificate",
      priority: "high",
      dueAt: TODAY,
      createdBySessionId: "session-7",
    });
  });

  it("reads one message exactly once, even after a reload", async () => {
    const req = request({
      add: [{ title: "Once", dueAt: null, priority: "normal", repeat: null }],
    });
    usePlannerStore.getState().applyAgentRequest("m-1", "s", req, NOW);
    const second = usePlannerStore
      .getState()
      .applyAgentRequest("m-1", "s", req, NOW);
    await flushPlannerWrites();

    expect(second).toEqual({ added: 0, completed: 0 });
    expect(usePlannerStore.getState().tasks).toHaveLength(1);
    // The tombstone is what survives the reload, so persist it with the list.
    const stored = JSON.parse(
      window.localStorage.getItem(PLANNER_STORAGE_KEY) ?? "{}",
    );
    expect(parseAppliedMessageIds(stored)).toContain("m-1");
  });

  it("does not stack a duplicate of a task the operator still has open", () => {
    usePlannerStore.getState().addTask({ title: "Ship the planner" }, NOW);
    const result = usePlannerStore.getState().applyAgentRequest(
      "m-1",
      "s",
      request({
        add: [
          {
            title: "  ship the PLANNER ",
            dueAt: null,
            priority: "normal",
            repeat: null,
          },
        ],
      }),
      NOW,
    );

    expect(result.added).toBe(0);
    expect(usePlannerStore.getState().tasks).toHaveLength(1);
  });

  it("ticks a task off by its title", () => {
    const id = usePlannerStore
      .getState()
      .addTask({ title: "Draft notes" }, NOW);

    const result = usePlannerStore
      .getState()
      .applyAgentRequest(
        "m-1",
        "s",
        request({ complete: ["draft notes"] }),
        NOW,
      );

    expect(result).toEqual({ added: 0, completed: 1 });
    expect(
      usePlannerStore.getState().tasks.find((t) => t.id === id)?.completedAt,
    ).toBe(NOW);
  });

  it("rolls a repeating task the agent ticks off rather than archiving it", () => {
    const id = usePlannerStore
      .getState()
      .addTask(
        { title: "Standup", dueAt: NOW, repeat: { kind: "daily" } },
        NOW,
      );

    usePlannerStore
      .getState()
      .applyAgentRequest("m-1", "s", request({ complete: ["Standup"] }), NOW);

    const rolled = usePlannerStore.getState().tasks.find((t) => t.id === id);
    expect(rolled?.completedAt).toBeNull();
    expect(rolled?.dueAt).toBe(startOfLocalDay(TODAY + DAY));
  });

  it("says nothing about a title it cannot find", () => {
    const result = usePlannerStore
      .getState()
      .applyAgentRequest("m-1", "s", request({ complete: ["Nothing"] }), NOW);

    expect(result).toEqual({ added: 0, completed: 0 });
  });

  it("closes in the same message a task it opened there", () => {
    const result = usePlannerStore.getState().applyAgentRequest(
      "m-1",
      "s",
      request({
        add: [
          { title: "Quick one", dueAt: null, priority: "normal", repeat: null },
        ],
        complete: ["Quick one"],
      }),
      NOW,
    );

    expect(result).toEqual({ added: 1, completed: 1 });
    expect(usePlannerStore.getState().tasks[0].completedAt).toBe(NOW);
  });

  it("keeps the tombstone list bounded", () => {
    usePlannerStore.setState({
      tasks: [],
      appliedMessageIds: Array.from(
        { length: MAX_APPLIED_MESSAGE_IDS },
        (_, index) => `old-${index}`,
      ),
    });

    usePlannerStore.getState().applyAgentRequest(
      "newest",
      "s",
      request({
        add: [{ title: "X", dueAt: null, priority: "normal", repeat: null }],
      }),
      NOW,
    );

    const ids = usePlannerStore.getState().appliedMessageIds;
    expect(ids).toHaveLength(MAX_APPLIED_MESSAGE_IDS);
    expect(ids.at(-1)).toBe("newest");
    expect(ids).not.toContain("old-0");
  });
});
