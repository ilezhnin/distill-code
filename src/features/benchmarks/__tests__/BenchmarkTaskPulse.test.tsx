import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type CellAttempt,
  taskCells,
  TaskGrid,
  TaskSummary,
} from "../ui/BenchmarkTaskGrid";
import { RepetitionDots } from "../ui/BenchmarkTestStatus";

const order = [{ id: "invented-case", name: "Invented case", number: 1 }];
function attempt(phase: string): CellAttempt {
  return {
    id: "invented-attempt",
    versionId: order[0].id,
    repetition: 0,
    phase,
    outcome: null,
    startedAt: 1_000,
    finishedAt: null,
    durationMs: 2_000,
    cost: 0.01,
    evaluations:
      phase === "awaiting_judges"
        ? [
            {
              id: "invented-judge",
              evaluatorRevision: "1",
              verdict: "pending_review",
              score: null,
              reason: "",
              createdAt: 4_000,
              provenance: "judge",
              artifacts: [],
              details: { inFlight: true },
            },
          ]
        : [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([
  "running",
  "collecting",
  "awaiting_judges",
])("keeps %s evidence and counts while pausing and resuming its blue dot", (phase) => {
  const attempts = [attempt(phase)];
  const open = vi.fn();
  const live = taskCells(order, attempts, "running");
  const view = render(
    <>
      <TaskSummary cells={live} />
      <TaskGrid cells={live} onOpen={open} />
    </>,
  );
  const dot = () => view.container.querySelector('[data-dot="running"]');
  const summary = view.container.querySelector("dl")?.textContent;
  const repetitions = screen.getByRole("img").getAttribute("aria-label");
  expect(dot()).toHaveClass("bg-info", "animate-pulse");
  const paused = taskCells(order, attempts, "paused");
  expect(paused[0].status?.kind).toBe("paused");
  expect(paused[0].dots).toEqual(live[0].dots);
  expect(paused[0].attemptIds).toEqual(live[0].attemptIds);
  expect(paused[0].cost).toBe(live[0].cost);
  expect(paused[0].durationMs).toBe(live[0].durationMs);
  view.rerender(
    <>
      <TaskSummary cells={paused} />
      <TaskGrid cells={paused} onOpen={open} />
    </>,
  );
  expect(dot()).toHaveClass("bg-info");
  expect(dot()).not.toHaveClass("animate-pulse");
  expect(screen.getByText("Paused")).toBeInTheDocument();
  expect(view.container.querySelector("dl")?.textContent).toBe(summary);
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", repetitions);
  fireEvent.click(
    screen.getByRole("button", { name: "Task 1: Invented case" }),
  );
  expect(open).toHaveBeenLastCalledWith(paused[0]);
  view.rerender(<TaskGrid cells={live} onOpen={open} />);
  expect(dot()).toHaveClass("bg-info", "animate-pulse");
  view.rerender(<TaskGrid cells={live} onOpen={open} clockAt={3_000} />);
  expect(dot()).toHaveClass("bg-info");
  expect(dot()).not.toHaveClass("animate-pulse");
});

it.each([
  "running",
  "collecting",
  "awaiting_judges",
])("keeps a %s resource wait static until actual work resumes", (phase) => {
  const waiting = taskCells(
    order,
    [
      {
        ...attempt(phase),
        reason: "Waiting for local resources to evaluate",
        waitUntil: 10_000,
      },
    ],
    "running",
  );
  expect(waiting[0].status?.kind).toBe("waiting");
  const open = vi.fn();
  const view = render(<TaskGrid cells={waiting} onOpen={open} />);
  expect(screen.getByText("Waiting for resources")).toBeInTheDocument();
  const dot = () => view.container.querySelector('[data-dot="running"]');
  expect(dot()).toHaveClass("bg-info");
  expect(dot()).not.toHaveClass("animate-pulse");
  fireEvent.click(screen.getByRole("button"));
  expect(open).toHaveBeenLastCalledWith(waiting[0]);
  const live = taskCells(order, [attempt(phase)], "running");
  expect(live[0].dots).toEqual(waiting[0].dots);
  expect(live[0].attemptIds).toEqual(waiting[0].attemptIds);
  view.rerender(<TaskGrid cells={live} onOpen={open} />);
  expect(dot()).toHaveClass("bg-info", "animate-pulse");
});

it("does not animate a settled answer that still has no panel verdict", () => {
  const cells = taskCells(
    order,
    [{ ...attempt("terminal"), outcome: "pending_review", finishedAt: 3_000 }],
    "running",
  );
  expect(cells[0].status?.kind).toBe("unscored");
  expect(cells[0].clock).toBe(false);
  const open = vi.fn();
  const view = render(<TaskGrid cells={cells} onOpen={open} />);
  const dot = view.container.querySelector('[data-dot="stopped"]');
  expect(dot).not.toHaveClass("bg-info");
  expect(dot).not.toHaveClass("animate-pulse");
  fireEvent.click(screen.getByRole("button"));
  expect(open).toHaveBeenCalledWith(cells[0]);
});

it("preserves the default animation for other repetition-dot callers", () => {
  const view = render(
    <RepetitionDots states={["running", "passed", "failed"]} />,
  );
  expect(view.container.querySelector('[data-dot="running"]')).toHaveClass(
    "bg-info",
    "animate-pulse",
  );
  expect(view.container.querySelector('[data-dot="passed"]')).toHaveClass(
    "bg-success",
  );
  expect(view.container.querySelector('[data-dot="failed"]')).toHaveClass(
    "bg-destructive",
  );
});
