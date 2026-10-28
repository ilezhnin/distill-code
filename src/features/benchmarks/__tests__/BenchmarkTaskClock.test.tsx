import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activityElapsed } from "../lib/benchmarkTaskTiming";
import { type CellAttempt, TaskGrid, taskCells } from "../ui/BenchmarkTaskGrid";
import type { ActivitySpan } from "../types";

const start = Date.UTC(2026, 0, 1, 12);
const order = [{ id: "example", name: "Example" }];
const span = (
  kind: ActivitySpan["kind"],
  from: number,
  to: number | null,
): ActivitySpan => ({
  kind,
  startedAt: start + from,
  finishedAt: to == null ? null : start + to,
});
const attempt = (overrides: Partial<CellAttempt> = {}): CellAttempt => ({
  id: "first",
  versionId: "example",
  repetition: 0,
  phase: "awaiting_judges",
  outcome: null,
  startedAt: start,
  finishedAt: start + 32_000,
  durationMs: 32_000,
  cost: 0.01,
  activity: {
    recordedFrom: start,
    spans: [span("execution", 0, 32_000), span("waiting", 32_000, null)],
  },
  reason: "Waiting for local resources: CPU admission",
  ...overrides,
});
const grid = (attempts: CellAttempt[], clockAt?: number) => (
  <TaskGrid
    cells={taskCells(order, attempts, "running", 0)}
    timing="elapsed"
    clockAt={clockAt}
    onOpen={vi.fn()}
  />
);
const work = () =>
  screen.getByTitle(/^Active task time across all repetitions/);
const wait = () =>
  screen.getByTitle(/^Recorded waiting time across all repetitions/);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start + 4 * 3_600_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("ticks waiting beside the yellow label while active work stays fixed, including reopening", () => {
  render(grid([attempt()]));
  expect(screen.getByText("Waiting for resources")).toBeInTheDocument();
  expect(work()).toHaveTextContent(/^32 s$/);
  expect(wait()).toHaveTextContent("3:59:28");
  act(() => vi.advanceTimersByTime(120_000));
  expect(work()).toHaveTextContent(/^32 s$/);
  expect(wait()).toHaveTextContent("4:01:28");
  cleanup();
  render(grid([attempt()]));
  expect(work()).toHaveTextContent(/^32 s$/);
  expect(wait()).toHaveTextContent("4:01:28");
});

it("continues only active work after waiting ends and fixes it when the task settles", () => {
  const running = attempt({
    reason: null,
    evaluations: [
      {
        id: "invented-judge",
        evaluatorRevision: "1",
        verdict: "pending_review",
        score: null,
        reason: "",
        createdAt: start + 4 * 3_600_000,
        provenance: "judge",
        artifacts: [],
        details: { inFlight: true },
      },
    ],
    activity: {
      recordedFrom: start,
      spans: [
        span("execution", 0, 32_000),
        span("waiting", 32_000, 4 * 3_600_000),
        span("execution", 4 * 3_600_000, null),
      ],
    },
  });
  const { rerender } = render(grid([running]));
  expect(screen.getByText("Judges")).toBeInTheDocument();
  expect(work()).toHaveTextContent(/^32 s$/);
  act(() => vi.advanceTimersByTime(10_000));
  expect(work()).toHaveTextContent(/^42 s$/);
  rerender(
    grid([
      {
        ...running,
        phase: "terminal",
        outcome: "fail",
        score: 0,
        activity: {
          recordedFrom: start,
          spans: [
            span("execution", 0, 32_000),
            span("waiting", 32_000, 4 * 3_600_000),
            span("execution", 4 * 3_600_000, 4 * 3_600_000 + 10_000),
          ],
        },
      },
    ]),
  );
  expect(work()).toHaveTextContent(/^42 s$/);
  act(() => vi.advanceTimersByTime(60_000));
  expect(work()).toHaveTextContent(/^42 s$/);
});

it("counts parallel repetitions once and excludes gaps between sequential repetitions", () => {
  render(
    grid([
      attempt({
        activity: {
          recordedFrom: start,
          spans: [span("execution", 0, 30_000)],
        },
      }),
      attempt({
        id: "parallel",
        repetition: 1,
        activity: {
          recordedFrom: start,
          spans: [span("execution", 10_000, 40_000)],
        },
      }),
      attempt({
        id: "later",
        repetition: 2,
        activity: {
          recordedFrom: start,
          spans: [span("execution", 3_600_000, 3_620_000)],
        },
      }),
      attempt({
        id: "discarded",
        outcome: "superseded",
        activity: { recordedFrom: start, spans: [span("execution", 0, null)] },
      }),
    ]),
  );
  expect(work()).toHaveTextContent(/^1:00$/);
});

it("does not classify time as idle when another repetition is working", () => {
  const times = activityElapsed(
    {
      execution: [
        span("execution", 0, 20_000),
        span("execution", 10_000, 30_000),
      ],
      waiting: [span("waiting", 0, 40_000), span("waiting", 35_000, 50_000)],
      partial: false,
    },
    start + 50_000,
  );
  expect(times).toEqual({ execution: 30_000, waiting: 20_000 });
});

it("holds both clocks at a persisted pause and excludes the pause after resuming", () => {
  const { rerender } = render(grid([attempt()], start + 3_600_000));
  expect(work()).toHaveTextContent(/^32 s$/);
  expect(wait()).toHaveTextContent("59:28");
  act(() => vi.advanceTimersByTime(60_000));
  expect(wait()).toHaveTextContent("59:28");
  rerender(
    grid([
      attempt({
        activity: {
          recordedFrom: start,
          spans: [
            span("execution", 0, 32_000),
            span("waiting", 32_000, 3_600_000),
            span("waiting", 4 * 3_600_000, null),
          ],
        },
      }),
    ]),
  );
  expect(work()).toHaveTextContent(/^32 s$/);
  expect(wait()).toHaveTextContent("1:00:28");
});

it("uses only confirmed work for old attempts and never fabricates a historic wait", () => {
  render(grid([attempt({ activity: undefined })]));
  expect(
    screen.getByTitle(/^Recorded active time, excluding waiting/),
  ).toHaveTextContent("≥ 32 s");
  expect(
    screen.getByTitle("This earlier waiting interval was not recorded"),
  ).toHaveTextContent("–");
  act(() => vi.advanceTimersByTime(3_600_000));
  expect(
    screen.getByTitle(/^Recorded active time, excluding waiting/),
  ).toHaveTextContent("≥ 32 s");
});

it("leaves an unstarted task's execution unknown while its recorded queue clock ticks", () => {
  render(
    grid([
      attempt({
        phase: "pending",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        activity: { recordedFrom: start, spans: [span("waiting", 0, null)] },
      }),
    ]),
  );
  expect(work()).toHaveTextContent("–");
  expect(wait()).toHaveTextContent("4:00:00");
});

it("keeps the generation median as the separate model speed statistic", () => {
  render(
    <TaskGrid
      cells={taskCells(
        order,
        [attempt({ phase: "terminal", outcome: "pass", score: 1 })],
        "completed",
        0,
      )}
      onOpen={vi.fn()}
    />,
  );
  expect(
    screen.getByTitle("Median model execution time per repetition"),
  ).toHaveTextContent("32 s");
});
