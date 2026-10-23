import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskGrid, type TaskCell } from "../ui/BenchmarkTaskGrid";

const repetitions = vi.hoisted(() => vi.fn());
vi.mock("../ui/BenchmarkTestStatus", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../ui/BenchmarkTestStatus")>();
  return {
    ...original,
    RepetitionDots: (props: { states: string[] }) => {
      repetitions(props.states);
      return <span>{props.states.join(",")}</span>;
    },
  };
});

function cell(index: number, live = false): TaskCell {
  return {
    versionId: `invented-${index}`,
    number: index + 1,
    name: `Invented ${index}`,
    status: live ? { kind: "running", startedAt: 10_000 } : null,
    durationMs: 2_000,
    activity: {
      execution: [{ startedAt: 10_000, finishedAt: live ? null : 12_000 }],
      waiting: [],
      partial: false,
    },
    clock: live,
    cost: 0.01,
    attemptIds: [`attempt-${index}`],
    dots: [live ? "running" : "passed"],
    verdict: live ? "running" : "solved",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(15_000);
  repetitions.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("updates a live clock without rendering the pool's settled cards each second", () => {
  const cells = Array.from({ length: 200 }, (_, index) =>
    cell(index, index === 0),
  );
  render(<TaskGrid cells={cells} onOpen={vi.fn()} />);
  expect(screen.getByText("5 s")).toBeInTheDocument();
  repetitions.mockClear();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByText("6 s")).toBeInTheDocument();
  expect(repetitions).toHaveBeenCalledTimes(1);
  expect(repetitions).toHaveBeenCalledWith(cells[0].dots);
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByText("7 s")).toBeInTheDocument();
  expect(repetitions).toHaveBeenCalledTimes(2);
});

it("freezes at a recorded pause and resumes live clocks while keeping fresh evidence handlers", () => {
  const cells = [cell(0, true), cell(1)];
  const oldOpen = vi.fn();
  const view = render(
    <TaskGrid cells={cells} onOpen={oldOpen} clockAt={13_000} />,
  );
  expect(screen.getByText("3 s")).toBeInTheDocument();
  repetitions.mockClear();
  act(() => vi.advanceTimersByTime(2_000));
  expect(screen.getByText("3 s")).toBeInTheDocument();
  expect(repetitions).not.toHaveBeenCalled();
  const newOpen = vi.fn();
  view.rerender(<TaskGrid cells={cells} onOpen={newOpen} />);
  expect(screen.getByText("7 s")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Task 1: Invented 0" }));
  expect(newOpen).toHaveBeenCalledWith(cells[0]);
  expect(oldOpen).not.toHaveBeenCalled();
  repetitions.mockClear();
  act(() => vi.advanceTimersByTime(1_000));
  expect(screen.getByText("8 s")).toBeInTheDocument();
  expect(repetitions).toHaveBeenCalledTimes(1);
});

it("reuses equal cases across recalculated and reordered history without hiding changed evidence", () => {
  const cells = Array.from({ length: 200 }, (_, index) => cell(index));
  const open = vi.fn();
  const view = render(<TaskGrid cells={cells} onOpen={open} />);
  repetitions.mockClear();
  const next = structuredClone(cells).reverse();
  next[0] = {
    ...next[0],
    name: "Revised case",
    cost: 0.25,
    attemptIds: ["revised-evidence"],
    dots: ["failed"],
    verdict: "failed",
    status: { kind: "unscored", outcome: "fail", durationMs: 4_000 },
    durationMs: 4_000,
    activity: {
      execution: [{ startedAt: 10_000, finishedAt: 14_000 }],
      waiting: [{ startedAt: 8_000, finishedAt: 10_000 }],
      partial: true,
    },
  };
  view.rerender(<TaskGrid cells={next} onOpen={open} />);
  expect(repetitions).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("button")[0]).toHaveAccessibleName(
    "Task 200: Revised case",
  );
  expect(screen.getByText("4 s")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Task 200: Revised case" }),
  );
  expect(open).toHaveBeenLastCalledWith(next[0]);
  fireEvent.click(screen.getByRole("button", { name: "Task 1: Invented 0" }));
  expect(open).toHaveBeenLastCalledWith(cells[0]);
  repetitions.mockClear();
  view.rerender(<TaskGrid cells={structuredClone(next)} onOpen={open} />);
  expect(repetitions).not.toHaveBeenCalled();
});

it("updates a case when only its recorded activity or evidence changes", () => {
  const original = cell(0);
  const open = vi.fn();
  const view = render(
    <TaskGrid cells={[original]} onOpen={open} timing="elapsed" />,
  );
  expect(screen.getByText("2 s")).toBeInTheDocument();
  const next = structuredClone(original);
  next.activity.execution[0].finishedAt = 13_000;
  repetitions.mockClear();
  view.rerender(<TaskGrid cells={[next]} onOpen={open} timing="elapsed" />);
  expect(repetitions).toHaveBeenCalledTimes(1);
  expect(screen.getByText("3 s")).toBeInTheDocument();
  const newEvidence = { ...next, attemptIds: ["another-attempt"] };
  view.rerender(
    <TaskGrid cells={[newEvidence]} onOpen={open} timing="elapsed" />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(open).toHaveBeenLastCalledWith(newEvidence);
});
