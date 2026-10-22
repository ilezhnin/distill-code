import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RunSummary } from "../types";
import { BenchmarkActivity } from "../ui/BenchmarkActivity";
import { configuration, leaderboardRow, runSummary } from "./fixtures";
import type { WorkflowCampaign } from "../lib/workflowCampaign";

const campaignState = vi.hoisted(() => ({ data: [] as WorkflowCampaign[] }));

vi.mock("../hooks/useBenchmarks", () => ({
  modelNameKey: (entry: { modelId: string }) => entry.modelId,
  useModelNames: () => new Map([["model-1", "Model One"]]),
  useWorkflowCampaigns: () => campaignState,
}));

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
  return within(screen.getByRole("button"));
}

afterEach(() => {
  cleanup();
  campaignState.data = [];
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
  const rows = screen.getAllByRole("button");
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
