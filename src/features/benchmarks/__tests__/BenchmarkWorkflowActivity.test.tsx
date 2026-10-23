import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSession, readHistoryPage } from "@/shared/api/acpApi";
import { benchmarkApi } from "../api/benchmarks";
import { useBenchmarkRuns } from "../hooks/useBenchmarks";
import type { RunSummary, WorkflowActivity } from "../types";
import { BenchmarkActivity } from "../ui/BenchmarkActivity";
import { BenchmarkRunDrawer } from "../ui/BenchmarkRunDrawer";
import { BenchmarkWorkflowActivity } from "../ui/BenchmarkWorkflowProgress";
import {
  attempt,
  configuration,
  definition,
  run,
  runSummary,
} from "./fixtures";

vi.mock("@/shared/api/acpApi", () => ({
  readHistoryPage: vi.fn(),
  loadSession: vi.fn(),
}));
vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: {
    listRuns: vi.fn(),
    getRun: vi.fn(),
    getWorkflowTrace: vi.fn(),
    listDefinitions: vi.fn(),
    listAttempts: vi.fn(),
    getInventory: vi.fn(),
    getCandidateObservations: vi.fn(),
    listWorkflowCampaigns: vi.fn(),
    pauseRun: vi.fn(),
    cancelRun: vi.fn(),
  },
}));

let client: QueryClient;
let summary: RunSummary;
const key = ["benchmarks", "runs"];
const onOpenRun = vi.fn();
const workflow = (): WorkflowActivity => ({
  rootAttemptId: "workflow-root",
  versionId: "version-1",
  phase: "preparing",
  outcome: null,
  steps: [
    {
      attemptId: "child-a",
      index: 0,
      phase: "terminal",
      outcome: "completed",
      startedAt: 1_000,
      finishedAt: 2_000,
      sessionId: "session-a",
      hostRunId: "turn-a",
      configuration,
    },
    {
      attemptId: "child-b",
      index: 1,
      phase: "running",
      outcome: null,
      startedAt: Date.now() - 65_000,
      finishedAt: null,
      sessionId: "session-b",
      hostRunId: "turn-b",
      configuration: {
        ...configuration,
        modelId: "worker-b",
        modelName: "Worker B",
      },
    },
  ],
});

function Surface({ kind }: { kind: "strip" | "drawer" }) {
  const runs = useBenchmarkRuns();
  return kind === "strip" ? (
    <BenchmarkActivity runs={runs.data ?? []} onOpenRun={onOpenRun} />
  ) : (
    <BenchmarkRunDrawer runId={run.id} onClose={vi.fn()} onEvidence={vi.fn()} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  summary = {
    ...runSummary,
    state: "pausing",
    attemptCount: 2,
    cellCount: 2,
    settledCount: 1,
    settledCellCount: 1,
    workflowActivity: [workflow()],
  };
  client.setQueryData(key, [summary]);
  vi.mocked(benchmarkApi.listRuns).mockImplementation(async () => [summary]);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue({
    ...run,
    state: "pausing",
    attempts: [
      {
        ...attempt,
        id: "workflow-root",
        phase: "preparing",
        outcome: null,
        // The full root still names completed child A. Only the projection
        // knows that B is working now; it must never fall back to A.
        sessionId: "session-a",
        hostRunId: "turn-a",
        finishedAt: null,
      },
      { ...attempt, id: "objective", versionId: "objective-version" },
    ],
  });
  vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([
    {
      ...definition,
      versions: [
        {
          ...definition.versions[0],
          manifest: {
            ...definition.versions[0].manifest,
            name: "Workflow task",
            workflow: {
              steps: ["a", "b", "c"].map((id) => ({ id })),
            },
          },
        },
      ],
    },
    {
      ...definition,
      id: "objective-definition",
      versions: [
        {
          ...definition.versions[0],
          id: "objective-version",
          manifest: { ...definition.draft, name: "Objective task" },
        },
      ],
    },
  ]);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([]);
  vi.mocked(benchmarkApi.getCandidateObservations).mockResolvedValue([]);
  vi.mocked(benchmarkApi.listWorkflowCampaigns).mockResolvedValue([]);
  vi.mocked(readHistoryPage).mockResolvedValue({
    events: [],
    olderCursor: null,
    highWaterEventId: 42,
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

function show(kind: "strip" | "drawer") {
  return render(
    <QueryClientProvider client={client}>
      <Surface kind={kind} />
    </QueryClientProvider>,
  );
}

async function update(roots: WorkflowActivity[]) {
  summary = { ...summary, workflowActivity: roots };
  await act(() => client.setQueryData(key, [summary]));
}

function subscribers(session: string) {
  return (
    client
      .getQueryCache()
      .find({ queryKey: ["benchmark-session-activity", session] })
      ?.getObserversCount() ?? 0
  );
}

describe.each([
  "strip",
  "drawer",
] as const)("ordinary workflow in %s", (kind) => {
  it("shows child B despite root A and keeps mixed-run counts and controls without loading traces", async () => {
    show(kind);
    expect(
      await screen.findByRole("img", { name: "Step 2 of 3 · Running" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Worker B")).toBeInTheDocument();
    expect(screen.getByText(/^1 \/ 2/)).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Settled tests" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeEnabled();
    expect(screen.getByText(/New workflows are paused/)).toBeInTheDocument();
    await waitFor(() =>
      expect(readHistoryPage).toHaveBeenCalledWith("session-b", 1),
    );
    expect(readHistoryPage).not.toHaveBeenCalledWith("session-a", 1);
    expect(benchmarkApi.getWorkflowTrace).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
    if (kind === "strip") {
      fireEvent.click(screen.getByRole("button", { name: /Workflow task/ }));
      expect(onOpenRun).toHaveBeenCalledExactlyOnceWith(run.id);
      expect(benchmarkApi.getRun).not.toHaveBeenCalled();
    }
  });

  it("switches B to C, drops B's cursor subscription and waits for the root verdict after all steps", async () => {
    show(kind);
    await screen.findByRole("img", { name: /No new events observed/ });
    expect(subscribers("session-b")).toBe(1);
    const root = workflow();
    root.steps[1] = {
      ...root.steps[1],
      phase: "terminal",
      outcome: "completed",
      finishedAt: Date.now(),
    };
    root.steps.push({
      ...root.steps[1],
      attemptId: "child-c",
      index: 2,
      phase: "running",
      outcome: null,
      sessionId: "session-c",
      hostRunId: "turn-c",
      startedAt: Date.now() - 2_000,
      finishedAt: null,
      configuration: {
        ...configuration,
        modelId: "worker-c",
        modelName: "Worker C",
      },
    });
    await update([root]);
    expect(
      await screen.findByRole("img", { name: "Step 3 of 3 · Running" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Worker C")).toBeInTheDocument();
    expect(screen.queryByText("Worker B")).not.toBeInTheDocument();
    expect(screen.getByTitle("Elapsed 2 s")).toBeInTheDocument();
    await waitFor(() =>
      expect(readHistoryPage).toHaveBeenCalledWith("session-c", 1),
    );
    expect(subscribers("session-b")).toBe(0);
    expect(subscribers("session-c")).toBe(1);
    root.phase = "collecting";
    root.steps = root.steps.map((step) => ({
      ...step,
      phase: "terminal",
      outcome: "completed",
      finishedAt: Date.now(),
    }));
    await update([root]);
    expect(
      await screen.findByRole("img", { name: "Step 3 of 3 · Grading" }),
    ).toBeInTheDocument();
    const progress =
      screen.getByText("Workflow task").parentElement?.parentElement;
    expect(progress?.querySelector('[data-dot="passed"]')).toBeNull();
    expect(progress?.querySelector('[data-dot="running"]')).not.toBeNull();
    expect(subscribers("session-c")).toBe(0);
    expect(screen.getByText(/^1 \/ 2/)).toBeInTheDocument();
    expect(benchmarkApi.getWorkflowTrace).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it("uses one existing summary query and marks a failed refresh unavailable", async () => {
    show(kind);
    await screen.findByRole("img", { name: /No new events observed/ });
    expect(benchmarkApi.listRuns).toHaveBeenCalledTimes(1);
    vi.mocked(benchmarkApi.listRuns).mockRejectedValue(
      new Error("invented read failure"),
    );
    await act(() => client.refetchQueries({ queryKey: key }));
    expect(
      await screen.findByText(/Activity check unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /No new events observed/ }),
    ).not.toBeInTheDocument();
    expect(subscribers("session-b")).toBe(0);
    expect(benchmarkApi.listRuns).toHaveBeenCalledTimes(2);
    expect(benchmarkApi.getWorkflowTrace).not.toHaveBeenCalled();
  });

  it("does not invent a completed workflow or use the root session when summary metadata is absent", async () => {
    summary = { ...summary, workflowActivity: undefined };
    client.setQueryData(key, [summary]);
    show(kind);
    await screen.findByText(/^1 \/ 2/);
    expect(
      screen.queryByRole("img", { name: /^Step / }),
    ).not.toBeInTheDocument();
    expect(readHistoryPage).not.toHaveBeenCalled();
    expect(benchmarkApi.getWorkflowTrace).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it("keeps an entered workflow without a saved child unknown and never observes root session A", async () => {
    summary = { ...summary, workflowActivity: [{ ...workflow(), steps: [] }] };
    client.setQueryData(key, [summary]);
    show(kind);
    await screen.findByRole("img", { name: "Step 1 of 3 · Preparing" });
    const progress =
      screen.getByText("Workflow task").parentElement?.parentElement;
    expect(progress?.querySelector('[data-dot="passed"]')).toBeNull();
    expect(progress?.querySelector('[data-dot="queued"]')).not.toBeNull();
    expect(progress?.querySelector('[title^="Elapsed"]')).toBeNull();
    expect(readHistoryPage).not.toHaveBeenCalled();
    expect(benchmarkApi.getWorkflowTrace).not.toHaveBeenCalled();
  });
});

it("does not show cached running workflow activity after the drawer's run has paused", async () => {
  vi.mocked(benchmarkApi.getRun).mockResolvedValue({ ...run, state: "paused" });
  show("drawer");
  await screen.findByText("Paused");
  expect(screen.queryByRole("img", { name: /^Step / })).not.toBeInTheDocument();
  expect(readHistoryPage).not.toHaveBeenCalled();
});

it("keeps admitted child activity visible in a drawer whose other work needs attention", async () => {
  const current = await benchmarkApi.getRun(run.id);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue({
    ...current,
    state: "needs_attention",
  });
  summary = { ...summary, state: "needs_attention" };
  client.setQueryData(key, [summary]);
  show("drawer");
  await screen.findByRole("img", { name: "Step 2 of 3 · Running" });
  expect(screen.getByText("Needs attention")).toBeInTheDocument();
  await waitFor(() =>
    expect(readHistoryPage).toHaveBeenCalledWith("session-b", 1),
  );
  expect(benchmarkApi.getWorkflowTrace).not.toHaveBeenCalled();
});

it("keeps unknown authored totals unknown and bounds the compact strip to entered roots", async () => {
  vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([]);
  summary.workflowActivity = Array.from({ length: 10 }, (_, index) => ({
    ...workflow(),
    rootAttemptId: `root-${index}`,
  }));
  render(
    <QueryClientProvider client={client}>
      <BenchmarkWorkflowActivity run={summary} compact />
    </QueryClientProvider>,
  );
  expect(
    await screen.findAllByRole("img", { name: "Step 2 · Running" }),
  ).toHaveLength(3);
  expect(screen.getByText("+7")).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: /of 3/ })).not.toBeInTheDocument();
  expect(benchmarkApi.getRun).not.toHaveBeenCalled();
  expect(benchmarkApi.getWorkflowTrace).not.toHaveBeenCalled();
  expect(benchmarkApi.listRuns).not.toHaveBeenCalled();
});

it.each([
  "paused",
  "completed",
  "cancelled",
])("does not observe a retained old child on a %s run", (state) => {
  render(
    <QueryClientProvider client={client}>
      <BenchmarkWorkflowActivity run={{ ...summary, state }} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("img", { name: /^Step / })).not.toBeInTheDocument();
  expect(readHistoryPage).not.toHaveBeenCalled();
});
