import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readHistoryPage } from "@/shared/api/acpApi";
import { benchmarkApi } from "../api/benchmarks";
import { observeActivity } from "../hooks/useBenchmarkSessionActivity";
import { BenchmarkWorkflowProgress } from "../ui/BenchmarkWorkflowProgress";
import type { WorkflowTrace } from "../types";
import { attempt, definition, run } from "./fixtures";

vi.mock("@/shared/api/acpApi", () => ({ readHistoryPage: vi.fn() }));
vi.mock("../api/benchmarks", () => ({
  benchmarkApi: {
    getRun: vi.fn(),
    getWorkflowTrace: vi.fn(),
    listDefinitions: vi.fn(),
  },
}));

let client: QueryClient;
const root = {
  ...attempt,
  phase: "preparing",
  outcome: null,
  finishedAt: null,
};
const trace: WorkflowTrace = {
  root,
  policy: null,
  steps: [
    {
      index: 0,
      id: "first",
      parentId: null,
      entry: {} as WorkflowTrace["steps"][number]["entry"],
      prompt: "",
      inputHash: null,
      executorDecision: null,
      attempt: { ...attempt, outcome: "completed" },
    },
    {
      index: 1,
      id: "second",
      parentId: "first",
      entry: {} as WorkflowTrace["steps"][number]["entry"],
      prompt: "",
      inputHash: null,
      executorDecision: null,
      attempt: {
        ...attempt,
        id: "second-attempt",
        phase: "running",
        outcome: null,
        finishedAt: null,
        sessionId: "owned-session",
        hostRunId: "owned-turn",
        startedAt: Date.now() - 65_000,
      },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(benchmarkApi.getRun).mockResolvedValue({
    ...run,
    state: "pausing",
    attempts: [root],
  });
  vi.mocked(benchmarkApi.getWorkflowTrace).mockResolvedValue(trace);
  vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([
    {
      ...definition,
      versions: definition.versions.map((v) => ({
        ...v,
        manifest: {
          ...v.manifest,
          workflow: {
            schemaVersion: 1,
            driverRevision: "test",
            steps: ["first", "second"].map((id) => ({
              id,
              prompt: "",
              includePreviousOutput: false,
            })),
          },
        },
      })),
    },
  ]);
  vi.mocked(readHistoryPage).mockResolvedValue({
    events: [],
    olderCursor: null,
    highWaterEventId: 42,
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show() {
  return render(
    <QueryClientProvider client={client}>
      <BenchmarkWorkflowProgress runId={run.id} />
    </QueryClientProvider>,
  );
}

it("shows internal step completion, elapsed time and the draining reason without replaying a session", async () => {
  const { container } = show();
  const steps = await screen.findByRole("img", {
    name: "Step 2 of 2 · Running",
  });
  expect(steps.querySelectorAll("rect")).toHaveLength(2);
  expect(steps.querySelector("rect.fill-success")).not.toBeNull();
  expect(steps.querySelector("rect.fill-info")).not.toBeNull();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(container.querySelector('[data-dot="running"]')).not.toBeNull();
  expect(screen.getByText("Running")).toBeInTheDocument();
  expect(screen.getByTitle(/Elapsed 1:/)).toBeInTheDocument();
  expect(screen.getByText(/New workflows are paused/)).toBeInTheDocument();
  await waitFor(() =>
    expect(readHistoryPage).toHaveBeenCalledWith("owned-session", 1),
  );
  expect(
    await screen.findByRole("img", { name: /No new events observed/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("img", { name: /Activity seen/ }),
  ).not.toBeInTheDocument();
});

it("only new native events establish activity; a failed read never pretends the model is active", async () => {
  show();
  await screen.findByRole("img", { name: /No new events observed/ });
  vi.mocked(readHistoryPage).mockResolvedValue({
    events: [],
    olderCursor: null,
    highWaterEventId: 43,
  });
  await client.refetchQueries({
    queryKey: ["benchmark-session-activity", "owned-session"],
  });
  expect(
    await screen.findByRole("img", { name: /Activity seen/ }),
  ).toBeInTheDocument();
  vi.mocked(readHistoryPage).mockRejectedValue(
    new Error("transport unavailable"),
  );
  await client.refetchQueries({
    queryKey: ["benchmark-session-activity", "owned-session"],
  });
  expect(
    await screen.findByRole("img", { name: /Activity check unavailable/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("img", { name: /Activity seen/ }),
  ).not.toBeInTheDocument();
});

it("keeps step completion separate from final grading", async () => {
  vi.mocked(benchmarkApi.getWorkflowTrace).mockResolvedValue({
    ...trace,
    steps: trace.steps.map((step) => ({
      ...step,
      attempt: { ...step.attempt, phase: "terminal", outcome: "completed" },
    })),
  });
  const { container } = show();
  expect(await screen.findByText("Grading")).toBeInTheDocument();
  expect(container.querySelector('[data-dot="passed"]')).toBeNull();
  expect(readHistoryPage).not.toHaveBeenCalled();
});

it("does not reset the quiet clock on successful polls or label old history as fresh activity", () => {
  const first = observeActivity(undefined, 100, 1_000);
  const quiet = observeActivity(first, 100, 601_000);
  expect(quiet.activitySeenAt).toBeNull();
  expect(quiet.unchangedSince).toBe(1_000);
  const active = observeActivity(quiet, 101, 602_000);
  expect(active.activitySeenAt).toBe(602_000);
  expect(observeActivity(active, 101, 603_000).activitySeenAt).toBe(602_000);
  expect(observeActivity(active, 1, 604_000).activitySeenAt).toBeNull();
});

it("updates queued cards, step activity and final verdicts without focusing the window or opening a drawer", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(false);
  const queued = {
    ...trace,
    steps: [
      {
        ...trace.steps[0],
        attempt: { ...root, sessionId: null, hostRunId: null },
      },
    ],
  };
  vi.mocked(benchmarkApi.getRun).mockResolvedValue({
    ...run,
    state: "running",
    attempts: [root],
  });
  vi.mocked(benchmarkApi.getWorkflowTrace).mockResolvedValue(queued);
  const { container } = render(
    <QueryClientProvider client={client}>
      <BenchmarkWorkflowProgress runId={run.id} />
      <BenchmarkWorkflowProgress runId="another-run" />
    </QueryClientProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(container.querySelectorAll('[data-dot="queued"]')).toHaveLength(2);
  vi.mocked(benchmarkApi.getWorkflowTrace).mockResolvedValue(trace);
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(container.querySelectorAll('[data-dot="running"]')).toHaveLength(2);
  expect(readHistoryPage).toHaveBeenCalledWith("owned-session", 1);
  vi.mocked(readHistoryPage).mockResolvedValue({
    events: [],
    olderCursor: null,
    highWaterEventId: 43,
  });
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(screen.getAllByRole("img", { name: /Activity seen/ })).toHaveLength(2);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue({
    ...run,
    state: "completed",
    attempts: [{ ...root, phase: "terminal", outcome: "pass" }],
  });
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(container.querySelectorAll('[data-dot="passed"]')).toHaveLength(2);
  expect(focusManager.isFocused()).toBe(false);
});
