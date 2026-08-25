import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { startOfLocalDay, type PlannerTask } from "../../lib/plannerTask";
import { usePlannerStore } from "../../stores/plannerStore";
import { PlannerPanel } from "../PlannerPanel";

const DAY = 24 * 60 * 60 * 1000;

function task(overrides: Partial<PlannerTask> = {}): PlannerTask {
  const now = Date.now();
  return {
    id: overrides.id ?? "t-1",
    title: "A task",
    createdAt: now,
    dueAt: null,
    completedAt: null,
    priority: "normal",
    repeat: null,
    ...overrides,
  };
}

function seed(tasks: PlannerTask[]) {
  usePlannerStore.getState().replaceAll(tasks);
}

function titlesOnScreen(): string[] {
  return screen
    .queryAllByTestId("planner-task")
    .map((row) => row.textContent ?? "");
}

describe("PlannerPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    seed([]);
  });

  it("opens on today's work and says so when there is none", () => {
    renderWithProviders(<PlannerPanel />);

    expect(screen.getByTestId("planner-tab-today")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("planner-empty")).toBeInTheDocument();
  });

  it("adds a task from the composer row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlannerPanel />);

    await user.type(screen.getByTestId("planner-add-title"), "Buy milk");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(usePlannerStore.getState().tasks).toHaveLength(1);
    expect(usePlannerStore.getState().tasks[0].title).toBe("Buy milk");
  });

  it("keeps late and due work apart under Today", () => {
    const today = startOfLocalDay(Date.now());
    seed([
      task({ id: "late", title: "Late thing", dueAt: today - DAY }),
      task({ id: "now", title: "Today thing", dueAt: today }),
      task({ id: "soon", title: "Future thing", dueAt: today + 3 * DAY }),
    ]);
    renderWithProviders(<PlannerPanel />);

    // "Today" names both a tab and a group, so headings are matched by role.
    expect(
      screen.getByRole("heading", { name: "Overdue" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    const shown = titlesOnScreen().join(" ");
    expect(shown).toContain("Late thing");
    expect(shown).toContain("Today thing");
    // The future belongs to Scheduled; Today is a working list.
    expect(shown).not.toContain("Future thing");
  });

  it("moves to the future when Scheduled is chosen", async () => {
    const user = userEvent.setup();
    const today = startOfLocalDay(Date.now());
    seed([
      task({ id: "now", title: "Today thing", dueAt: today }),
      task({ id: "soon", title: "Future thing", dueAt: today + 3 * DAY }),
    ]);
    renderWithProviders(<PlannerPanel />);

    await user.click(screen.getByTestId("planner-tab-scheduled"));

    expect(titlesOnScreen().join(" ")).toContain("Future thing");
    expect(titlesOnScreen().join(" ")).not.toContain("Today thing");
  });

  it("ticks a one-off off the open list and into Completed", async () => {
    const user = userEvent.setup();
    const today = startOfLocalDay(Date.now());
    seed([task({ id: "one", title: "One-off", dueAt: today })]);
    renderWithProviders(<PlannerPanel />);

    await user.click(screen.getByRole("button", { name: "Mark done" }));

    expect(usePlannerStore.getState().tasks[0].completedAt).not.toBeNull();
    await user.click(screen.getByTestId("planner-tab-completed"));
    expect(titlesOnScreen().join(" ")).toContain("One-off");
  });

  it("rolls a repeating task forward instead of archiving it", async () => {
    const user = userEvent.setup();
    const today = startOfLocalDay(Date.now());
    seed([
      task({
        id: "daily",
        title: "Standup",
        dueAt: today,
        repeat: { kind: "daily" },
      }),
    ]);
    renderWithProviders(<PlannerPanel />);

    await user.click(screen.getByRole("button", { name: "Mark done" }));

    const rolled = usePlannerStore.getState().tasks[0];
    expect(rolled.completedAt).toBeNull();
    expect(rolled.dueAt).toBe(startOfLocalDay(today + DAY));
  });

  it("raises and lowers a task's priority in place", async () => {
    const user = userEvent.setup();
    const today = startOfLocalDay(Date.now());
    seed([task({ id: "one", title: "Plain", dueAt: today })]);
    renderWithProviders(<PlannerPanel />);

    await user.click(
      screen.getByRole("button", { name: "Toggle high priority" }),
    );
    expect(usePlannerStore.getState().tasks[0].priority).toBe("high");
    expect(screen.getByTestId("planner-high")).toBeInTheDocument();
  });

  it("shows where an agent-created task came from", () => {
    const today = startOfLocalDay(Date.now());
    seed([
      task({
        id: "agent",
        title: "From the conductor",
        dueAt: today,
        createdBySessionId: "session-1",
      }),
    ]);
    renderWithProviders(<PlannerPanel />);

    const row = screen.getByTestId("planner-task");
    expect(within(row).getByTestId("planner-from-agent")).toBeInTheDocument();
  });

  it("offers weekday choices only for a weekly repeat", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlannerPanel />);

    expect(screen.queryByTestId("planner-weekdays")).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByTestId("planner-add-repeat"),
      "weekly",
    );
    expect(screen.getByTestId("planner-weekdays")).toBeInTheDocument();
  });

  it("counts each tab as what that tab renders", () => {
    const today = startOfLocalDay(Date.now());
    seed([
      task({ id: "a", dueAt: today }),
      task({ id: "b", dueAt: today - DAY }),
      task({ id: "c", dueAt: today + 5 * DAY }),
      task({ id: "d", completedAt: Date.now() }),
    ]);
    renderWithProviders(<PlannerPanel />);

    expect(screen.getByTestId("planner-tab-today")).toHaveTextContent("2");
    expect(screen.getByTestId("planner-tab-scheduled")).toHaveTextContent("1");
    expect(screen.getByTestId("planner-tab-completed")).toHaveTextContent("1");
  });
});
