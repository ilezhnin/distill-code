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
import {
  attempt,
  configuration,
  definition,
  leaderboardRow,
  run,
} from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: {
    getInventory: vi.fn(),
    previewRun: vi.fn(),
    startRun: vi.fn(),
    getRun: vi.fn(),
    listAttempts: vi.fn(),
    cancelRun: vi.fn(),
    resumeRun: vi.fn(),
    extendRun: vi.fn(),
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
  {
    ...test(9, "Infrastructure only"),
    versions: [
      {
        ...test(9, "Infrastructure only").versions[0],
        manifest: {
          ...test(9, "Infrastructure only").versions[0].manifest,
          split: "development",
        },
      },
    ],
  },
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
  options: {
    configuration?: Configuration;
    runId?: string | null;
    /** Tests the model already has a score on, by version and attempt. */
    measured?: { versionIds: string[]; attemptIds: string[] };
    /** The released pool the boards measure. */
    pool?: string[];
  } = {},
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkModelRunDialog
        row={leaderboardRow({
          configuration: options.configuration ?? configuration,
          scoredVersionIds: options.measured?.versionIds ?? [],
          attemptIds: options.measured?.attemptIds ?? [],
        })}
        definitions={definitions}
        pool={options.pool ?? null}
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
  Element.prototype.scrollIntoView = vi.fn();
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

it("lists the released pool, not tests published after it", async () => {
  // The release froze Alpha, Golf before its archive and Hotel's first version.
  show({ pool: ["version-1", "version-7", "version-8-old", "version-6"] });
  await screen.findByRole("dialog");
  expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
  for (const name of ["Alpha", "Golf", "Hotel"])
    expect(screen.getByText(name)).toBeInTheDocument();
  for (const name of ["Bravo", "Charlie", "Delta", "Echo"])
    expect(screen.queryByText(name)).not.toBeInTheDocument();
  expect(screen.getByText("Foxtrot")).toBeInTheDocument();
});

it("keeps development out even when an older release explicitly includes it", async () => {
  show({ pool: ["version-1", "version-9"] });
  expect(await screen.findByText("Alpha")).toBeInTheDocument();
  expect(screen.queryByText("Infrastructure only")).not.toBeInTheDocument();
  expect(screen.getByText("1 of 1 selected")).toBeInTheDocument();
});

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
  expect(screen.queryByText("Infrastructure only")).not.toBeInTheDocument();
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
    // Every measurement is three repetitions; a case counts only when all pass.
    repetitions: 3,
    // Four hours from Settings, not a field in the dialog.
    timeoutSeconds: 14_400,
    // Four exact tests at one turn, the judged one at one plus three judges,
    // three times over.
    maxExecutions: 24,
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
  // Every result in one form: one dot per repetition, green where it passed,
  // red where it did not; no checks, crosses or counts beside them.
  const dots = (name: string) =>
    [...row(name).getByRole("img").querySelectorAll("[data-dot]")].map((dot) =>
      dot.getAttribute("data-dot"),
    );
  expect(dots("Alpha")).toEqual(["passed"]);
  expect(dots("Bravo")).toEqual(["passed"]);
  expect(dots("Charlie")).toEqual(["failed"]);
  expect(row("Charlie").queryByText("0/1")).not.toBeInTheDocument();
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
  // The checks show the run's tests: Delta is not in it.
  expect(
    within(screen.getByText("Delta").closest("label") as HTMLElement).getByRole(
      "checkbox",
    ),
  ).not.toBeChecked();
  expect(
    within(screen.getByText("Echo").closest("label") as HTMLElement).getByRole(
      "checkbox",
    ),
  ).toBeChecked();
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

it("lists the tests in the order the run takes them and times the one running now", async () => {
  vi.mocked(benchmarkApi.previewRun).mockResolvedValue({
    valid: true,
    issues: [],
    executionCount: 6,
    estimatedCost: null,
    costReason: "",
    executionOrder: [
      "version-5",
      "version-1",
      "version-8",
      "version-3",
      "version-2",
      "version-4",
    ],
  });
  show();
  const names = () =>
    within(screen.getByRole("list"))
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
  // Before Start, the plan's queue; the model's own tests come last.
  await waitFor(() =>
    expect(
      names()
        .slice(0, 6)
        .map((name) => name.match(/^[A-Z][a-z]+/)?.[0]),
    ).toEqual(["Echo", "Alpha", "Hotel", "Charlie", "Bravo", "Delta"]),
  );
  cleanup();
  // A run that measures the model now: its own order, the running test timed
  // and in view, finished tests with how long they took.
  const startedAt = Date.now() - 125_000;
  const now: BenchmarkRun = {
    ...liveRun("running"),
    attempts: [
      {
        ...attempt,
        id: "a-3",
        versionId: "version-3",
        // Seven seconds start to finish, six of them the model's turn.
        startedAt: 10_000,
        finishedAt: 17_000,
        durationMs: 6_000,
      },
      {
        ...attempt,
        id: "a-5",
        versionId: "version-5",
        phase: "running",
        outcome: null,
        startedAt,
        finishedAt: null,
        durationMs: null,
      },
      {
        ...attempt,
        id: "a-1",
        versionId: "version-1",
        phase: "pending",
        outcome: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      },
    ],
  };
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(now);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
    { ...summary("version-3", "terminal", "pass", 1), id: "a-3" },
  ]);
  show({ runId: "run-2" });
  await waitFor(() =>
    expect(
      names()
        .slice(0, 3)
        .map((name) => name.match(/^[A-Z][a-z]+/)?.[0]),
    ).toEqual(["Charlie", "Echo", "Alpha"]),
  );
  const row = (name: string) =>
    within(screen.getByText(name).closest("li") as HTMLElement);
  expect(row("Charlie").getByText("7 s")).toBeInTheDocument();
  expect(
    await row("Charlie").findByRole("img", {
      name: "1 of 1 passed, 1 repetitions",
    }),
  ).toBeInTheDocument();
  expect(row("Echo").getByLabelText("Running")).toBeInTheDocument();
  expect(row("Echo").getByText(/^2 min [5-7] s$/)).toBeInTheDocument();
  expect(screen.getByText("Echo").closest("li")).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  expect(row("Alpha").getByText("Queued")).toBeInTheDocument();
});

it("checks every test whatever its standing, a run being one sitting, and shows each standing", async () => {
  const user = userEvent.setup();
  // Alpha solved three times; Charlie failed once; Delta passed once.
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
    { ...summary("version-1", "terminal", "pass", 1), id: "s-1a" },
    { ...summary("version-1", "terminal", "pass", 1), id: "s-1b" },
    { ...summary("version-1", "terminal", "pass", 1), id: "s-1c" },
    { ...summary("version-3", "terminal", "fail", 0), id: "s-3" },
    { ...summary("version-4", "terminal", "pass", 1), id: "s-4" },
  ]);
  show({
    measured: {
      versionIds: ["version-1", "version-3", "version-4"],
      attemptIds: ["s-1a", "s-1b", "s-1c", "s-3", "s-4"],
    },
  });
  const row = (name: string) =>
    within(screen.getByText(name).closest("label") as HTMLElement);
  // A new run measures every test again, the solved one included: only a
  // whole sitting can stand on the board.
  expect(await screen.findByText("6 of 6 selected")).toBeInTheDocument();
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Hotel"])
    expect(row(name).getByRole("checkbox")).toBeChecked();
  expect(
    await row("Alpha").findByRole("img", {
      name: "3 of 3 passed, 3 repetitions",
    }),
  ).toBeInTheDocument();
  expect(
    row("Charlie").getByRole("img", { name: "0 of 1 passed, 1 repetitions" }),
  ).toBeInTheDocument();
  expect(
    row("Delta").getByRole("img", { name: "1 of 1 passed, 1 repetitions" }),
  ).toBeInTheDocument();
  expect(benchmarkApi.listAttempts).toHaveBeenCalledWith({
    attemptIds: ["s-1a", "s-1b", "s-1c", "s-3", "s-4"],
    limit: 100,
  });
  // Leaving a test out stays one click away, and so does taking it back.
  await user.click(row("Alpha").getByRole("checkbox"));
  expect(screen.getByText("5 of 6 selected")).toBeInTheDocument();
  await user.click(screen.getByText("All tests"));
  expect(screen.getByText("6 of 6 selected")).toBeInTheDocument();
});

/** The model's newest run, stopped an hour into its window. */
function stoppedRun(
  state: string,
  entries: {
    versionId: string;
    outcome: string | null;
    score: number | null;
  }[],
): { run: BenchmarkRun; summaries: AttemptSummary[] } {
  const summaries = entries.flatMap((entry) =>
    Array.from({ length: 3 }, (_, repetition) => ({
      ...summary(
        entry.versionId,
        entry.outcome ? "terminal" : "pending",
        entry.outcome,
        entry.score,
      ),
      id: `attempt-${entry.versionId}-${repetition}`,
      repetition,
    })),
  );
  return {
    run: {
      ...run,
      id: "run-2",
      state,
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 600_000,
      request: { ...run.request, repetitions: 3 },
      attempts: summaries.map((entry) => ({
        ...attempt,
        id: entry.id,
        runId: "run-2",
        versionId: entry.versionId,
        repetition: entry.repetition,
        phase: entry.phase,
        outcome: entry.outcome,
      })),
    },
    summaries,
  };
}

it("finishes a stopped run inside its window, adding the tests it lacks, instead of starting another", async () => {
  const user = userEvent.setup();
  // Alpha passed, Charlie failed, Echo and Hotel never started; the run
  // never planned Bravo and Delta.
  const stopped = stoppedRun("needs_attention", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-3", outcome: "fail", score: 0 },
    { versionId: "version-5", outcome: null, score: null },
    { versionId: "version-8", outcome: null, score: null },
  ]);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(stopped.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(stopped.summaries);
  vi.mocked(benchmarkApi.extendRun).mockResolvedValue({
    ...stopped.run,
    state: "running",
  });
  show({ runId: "run-2" });
  const finish = await screen.findByRole("button", { name: "Finish run" });
  // The hint counts the queued tests with the added ones, what starts
  // over, and names the deadline.
  expect(
    screen.getByText(/4 tests to measure, 0 of them again/),
  ).toBeInTheDocument();
  expect(screen.getByText(/open until/)).toBeInTheDocument();
  // The run's tests are fixed; the ones it lacks join it unless unchecked.
  const row = (name: string) =>
    within(screen.getByText(name).closest("label") as HTMLElement);
  expect(row("Alpha").getByRole("checkbox")).toBeChecked();
  expect(row("Alpha").getByRole("checkbox")).toBeDisabled();
  expect(row("Delta").getByRole("checkbox")).toBeChecked();
  expect(row("Delta").getByRole("checkbox")).toBeEnabled();
  await user.click(row("Bravo").getByRole("checkbox"));
  expect(
    screen.getByText(/3 tests to measure, 0 of them again/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Start" }),
  ).not.toBeInTheDocument();
  await user.click(finish);
  expect(benchmarkApi.extendRun).toHaveBeenCalledWith("run-2", ["version-4"]);
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
});

it("warns before measuring a model again whose run inside its window is complete", async () => {
  const user = userEvent.setup();
  const complete = stoppedRun(
    "completed",
    [
      "version-1",
      "version-2",
      "version-3",
      "version-4",
      "version-5",
      "version-8",
    ].map((versionId) => ({
      versionId,
      outcome: versionId === "version-3" ? "fail" : "pass",
      score: versionId === "version-3" ? 0 : 1,
    })),
  );
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(complete.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(complete.summaries);
  show({ runId: "run-2" });
  expect(
    await screen.findByRole("button", { name: "Measure again" }),
  ).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    /Measured in full .*: 6 tests, every repetition\. Repeating this measurement is unnecessary spending/,
  );
  expect(
    screen.queryByRole("button", { name: "Finish run" }),
  ).not.toBeInTheDocument();
  // Every test is checked for the new sitting.
  expect(screen.getByText("6 of 6 selected")).toBeInTheDocument();
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Measure again" }));
  expect(benchmarkApi.startRun).toHaveBeenCalledWith(
    expect.objectContaining({ repetitions: 3 }),
    "run-2",
  );
});

it("starts legacy one-repetition runs afresh instead of paying to extend an unusable sitting", async () => {
  const user = userEvent.setup();
  const legacy = stoppedRun("completed", [
    { versionId: "version-1", outcome: "pass", score: 1 },
  ]);
  legacy.run.request.repetitions = 1;
  legacy.run.attempts = legacy.run.attempts.filter((a) => a.repetition === 0);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(legacy.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(
    legacy.summaries.filter((a) => a.repetition === 0),
  );
  show({ runId: "run-2" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Finish run" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Measure again" }),
  ).not.toBeInTheDocument();
  const start = screen.getByRole("button", { name: "Start" });
  await waitFor(() => expect(start).toBeEnabled());
  await user.click(start);
  expect(benchmarkApi.startRun).toHaveBeenCalledWith(
    expect.objectContaining({ repetitions: 3 }),
  );
  expect(benchmarkApi.extendRun).not.toHaveBeenCalled();
});
