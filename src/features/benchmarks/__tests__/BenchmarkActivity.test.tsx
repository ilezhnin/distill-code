import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  type RenderOptions,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RunSummary } from "../types";
import { BenchmarkActivity } from "../ui/BenchmarkActivity";
import { configuration, leaderboardRow, runSummary } from "./fixtures";
import type { WorkflowCampaign } from "../lib/workflowCampaign";

const campaignState = vi.hoisted(() => ({ data: [] as WorkflowCampaign[] }));

vi.mock("../hooks/useBenchmarks", () => ({
  benchmarkKeys: ["benchmarks"],
  modelNameKey: (entry: { modelId: string }) => entry.modelId,
  useModelNames: () => new Map([["model-1", "Model One"]]),
  useWorkflowCampaigns: () => campaignState,
}));

const api = vi.hoisted(() => ({
  pauseRun: vi.fn(async () => ({})),
  resumeRun: vi.fn(async () => ({})),
  cancelRun: vi.fn(async () => ({})),
}));

vi.mock("../api/benchmarks", () => ({
  benchmarkApi: api,
  benchmarkErrorMessage: String,
}));

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

/** The strip steers runs through the query client, so every render has one. */
const render = (ui: ReactElement, options?: RenderOptions) =>
  renderBare(ui, { wrapper: Providers, ...options });

const many = [1, 2, 3, 4, 5].map((n) => ({
  ...configuration,
  id: `config-${n}`,
  modelId: `model-${n}`,
  effort: n === 1 ? "max" : "default",
}));

function show(run: Partial<RunSummary>) {
  render(
    <BenchmarkActivity
      runs={[{ ...runSummary, state: "running", ...run }]}
      onOpenRun={vi.fn()}
    />,
  );
  // The row opens the run; its controls follow it.
  return within(screen.getAllByRole("button")[0]);
}

afterEach(() => {
  cleanup();
  campaignState.data = [];
});

it("keeps judge failures visible while the run continues other tests", () => {
  const reason = "Judging failed: Invented worker failure";
  show({ attention: { outcome: "pending_review", reason } });
  expect(screen.getByTitle(reason)).toBeVisible();
  expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
});

it("does not label an active run without failures as needing attention", () => {
  show({ attention: null });
  expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
});

it("distinguishes a failed attempt from the run continuing other tests", () => {
  const reason = "Invented local memory reservation refused";
  show({ attention: { outcome: "resource_busy", reason } });
  expect(screen.getByTitle(reason)).toHaveTextContent(
    `The run continues with other tests. An attempt needs attention: ${reason}`,
  );
  expect(screen.queryByText(/Resume to try it again/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Resume" }),
  ).not.toBeInTheDocument();
});

it("does not turn transient warning history into a persistent attention banner", () => {
  show({
    attention: null,
    warning: { attemptId: "rate", occurredAt: 100, kind: "rate_limited" },
  });
  expect(
    screen.queryByText(/needs attention|rate limit|Resume to try/i),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
});

it("removes a stalled-run banner when its last current case is measured", () => {
  const onOpenRun = vi.fn();
  const stopped = { ...runSummary, state: "needs_attention", openCells: [] };
  const page = (completeVersionIds: string[]) => (
    <BenchmarkActivity
      runs={[stopped]}
      onOpenRun={onOpenRun}
      attentionFor={leaderboardRow({ completeVersionIds })}
      poolVersionIds={["version-1"]}
    />
  );
  const { rerender } = render(page([]));
  fireEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
  expect(onOpenRun).toHaveBeenCalledExactlyOnceWith(stopped.id);
  rerender(page(["version-1"]));
  expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
});

it("warns for current gaps but not retired cases or another model's gaps", () => {
  const stopped = {
    ...runSummary,
    state: "needs_attention",
    request: {
      ...runSummary.request,
      configurations: [
        configuration,
        { ...configuration, id: "other", modelId: "other" },
      ],
      versionIds: ["version-1", "retired"],
    },
    openCells: [
      { configurationId: configuration.id, versionId: "retired" },
      { configurationId: "other", versionId: "version-1" },
    ],
  };
  const page = (poolVersionIds: string[]) => (
    <BenchmarkActivity
      runs={[stopped]}
      onOpenRun={vi.fn()}
      attentionFor={leaderboardRow({ completeVersionIds: [] })}
      poolVersionIds={poolVersionIds}
    />
  );
  const { rerender } = render(page(["version-1", "retired"]));
  expect(screen.getByText("Needs attention")).toBeInTheDocument();
  rerender(page(["version-1"]));
  expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
});

it("opens the exact paused campaign from its progress row without opening a child run", () => {
  campaignState.data = [
    {
      state: "paused",
      nextCell: 2,
      plan: {
        id: "comparison",
        createdAt: Date.UTC(2026, 0, 1),
        cells: Array(12).fill({}),
      },
    } as WorkflowCampaign,
  ];
  const onOpenCampaign = vi.fn();
  const onOpenRun = vi.fn();
  render(
    <BenchmarkActivity
      runs={[
        {
          ...runSummary,
          state: "completed",
          request: {
            ...runSummary.request,
            requestKey: "workflow-campaign:comparison:0",
          },
        },
      ]}
      onOpenRun={onOpenRun}
      onOpenCampaign={onOpenCampaign}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: /Workflow comparison.*Paused.*2 \/ 12 workflows settled/,
    }),
  );
  expect(onOpenCampaign).toHaveBeenCalledExactlyOnceWith("comparison");
  expect(onOpenRun).not.toHaveBeenCalled();
});

it("distinguishes same-state comparisons by their creation time and exposes the reason for pausing", () => {
  const reason = "Sign in to the benchmark account before resuming.";
  campaignState.data = [0, 1].map(
    (index) =>
      ({
        state: "paused",
        stateReason: index === 0 ? reason : null,
        nextCell: 2,
        plan: {
          id: `private-comparison-${index}`,
          createdAt: Date.UTC(2026, 0, 1, 12, 0, index),
          cells: Array(12).fill({}),
        },
      }) as WorkflowCampaign,
  );
  const onOpenCampaign = vi.fn();
  render(
    <BenchmarkActivity
      runs={campaignState.data.map((entry) => ({
        ...runSummary,
        state: "completed",
        request: {
          ...runSummary.request,
          requestKey: `workflow-campaign:${entry.plan.id}:0`,
        },
      }))}
      onOpenRun={vi.fn()}
      onOpenCampaign={onOpenCampaign}
    />,
  );
  const rows = screen.getAllByRole("button");
  const dates = rows.map((row) => within(row).getByText(/^Created /));
  expect(dates[0].textContent).not.toBe(dates[1].textContent);
  expect(within(rows[0]).getByText(reason)).toBeVisible();
  expect(within(rows[1]).queryByText(reason)).not.toBeInTheDocument();
  expect(screen.queryByText(/private-comparison/)).not.toBeInTheDocument();
  fireEvent.click(rows[1]);
  expect(onOpenCampaign).toHaveBeenCalledExactlyOnceWith(
    "private-comparison-1",
  );
});

it("names the model of a run that waits with nothing running", () => {
  const row = show({
    request: { ...runSummary.request, configurations: [many[0]] },
    attemptCount: 198,
    settledCount: 60,
    cellCount: 66,
    settledCellCount: 20,
    openCells: [{ configurationId: "config-1", versionId: "version-1" }],
  });
  expect(row.getByText("Model One")).toBeInTheDocument();
  expect(row.getByText("max")).toBeInTheDocument();
  expect(row.getByText("20 / 66")).toBeInTheDocument();
});

it("names the first models of a matrix and counts the rest", () => {
  const row = show({
    request: { ...runSummary.request, configurations: many },
    openCells: many.map((entry) => ({
      configurationId: entry.id,
      versionId: "version-1",
      running: true,
    })),
  });
  expect(row.getByText("Model One")).toBeInTheDocument();
  expect(row.getByText("model-3")).toBeInTheDocument();
  expect(row.queryByText("model-4")).not.toBeInTheDocument();
  expect(row.getByText("+2")).toBeInTheDocument();
  // The CLI's "default" is no effort level and is never named as one.
  expect(row.queryByText("default")).not.toBeInTheDocument();
});

const repository = {
  ...configuration,
  id: "config-1-repository",
  executionProfile: "protected_repository",
};
/** A model's run from its page: one configuration per execution profile. */
const twoProfiles = {
  ...runSummary.request,
  configurations: [configuration, repository],
};

it("names a model once however many execution profiles its run spans", () => {
  const row = show({
    request: twoProfiles,
    attemptCount: 1035,
    settledCount: 254,
    cellCount: 345,
    settledCellCount: 28,
    openCells: [
      { configurationId: "config-1", versionId: "version-1", running: true },
      {
        configurationId: "config-1-repository",
        versionId: "version-2",
        running: true,
      },
    ],
  });
  expect(row.getAllByText("Model One")).toHaveLength(1);
  expect(row.getAllByText("high")).toHaveLength(1);
  expect(row.getAllByText("28 / 345")).toHaveLength(1);
  expect(row.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
});

it("names a waiting model once while nothing of its run is running", () => {
  const row = show({
    request: twoProfiles,
    attemptCount: 615,
    settledCount: 0,
    cellCount: 205,
    settledCellCount: 0,
    openCells: [
      { configurationId: "config-1", versionId: "version-1" },
      { configurationId: "config-1-repository", versionId: "version-2" },
    ],
  });
  expect(row.getAllByText("Model One")).toHaveLength(1);
  expect(row.getAllByText("high")).toHaveLength(1);
  expect(row.getByText("0 / 205")).toBeInTheDocument();
});

it("keeps one row per run when two runs measure the same model", () => {
  const twin = (id: string, settledCellCount: number): RunSummary => ({
    ...runSummary,
    id,
    state: "running",
    request: twoProfiles,
    cellCount: 345,
    settledCellCount,
    openCells: [
      { configurationId: "config-1", versionId: "version-1", running: true },
    ],
  });
  render(
    <BenchmarkActivity
      runs={[twin("run-a", 28), twin("run-b", 0)]}
      onOpenRun={vi.fn()}
    />,
  );
  // The rows that open a run; their steering controls name no model.
  const rows = screen
    .getAllByRole("button")
    .filter((button) => within(button).queryByText("Model One"));
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(within(row).getAllByText("Model One")).toHaveLength(1);
  expect(screen.getByText("28 / 345")).toBeInTheDocument();
  expect(screen.getByText("0 / 345")).toBeInTheDocument();
});

it("names each model of a matrix once across its execution profiles", () => {
  const second = { ...configuration, id: "config-2", modelId: "model-2" };
  const configurations = [
    configuration,
    repository,
    second,
    {
      ...second,
      id: "config-2-repository",
      executionProfile: "protected_repository",
    },
  ];
  const row = show({
    request: { ...runSummary.request, configurations },
    openCells: configurations.map((entry) => ({
      configurationId: entry.id,
      versionId: "version-1",
      running: true,
    })),
  });
  expect(row.getAllByText("Model One")).toHaveLength(1);
  expect(row.getAllByText("model-2")).toHaveLength(1);
  expect(row.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
});

it("pauses, resumes and cancels a run from its row without opening it", async () => {
  const onOpenRun = vi.fn();
  const { rerender } = render(
    <BenchmarkActivity
      runs={[{ ...runSummary, state: "running" }]}
      onOpenRun={onOpenRun}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  });
  expect(api.pauseRun).toHaveBeenCalledExactlyOnceWith(runSummary.id);
  expect(onOpenRun).not.toHaveBeenCalled();
  rerender(
    <BenchmarkActivity
      runs={[{ ...runSummary, state: "paused" }]}
      onOpenRun={onOpenRun}
    />,
  );
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  });
  expect(api.resumeRun).toHaveBeenCalledExactlyOnceWith(runSummary.id);
  // Cancel is always the last control.
  const buttons = screen.getAllByRole("button");
  const cancel = buttons[buttons.length - 1];
  expect(cancel).toHaveAccessibleName("Cancel run");
  await act(async () => {
    fireEvent.click(cancel);
  });
  expect(api.cancelRun).toHaveBeenCalledExactlyOnceWith(runSummary.id);
});

it("says why a resume from the row was refused instead of showing a second Cancel", async () => {
  api.resumeRun.mockRejectedValueOnce(
    "capability_missing: Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe",
  );
  render(
    <BenchmarkActivity
      runs={[{ ...runSummary, state: "paused" }]}
      onOpenRun={vi.fn()}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  });
  expect(
    screen.getByText(
      /Not resumed: the sandbox check must be renewed for this version of Flock/,
    ),
  ).toBeInTheDocument();
  // The refused control keeps its name; only one control cancels the run.
  expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Cancel run" })).toHaveLength(1);
});

it("names any other refusal generically and keeps its reason in reach", async () => {
  api.resumeRun.mockRejectedValueOnce("resource_busy: invented refusal");
  render(
    <BenchmarkActivity
      runs={[{ ...runSummary, state: "paused" }]}
      onOpenRun={vi.fn()}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  });
  expect(
    screen.getByText("The run refused this action. Open the run for the reason."),
  ).toHaveAttribute("title", "resource_busy: invented refusal");
});
