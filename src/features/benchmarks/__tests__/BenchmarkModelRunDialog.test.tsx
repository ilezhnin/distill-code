import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import type {
  AttemptSummary,
  BenchmarkDefinition,
  BenchmarkRun,
  Configuration,
} from "../types";
import { BenchmarkModelRunDialog } from "../ui/BenchmarkModelRunDialog";
import { attempt, configuration, definition, run } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: {
    getInventory: vi.fn(),
    previewRun: vi.fn(),
    startRun: vi.fn(),
    getRun: vi.fn(),
    listAttempts: vi.fn(),
    cancelRun: vi.fn(),
  },
}));

const version = definition.versions[0];

/** A live test; `kind` is its evaluator, `authoredBy` who wrote it. */
function test(
  index: number,
  name: string,
  kind = "exact",
  authoredBy?: string[],
): BenchmarkDefinition {
  return {
    ...definition,
    id: `definition-${index}`,
    versions: [
      {
        ...version,
        id: `version-${index}`,
        manifest: {
          ...version.manifest,
          name,
          evaluator: { ...version.manifest.evaluator, kind },
          environment: authoredBy ? { authoredBy } : {},
        },
      },
    ],
  };
}

const definitions: BenchmarkDefinition[] = [
  test(1, "Alpha"),
  test(2, "Bravo", "rubric"),
  test(3, "Charlie"),
  test(4, "Delta"),
  test(5, "Echo"),
  // Written by the candidate: listed, never run.
  test(6, "Foxtrot", "exact", ["model-1"]),
  // Archived: not a current test.
  { ...test(7, "Golf"), archived: true },
  // Two published versions: only the newest is current.
  {
    ...test(8, "Hotel"),
    versions: [
      { ...test(8, "Hotel").versions[0], id: "version-8-old", publishedAt: 1 },
      { ...test(8, "Hotel").versions[0], id: "version-8", publishedAt: 2 },
    ],
  },
];

function show(
  options: { configuration?: Configuration; runId?: string | null } = {},
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkModelRunDialog
        configuration={options.configuration ?? configuration}
        definitions={definitions}
        runId={options.runId ?? null}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

const summary = (
  versionId: string,
  phase: string,
  outcome: string | null,
  score: number | null,
): AttemptSummary => ({
  id: `attempt-${versionId}`,
  runId: "run-2",
  versionId,
  modelId: "model-1",
  repetition: 0,
  phase,
  outcome,
  finishedAt: null,
  durationMs: null,
  outputTokens: null,
  cost: null,
  score,
});

const running: AttemptSummary[] = [
  summary("version-1", "terminal", "pass", 1),
  summary("version-2", "terminal", "judged", 0.65),
  summary("version-3", "terminal", "fail", 0),
  summary("version-5", "running", null, null),
  summary("version-8", "pending", null, null),
];

function liveRun(state: string): BenchmarkRun {
  return {
    ...run,
    id: "run-2",
    state,
    attempts: running.map((entry) => ({
      ...attempt,
      id: entry.id,
      runId: "run-2",
      versionId: entry.versionId,
      phase: entry.phase,
      outcome: entry.outcome,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration: { ...configuration, inventoryRevision: "runtime-now" },
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: true,
      reason: null,
    },
  ]);
  vi.mocked(benchmarkApi.previewRun).mockResolvedValue({
    valid: true,
    issues: [],
    executionCount: 1,
    estimatedCost: null,
    costReason: "",
  });
  vi.mocked(benchmarkApi.startRun).mockResolvedValue(liveRun("running"));
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(liveRun("running"));
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(running);
  vi.mocked(benchmarkApi.cancelRun).mockResolvedValue(liveRun("cancelling"));
});
afterEach(cleanup);

it("checks every current test, keeps the model's own out, and runs the rest on today's runtime", async () => {
  const user = userEvent.setup();
  // The row's newest attempt ran on a runtime that has since changed.
  show({ configuration: { ...configuration, inventoryRevision: "then" } });
  const dialog = await screen.findByRole("dialog");
  // The title names the model and its effort; nothing asks for them again.
  expect(within(dialog).getByRole("heading")).toHaveTextContent("model-1");
  expect(within(dialog).getByRole("heading")).toHaveTextContent("high");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  // Six current tests the model did not write, all checked.
  expect(screen.getByText("6 of 6 selected")).toBeInTheDocument();
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Hotel"])
    expect(
      within(screen.getByText(name).closest("label") as HTMLElement).getByRole(
        "checkbox",
      ),
    ).toBeChecked();
  const own = screen.getByText("Foxtrot").closest("label") as HTMLElement;
  expect(within(own).getByRole("checkbox")).toBeDisabled();
  expect(within(own).getByText("Written by this model")).toBeInTheDocument();
  expect(screen.queryByText("Golf")).not.toBeInTheDocument();
  await user.click(
    within(screen.getByText("Delta").closest("label") as HTMLElement).getByRole(
      "checkbox",
    ),
  );
  expect(screen.getByText("5 of 6 selected")).toBeInTheDocument();
  const start = screen.getByRole("button", { name: "Start" });
  await waitFor(() => expect(start).toBeEnabled());
  await user.click(start);
  const request = {
    configurations: [
      expect.objectContaining({
        modelId: "model-1",
        effort: "high",
        inventoryRevision: "runtime-now",
      }),
    ],
    versionIds: [
      "version-1",
      "version-2",
      "version-3",
      "version-5",
      "version-8",
    ],
    repetitions: 1,
    // Four hours from Settings, not a field in the dialog.
    timeoutSeconds: 14_400,
    // Four exact tests at one turn, the judged one at one plus three judges.
    maxExecutions: 8,
    preview: false,
  };
  await waitFor(() =>
    expect(benchmarkApi.startRun).toHaveBeenCalledWith(
      expect.objectContaining(request),
    ),
  );
  expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
    expect.objectContaining(request),
  );
  // Each row follows its test; Start becomes Stop while the run works.
  const stop = await screen.findByRole("button", { name: "Stop" });
  const row = (name: string) =>
    within(screen.getByText(name).closest("label") as HTMLElement);
  expect(row("Alpha").getByLabelText("Pass")).toBeInTheDocument();
  expect(row("Bravo").getByText("650")).toBeInTheDocument();
  expect(row("Charlie").getByLabelText("Fail")).toBeInTheDocument();
  expect(row("Echo").getByLabelText("Running")).toBeInTheDocument();
  expect(row("Hotel").getByText("Queued")).toBeInTheDocument();
  expect(screen.getByText("3 of 5 finished")).toBeInTheDocument();
  expect(row("Alpha").getByRole("checkbox")).toBeDisabled();
  await user.click(stop);
  expect(benchmarkApi.cancelRun).toHaveBeenCalledWith("run-2");
});

it("follows the run that measures the model now", async () => {
  show({ runId: "run-2" });
  expect(await screen.findByRole("button", { name: "Stop" })).toBeEnabled();
  expect(benchmarkApi.getRun).toHaveBeenCalledWith("run-2");
  expect(
    await screen.findByText("3 of 5 finished", undefined),
  ).toBeInTheDocument();
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
});

it("shows a stopped run's unfinished tests as cancelled and offers Start again", async () => {
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(liveRun("cancelled"));
  show({ runId: "run-2" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
  );
  const hotel = within(
    screen.getByText("Hotel").closest("label") as HTMLElement,
  );
  expect(await hotel.findByText("Cancelled")).toBeInTheDocument();
});

it("does not run a model the runtime no longer lists", async () => {
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([]);
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "model-1 is no longer available on this account.",
  );
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
});

it("shows why the runtime blocks a model it still lists", async () => {
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration,
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: false,
      reason:
        "Installed Claude bridge changed; benchmark adapter requires verification",
    },
  ]);
  show();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Installed Claude bridge changed; benchmark adapter requires verification",
  );
  expect(alert).not.toHaveTextContent("no longer available");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
});

it("does not run a row measured at the CLI's default", async () => {
  show({ configuration: { ...configuration, effort: "default" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "model-1 no longer offers this effort",
  );
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(benchmarkApi.previewRun).not.toHaveBeenCalled();
});
