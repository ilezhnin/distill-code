import {
  act,
  cleanup,
  fireEvent,
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
  BenchmarkAuthor,
  BenchmarkDefinition,
  BenchmarkRun,
  Configuration,
} from "../types";
import { BenchmarkModelRunDialog } from "../ui/BenchmarkModelRunDialog";
import { runWindowCloses } from "../lib/benchmarkPlan";
import {
  attempt,
  configuration,
  definition,
  leaderboardRow,
  run,
} from "./fixtures";

const checkboxRenders = vi.hoisted(() => vi.fn());
vi.mock("@/shared/ui/checkbox", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/shared/ui/checkbox")>();
  return {
    ...original,
    Checkbox: (props: Parameters<typeof original.Checkbox>[0]) => {
      checkboxRenders(props);
      return <original.Checkbox {...props} />;
    },
  };
});

vi.mock("../api/benchmarks", async () => ({
  ...(await vi.importActual<typeof import("../api/benchmarks")>(
    "../api/benchmarks",
  )),
  benchmarkApi: {
    getInventory: vi.fn(),
    renewPolicyCheck: vi.fn(),
    previewRun: vi.fn(),
    startRun: vi.fn(),
    getRun: vi.fn(),
    listAttempts: vi.fn(),
    cancelRun: vi.fn(),
    resumeRun: vi.fn(),
    pauseRun: vi.fn(),
    extendRun: vi.fn(),
    providerDataUse: vi.fn(),
  },
}));

const version = definition.versions[0];

it("keeps the user's scroll position when another test starts", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BenchmarkModelRunDialog
        row={leaderboardRow({})}
        definitions={definitions}
        runId="run-2"
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("0 of 5 finished");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  fireEvent.wheel(screen.getByRole("list"));
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  const next = liveRun("running");
  next.attempts = next.attempts.map((entry) =>
    entry.versionId === "version-5"
      ? { ...entry, phase: "terminal", outcome: "pass" }
      : entry.versionId === "version-8"
        ? { ...entry, phase: "running" }
        : entry,
  );
  act(() => client.setQueryData(["benchmarks", "run", "run-2"], next));
  await waitFor(() =>
    expect(
      within(
        screen.getByText("Hotel").closest("label") as HTMLElement,
      ).getByLabelText("Running"),
    ).toBeInTheDocument(),
  );
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  client.clear();
});

it("shows why an older run finished without judging and counts scored tests only", async () => {
  const unfinished = stoppedRun("completed", [
    { versionId: "version-1", outcome: "pending_review", score: null },
    { versionId: "version-3", outcome: "fail", score: 0 },
  ]);
  for (const entry of unfinished.run.attempts.filter(
    (a) => a.versionId === "version-1",
  ))
    entry.reason =
      "No judge panel: 1 eligible judge(s), at least 2 are required";
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(unfinished.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(unfinished.summaries);
  show({ runId: "run-2" });
  expect(
    await screen.findByText("Previous judging errors"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Panel at the time: 1 eligible, 2 required/),
  ).toBeInTheDocument();
  const overview = screen.getByLabelText("Run overview");
  expect(overview?.querySelectorAll("time")).toHaveLength(2);
  await waitFor(() =>
    expect(screen.getByText("Measured").nextElementSibling).toHaveTextContent(
      "1",
    ),
  );
  expect(screen.getByText("Remaining").nextElementSibling).toHaveTextContent(
    "1",
  );
  expect(screen.getByText("Needs attention")).toBeInTheDocument();
});

it("keeps existing result dots while a changed standing loads", async () => {
  const old = {
    ...summary("version-1", "terminal", "pass", 1),
    id: "standing-old",
  };
  let resolveStanding: ((value: AttemptSummary[]) => void) | undefined;
  const delayed = new Promise<AttemptSummary[]>((resolve) => {
    resolveStanding = resolve;
  });
  vi.mocked(benchmarkApi.listAttempts).mockImplementation((query) =>
    query.attemptIds?.includes("standing-new")
      ? delayed
      : Promise.resolve([old]),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (ids: string[]) => (
    <QueryClientProvider client={client}>
      <BenchmarkModelRunDialog
        row={leaderboardRow({ attemptIds: ids })}
        definitions={definitions}
        runId={null}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  );
  const rendered = render(view(["standing-old"]));
  expect(
    await screen.findByRole("img", { name: "1 of 1 passed, 1 repetitions" }),
  ).toBeInTheDocument();
  rendered.rerender(view(["standing-old", "standing-new"]));
  await waitFor(() =>
    expect(benchmarkApi.listAttempts).toHaveBeenCalledWith({
      attemptIds: ["standing-old", "standing-new"],
      limit: 100,
    }),
  );
  expect(
    screen.getByRole("img", { name: "1 of 1 passed, 1 repetitions" }),
  ).toBeInTheDocument();
  await act(async () =>
    resolveStanding?.([old, { ...old, id: "standing-new" }]),
  );
  expect(
    await screen.findByRole("img", { name: "2 of 2 passed, 2 repetitions" }),
  ).toBeInTheDocument();
  client.clear();
});

it("renews a stale sandbox check and enables continuation without starting work or losing saved results", async () => {
  const user = userEvent.setup();
  const previous = stoppedRun("completed", [
    { versionId: "version-1", outcome: "pending_review", score: null },
    { versionId: "version-3", outcome: "fail", score: 0 },
  ]);
  for (const entry of previous.run.attempts.filter(
    (a) => a.versionId === "version-1",
  )) {
    entry.reason =
      "No judge panel: 1 eligible judge(s), at least 2 are required";
    entry.finishedAt = Date.now() - 60_000;
  }
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(previous.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(previous.summaries);
  const failure =
    "capability_missing: Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe";
  vi.mocked(benchmarkApi.getInventory).mockRejectedValue(failure);
  show({
    runId: "run-2",
    measured: {
      versionIds: ["version-3"],
      attemptIds: previous.summaries
        .filter((entry) => entry.versionId === "version-3")
        .map((entry) => entry.id),
    },
  });
  await screen.findByText("Cannot start or continue");
  expect(
    screen.getByText(
      "The sandbox check must be renewed for this version of Flock.",
    ),
  ).toBeInTheDocument();
  expect(
    await screen.findByText("Previous judging errors"),
  ).toBeInTheDocument();
  expect(screen.getByText(/^Recorded /)).toBeInTheDocument();
  const recordedCause = screen.getByText(/Panel at the time/);
  expect(recordedCause).not.toBeVisible();
  await user.click(screen.getByText("View recorded errors"));
  expect(recordedCause).toBeVisible();
  expect(
    screen.getByText(/Panel at the time/).closest('[role="alert"]'),
  ).not.toHaveClass("text-destructive");
  expect(screen.getByText(failure).closest("details")).not.toHaveAttribute(
    "open",
  );
  expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Measure all again/ }),
  ).toBeDisabled();
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
  let finishCheck: (() => void) | undefined;
  vi.mocked(benchmarkApi.renewPolicyCheck).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishCheck = resolve;
      }),
  );
  await user.click(
    screen.getByRole("button", { name: "Update sandbox check" }),
  );
  expect(benchmarkApi.renewPolicyCheck).toHaveBeenCalledWith(
    configuration.providerId,
  );
  expect(
    screen.getByRole("button", { name: "Updating sandbox check…" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
  expect(benchmarkApi.getInventory).toHaveBeenCalledTimes(1);
  await act(async () => finishCheck?.());
  await waitFor(() =>
    expect(screen.queryByText("Cannot start or continue")).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Start run" })).toBeEnabled();
  expect(screen.getByText("Previous judging errors")).toBeInTheDocument();
  expect(benchmarkApi.extendRun).not.toHaveBeenCalled();
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
});

it("keeps continuation blocked after a failed renewal and lets the operator retry", async () => {
  vi.mocked(benchmarkApi.getInventory).mockRejectedValue(
    "capability_missing: Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe",
  );
  vi.mocked(benchmarkApi.renewPolicyCheck).mockRejectedValue(
    new Error("Sandbox check failed: offline suite failed"),
  );
  const user = userEvent.setup();
  show();
  await user.click(
    await screen.findByRole("button", { name: "Update sandbox check" }),
  );
  expect(
    await screen.findByText("Sandbox check failed: offline suite failed"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Update sandbox check" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(benchmarkApi.getInventory).toHaveBeenCalledTimes(1);
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  expect(benchmarkApi.extendRun).not.toHaveBeenCalled();
});

it("offers renewal when inventory lists the model with a stale proof instead of throwing", async () => {
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration,
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: false,
      reason:
        "capability_missing: Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe",
    },
  ]);
  show();
  expect(
    await screen.findByRole("button", { name: "Update sandbox check" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
});

it("blocks new starts and resumes when the current inventory check failed", async () => {
  vi.mocked(benchmarkApi.getInventory).mockRejectedValue(
    "Inventory check failed",
  );
  show();
  await screen.findByText("Cannot start or continue");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  cleanup();
  const paused = stoppedRun("paused", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-5", outcome: null, score: null },
  ]);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(paused.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(paused.summaries);
  show({ runId: "run-2" });
  await screen.findByText("Cannot start or continue");
  expect(await screen.findByRole("button", { name: "Resume" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});

/** A live test; `kind` is its evaluator, `authoredBy` who wrote it. */
function test(
  index: number,
  name: string,
  kind = "exact",
  authoredBy?: BenchmarkAuthor[],
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

// Written by the candidate: run like any other test, and tagged.
const own = test(6, "Foxtrot", "exact", [configuration]);

/** A live held-out test. */
function heldOut(index: number, name: string): BenchmarkDefinition {
  const base = test(index, name);
  return {
    ...base,
    versions: [
      {
        ...base.versions[0],
        manifest: { ...base.versions[0].manifest, split: "held_out" },
      },
    ],
  };
}

function show(
  options: {
    configuration?: Configuration;
    definitions?: BenchmarkDefinition[];
    runId?: string | null;
    /** Tests the model already has a score on, by version and attempt. */
    measured?: { versionIds: string[]; attemptIds: string[] };
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
        definitions={options.definitions ?? definitions}
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

/** The run's configurations on the runtime the inventory lists today. */
const current = run.request.configurations.map((entry) => ({
  ...entry,
  inventoryRevision: "runtime-now",
}));

function liveRun(state: string): BenchmarkRun {
  return {
    ...run,
    id: "run-2",
    state,
    createdAt: Date.now() - 60_000,
    request: { ...run.request, configurations: current },
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
  vi.mocked(benchmarkApi.providerDataUse).mockResolvedValue([
    {
      providerId: "claude-acp",
      name: "Anthropic",
      trainsOnSubmissions: false,
      stated: false,
    },
  ]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("runs held-out tests for a model whose provider may train on submitted data", async () => {
  const user = userEvent.setup();
  // Every provider runs every split; data use only keeps it from judging.
  vi.mocked(benchmarkApi.providerDataUse).mockResolvedValue([
    {
      providerId: "claude-acp",
      name: "Anthropic",
      trainsOnSubmissions: true,
      stated: true,
    },
  ]);
  show({ definitions: [...definitions, heldOut(10, "Juliet")] });
  await screen.findByRole("dialog");
  const juliet = within(
    screen.getByText("Juliet").closest("label") as HTMLElement,
  );
  expect(juliet.getByRole("checkbox")).toBeChecked();
  expect(juliet.getByRole("checkbox")).toBeEnabled();
  expect(screen.getByText("7 of 7 tests, 21 attempts")).toBeInTheDocument();
  const start = screen.getByRole("button", { name: "Start" });
  await waitFor(() => expect(start).toBeEnabled());
  await user.click(start);
  await waitFor(() => expect(benchmarkApi.startRun).toHaveBeenCalledTimes(1));
  const request = vi.mocked(benchmarkApi.startRun).mock.calls[0][0];
  expect(request.versionIds).toHaveLength(7);
  expect(request.versionIds).toContain("version-10");
});

it("checks a held-out test for a model whose provider does not train on submitted data", async () => {
  show({ definitions: [...definitions, heldOut(10, "Juliet")] });
  await screen.findByRole("dialog");
  const juliet = within(
    screen.getByText("Juliet").closest("label") as HTMLElement,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled(),
  );
  expect(juliet.getByRole("checkbox")).toBeChecked();
  expect(juliet.getByRole("checkbox")).toBeEnabled();
  expect(screen.getByText("7 of 7 tests, 21 attempts")).toBeInTheDocument();
});

it("shows why the runner refused to finish a run", async () => {
  const user = userEvent.setup();
  // A run stopped inside its window that measured Alpha alone.
  const stopped = stoppedRun("needs_attention", [
    { versionId: "version-1", outcome: "pass", score: 1 },
  ]);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(stopped.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(stopped.summaries);
  // The runner has the last word, and the dialog shows its refusal.
  vi.mocked(benchmarkApi.extendRun).mockRejectedValue(
    "model-1 on Bravo: the account's plan no longer offers this model",
  );
  show({ runId: "run-2" });
  await user.click(await screen.findByRole("button", { name: "Start run" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the account's plan no longer offers this model",
  );
});

it("keeps archived versions and development tests out of new runs", async () => {
  show();
  await screen.findByRole("dialog");
  expect(screen.getByText("6 of 6 tests, 18 attempts")).toBeInTheDocument();
  expect(screen.getAllByText("Hotel")).toHaveLength(1);
  expect(screen.queryByText("Golf")).not.toBeInTheDocument();
  expect(screen.queryByText("Infrastructure only")).not.toBeInTheDocument();
});

it("checks every current test, tags the model's own, and runs them on today's runtime", async () => {
  const user = userEvent.setup();
  // The row's newest attempt ran on a runtime that has since changed.
  show({
    configuration: { ...configuration, inventoryRevision: "then" },
    definitions: [...definitions, own],
  });
  const dialog = await screen.findByRole("dialog");
  // The title names the model and its effort; nothing asks for them again.
  expect(within(dialog).getByRole("heading")).toHaveTextContent("model-1");
  expect(within(dialog).getByRole("heading")).toHaveTextContent("high");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  // Seven current tests, all owed but the one the model wrote: its board
  // leaves it out, so it is listed and runnable, never owed.
  expect(screen.getByText("6 of 7 tests, 18 attempts")).toBeInTheDocument();
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Hotel"])
    expect(
      within(screen.getByText(name).closest("label") as HTMLElement).getByRole(
        "checkbox",
      ),
    ).toBeChecked();
  const written = screen.getByText("Foxtrot").closest("label") as HTMLElement;
  expect(within(written).getByRole("checkbox")).not.toBeChecked();
  expect(within(written).getByRole("checkbox")).toBeEnabled();
  expect(within(written).getByText("Own task")).toBeInTheDocument();
  expect(
    within(
      screen.getByText("Alpha").closest("label") as HTMLElement,
    ).queryByText("Own task"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Golf")).not.toBeInTheDocument();
  expect(screen.queryByText("Infrastructure only")).not.toBeInTheDocument();
  await user.click(
    within(screen.getByText("Delta").closest("label") as HTMLElement).getByRole(
      "checkbox",
    ),
  );
  expect(screen.getByText("5 of 7 tests, 15 attempts")).toBeInTheDocument();
  // The own test runs when asked for, for its speed and cost.
  await user.click(within(written).getByRole("checkbox"));
  expect(screen.getByText("6 of 7 tests, 18 attempts")).toBeInTheDocument();
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
      "version-6",
      "version-8",
    ],
    // Every measurement is three repetitions; a case counts only when all pass.
    repetitions: 3,
    // Four hours from Settings, not a field in the dialog.
    timeoutSeconds: 14_400,
    // Five exact tests at one turn, the judged one at one plus three judges,
    // three times over.
    maxExecutions: 27,
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
  expect(screen.getByText("0 of 5 finished")).toBeInTheDocument();
  expect(row("Alpha").getByRole("checkbox")).toBeDisabled();
  await user.click(stop);
  expect(benchmarkApi.cancelRun).toHaveBeenCalledWith("run-2");
});

it("follows the run that measures the model now", async () => {
  show({ runId: "run-2" });
  expect(await screen.findByRole("button", { name: "Stop" })).toBeEnabled();
  expect(benchmarkApi.getRun).toHaveBeenCalledWith("run-2");
  expect(
    await screen.findByText("0 of 5 finished", undefined),
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

it("pauses a running run and resumes a paused one from the dialog", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.pauseRun).mockResolvedValue(liveRun("pausing"));
  show({ runId: "run-2" });
  const pause = await screen.findByRole("button", { name: "Pause" });
  expect(pause).toBeEnabled();
  expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  expect(screen.getByText("Running")).toBeInTheDocument();
  await user.click(pause);
  expect(benchmarkApi.pauseRun).toHaveBeenCalledWith("run-2");
  cleanup();
  // Paused: nothing works or ticks; resume picks the run up.
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(liveRun("paused"));
  vi.mocked(benchmarkApi.resumeRun).mockResolvedValue(liveRun("running"));
  show({ runId: "run-2" });
  const resume = await screen.findByRole("button", { name: "Resume" });
  await waitFor(() => expect(resume).toBeEnabled());
  expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
  // The count still reads the run, not the selection.
  expect(screen.getByText(/of [0-9]+ finished/)).toBeInTheDocument();
  await user.click(resume);
  expect(benchmarkApi.resumeRun).toHaveBeenCalledWith("run-2");
});

it("keeps Stop usable while a pause drains and the views refresh", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.pauseRun).mockResolvedValue(liveRun("pausing"));
  show({ runId: "run-2" });
  const pause = await screen.findByRole("button", { name: "Pause" });
  await waitFor(() => expect(pause).toBeEnabled());
  // From now on the run reads as pausing, and the refresh of the attempt
  // summaries never finishes, as a slow board refresh would.
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(liveRun("pausing"));
  vi.mocked(benchmarkApi.listAttempts).mockReturnValue(new Promise(() => {}));
  await user.click(pause);
  const stop = screen.getByRole("button", { name: "Stop" });
  await waitFor(() => expect(stop).toBeEnabled());
  await user.click(stop);
  expect(benchmarkApi.cancelRun).toHaveBeenCalledWith("run-2");
});

it("reads a stopping run as cancelling and offers no second stop", async () => {
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(liveRun("cancelling"));
  show({ runId: "run-2" });
  expect(await screen.findByText("Cancelling")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
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
  expect(row("Charlie").getByText("≥ 7 s")).toBeInTheDocument();
  expect(
    await row("Charlie").findByRole("img", {
      name: "1 of 1 passed, 1 repetitions",
    }),
  ).toBeInTheDocument();
  expect(row("Echo").getByLabelText("Running")).toBeInTheDocument();
  expect(row("Echo").getByText(/^≥ 2:0[5-7]$/)).toBeInTheDocument();
  expect(screen.getByText("Echo").closest("li")).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  expect(row("Alpha").getByText("Queued")).toBeInTheDocument();
});

it("checks only the tests the board owes, a failure measured in full included, and shows each standing", async () => {
  const user = userEvent.setup();
  // Across older runs Alpha solved three times and Charlie failed three
  // times, both complete cells; Delta passed once, a cell still short.
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
    { ...summary("version-1", "terminal", "pass", 1), id: "s-1a" },
    { ...summary("version-1", "terminal", "pass", 1), id: "s-1b" },
    { ...summary("version-1", "terminal", "pass", 1), id: "s-1c" },
    { ...summary("version-3", "terminal", "fail", 0), id: "s-3a" },
    { ...summary("version-3", "terminal", "fail", 0), id: "s-3b" },
    { ...summary("version-3", "terminal", "fail", 0), id: "s-3c" },
    { ...summary("version-4", "terminal", "pass", 1), id: "s-4" },
  ]);
  const ids = ["s-1a", "s-1b", "s-1c", "s-3a", "s-3b", "s-3c", "s-4"];
  show({
    measured: {
      versionIds: ["version-1", "version-3", "version-4"],
      attemptIds: ids,
    },
  });
  const row = (name: string) =>
    within(screen.getByText(name).closest("label") as HTMLElement);
  // Complete cells stand, passed or failed: only owed tests start checked,
  // and the header names them with their attempts.
  expect(
    await screen.findByText("4 of 6 tests, 12 attempts"),
  ).toBeInTheDocument();
  expect(screen.getByText("Remaining")).toBeInTheDocument();
  for (const name of ["Alpha", "Charlie"])
    expect(row(name).getByRole("checkbox")).not.toBeChecked();
  for (const name of ["Bravo", "Delta", "Echo", "Hotel"])
    expect(row(name).getByRole("checkbox")).toBeChecked();
  expect(
    row("Alpha").getByRole("img", { name: "3 of 3 passed, 3 repetitions" }),
  ).toBeInTheDocument();
  expect(
    row("Charlie").getByRole("img", { name: "0 of 3 passed, 3 repetitions" }),
  ).toBeInTheDocument();
  expect(
    row("Delta").getByRole("img", { name: "1 of 1 passed, 1 repetitions" }),
  ).toBeInTheDocument();
  expect(benchmarkApi.listAttempts).toHaveBeenCalledWith({
    attemptIds: ids,
    limit: 100,
  });
  // A measured test stays one click away.
  await user.click(row("Alpha").getByRole("checkbox"));
  expect(screen.getByText("5 of 6 tests, 15 attempts")).toBeInTheDocument();
  await user.click(row("Alpha").getByRole("checkbox"));
  // Measuring everything again is its own action, with its cost.
  const again = screen.getByRole("button", {
    name: "Measure all again (18 attempts)",
  });
  await waitFor(() => expect(again).toBeEnabled());
  await user.click(again);
  await waitFor(() => expect(benchmarkApi.startRun).toHaveBeenCalledTimes(1));
  expect(
    vi.mocked(benchmarkApi.startRun).mock.calls[0][0].versionIds,
  ).toHaveLength(6);
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
      // Planned on the runtime the inventory lists today.
      request: { ...run.request, repetitions: 3, configurations: current },
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
  const finish = await screen.findByRole("button", { name: "Start run" });
  // The hint counts the queued tests with the added ones, those that keep
  // repetitions already scored, and names the deadline.
  expect(screen.getByText("Remaining")).toBeInTheDocument();
  expect(screen.getByText("Archives")).toBeInTheDocument();
  // The run's tests are fixed; the ones it lacks join it unless unchecked.
  const row = (name: string) =>
    within(screen.getByText(name).closest("label") as HTMLElement);
  expect(row("Alpha").getByRole("checkbox")).toBeChecked();
  expect(row("Alpha").getByRole("checkbox")).toBeDisabled();
  expect(row("Delta").getByRole("checkbox")).toBeChecked();
  expect(row("Delta").getByRole("checkbox")).toBeEnabled();
  await user.click(row("Bravo").getByRole("checkbox"));
  expect(screen.getByText("Remaining")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Start" }),
  ).not.toBeInTheDocument();
  await user.click(finish);
  expect(benchmarkApi.extendRun).toHaveBeenCalledWith(
    "run-2",
    ["version-4"],
    [],
  );
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
});

it("says a run's window closed and offers a new run for the tests it still owed", async () => {
  const user = userEvent.setup();
  // Alpha passed and Charlie failed in full; Echo never started. The run
  // was paused for two hours, which its window leaves out, and still closed.
  const expired = stoppedRun("cancelled", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-3", outcome: "fail", score: 0 },
    { versionId: "version-5", outcome: null, score: null },
  ]);
  expired.run.createdAt = Date.now() - 27 * 3_600_000;
  expired.run.pausedMs = 2 * 3_600_000;
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(expired.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(expired.summaries);
  // The board holds the run's complete cells.
  show({
    runId: "run-2",
    measured: {
      versionIds: ["version-1", "version-3"],
      attemptIds: expired.summaries.map((entry) => entry.id),
    },
  });
  const start = await screen.findByRole("button", { name: "Start" });
  await waitFor(() => expect(start).toBeEnabled());
  expect(screen.getByRole("alert")).toHaveTextContent(/This run is archived/);
  // Nothing offers to go on with the closed run.
  for (const name of ["Resume", "Pause", "Start run"])
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  const row = (name: string) =>
    within(screen.getByText(name).closest("label") as HTMLElement);
  expect(row("Alpha").getByRole("checkbox")).not.toBeChecked();
  expect(row("Charlie").getByRole("checkbox")).not.toBeChecked();
  expect(row("Echo").getByRole("checkbox")).toBeChecked();
  expect(row("Bravo").getByRole("checkbox")).toBeChecked();
  expect(row("Echo").getByRole("checkbox")).toBeEnabled();
  await user.click(start);
  expect(benchmarkApi.startRun).toHaveBeenCalledWith(
    expect.objectContaining({
      versionIds: expect.not.arrayContaining(["version-1", "version-3"]),
    }),
  );
  expect(vi.mocked(benchmarkApi.startRun).mock.calls[0]).toHaveLength(1);
  expect(benchmarkApi.resumeRun).not.toHaveBeenCalled();
});

it("says a paused run made for an older runtime cannot go on and offers only Stop", async () => {
  const user = userEvent.setup();
  const old = stoppedRun("paused", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-5", outcome: null, score: null },
  ]);
  // Planned on a sandbox version the inventory no longer lists.
  old.run.request.configurations = old.run.request.configurations.map(
    (entry) => ({ ...entry, inventoryRevision: "older-sandbox" }),
  );
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(old.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(old.summaries);
  vi.mocked(benchmarkApi.cancelRun).mockResolvedValue({
    ...old.run,
    state: "cancelled",
  });
  show({ runId: "run-2" });
  expect(
    await screen.findByText(/This run used an earlier execution environment/),
  ).toHaveTextContent(/Stop it, then start a new run for the remaining tests/);
  for (const name of ["Resume", "Pause", "Start run", "Start"])
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(benchmarkApi.cancelRun).toHaveBeenCalledWith("run-2");
  expect(benchmarkApi.resumeRun).not.toHaveBeenCalled();
});

it("offers a new run for the owed tests once a run made for an older runtime is stopped", async () => {
  const user = userEvent.setup();
  const old = stoppedRun("cancelled", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-5", outcome: null, score: null },
  ]);
  old.run.request.configurations = old.run.request.configurations.map(
    (entry) => ({ ...entry, inventoryRevision: "older-sandbox" }),
  );
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(old.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(old.summaries);
  show({
    runId: "run-2",
    measured: {
      versionIds: ["version-1"],
      attemptIds: old.summaries.map((entry) => entry.id),
    },
  });
  const start = await screen.findByRole("button", { name: "Start" });
  await waitFor(() => expect(start).toBeEnabled());
  expect(
    screen.getByText(/This run used an earlier execution environment/),
  ).toBeInTheDocument();
  expect(screen.getByText("New run required")).toBeInTheDocument();
  expect(screen.queryByText(/Stop it/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Start run" }),
  ).not.toBeInTheDocument();
  const row = (name: string) =>
    within(screen.getByText(name).closest("label") as HTMLElement);
  expect(row("Alpha").getByRole("checkbox")).not.toBeChecked();
  expect(row("Echo").getByRole("checkbox")).toBeChecked();
  await user.click(start);
  await waitFor(() => expect(benchmarkApi.startRun).toHaveBeenCalledTimes(1));
  const [request, replacing] = vi.mocked(benchmarkApi.startRun).mock.calls[0];
  expect(replacing).toBeUndefined();
  expect(request.versionIds).toHaveLength(5);
  expect(request.versionIds).not.toContain("version-1");
  // The new run is pinned to today's runtime.
  expect(request.configurations[0].inventoryRevision).toBe("runtime-now");
  expect(benchmarkApi.extendRun).not.toHaveBeenCalled();
});

it("owes exactly what the board names incomplete, a carried cell included", async () => {
  // The board counts Bravo complete through a cell carried from its earlier
  // version, which no standing attempt of the current version shows.
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkModelRunDialog
        row={leaderboardRow({
          configuration,
          scoredVersionIds: ["version-2"],
          attemptIds: [],
          completeVersionIds: ["version-2"],
        })}
        definitions={definitions}
        runId={null}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("5 of 6 tests, 15 attempts"),
  ).toBeInTheDocument();
  expect(
    within(screen.getByText("Bravo").closest("label") as HTMLElement).getByRole(
      "checkbox",
    ),
  ).not.toBeChecked();
});

/** Today's inventory lists the model on both profiles. */
function bothProfiles(repositoryRevision = "repository-now") {
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration: { ...configuration, inventoryRevision: "runtime-now" },
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: true,
      reason: null,
    },
    {
      configuration: {
        ...configuration,
        id: "config-1-repository",
        executionProfile: "protected_repository",
        inventoryRevision: repositoryRevision,
      },
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: true,
      reason: null,
    },
  ]);
}

/** A live repository test. */
function repositoryTest(index: number, name: string): BenchmarkDefinition {
  const base = test(index, name, "repository");
  return {
    ...base,
    versions: [
      {
        ...base.versions[0],
        manifest: {
          ...base.versions[0].manifest,
          executionProfile: "protected_repository",
        },
      },
    ],
  };
}

it("starts a mixed suite with one configuration per profile", async () => {
  const user = userEvent.setup();
  bothProfiles();
  show({ definitions: [test(1, "Alpha"), repositoryTest(2, "Ledger")] });
  const start = await screen.findByRole("button", { name: "Start" });
  await waitFor(() => expect(start).toBeEnabled());
  await user.click(start);
  await waitFor(() => expect(benchmarkApi.startRun).toHaveBeenCalledTimes(1));
  const request = vi.mocked(benchmarkApi.startRun).mock.calls[0][0];
  expect(
    request.configurations.map((entry) => [
      entry.executionProfile,
      entry.inventoryRevision,
    ]),
  ).toEqual([
    ["native_text", "runtime-now"],
    ["protected_repository", "repository-now"],
  ]);
  expect(request.versionIds).toEqual(
    expect.arrayContaining(["version-1", "version-2"]),
  );
});

it("starts text tests alone on the text configuration", async () => {
  const user = userEvent.setup();
  bothProfiles();
  show({ definitions: [test(1, "Alpha"), test(3, "Charlie")] });
  const start = await screen.findByRole("button", { name: "Start" });
  await waitFor(() => expect(start).toBeEnabled());
  await user.click(start);
  await waitFor(() => expect(benchmarkApi.startRun).toHaveBeenCalledTimes(1));
  const request = vi.mocked(benchmarkApi.startRun).mock.calls[0][0];
  expect(request.configurations.map((entry) => entry.executionProfile)).toEqual(
    ["native_text"],
  );
});

it("says why a repository test cannot start when the model has no repository configuration", async () => {
  show({ definitions: [test(1, "Alpha"), repositoryTest(2, "Ledger")] });
  expect(
    await screen.findByText(
      /Test model on repository tasks|model-1 on repository tasks/,
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
});

it("finishes a text run with repository tests by bringing the repository configuration in", async () => {
  const user = userEvent.setup();
  bothProfiles();
  // A stopped text run that measured Alpha; the Ledger test joins it.
  const stopped = stoppedRun("needs_attention", [
    { versionId: "version-1", outcome: "pass", score: 1 },
  ]);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(stopped.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(stopped.summaries);
  vi.mocked(benchmarkApi.extendRun).mockResolvedValue({
    ...stopped.run,
    state: "running",
  });
  show({
    runId: "run-2",
    definitions: [test(1, "Alpha"), repositoryTest(2, "Ledger")],
  });
  const finish = await screen.findByRole("button", { name: "Start run" });
  await waitFor(() => expect(finish).toBeEnabled());
  await user.click(finish);
  expect(benchmarkApi.extendRun).toHaveBeenCalledWith(
    "run-2",
    ["version-2"],
    [
      expect.objectContaining({
        executionProfile: "protected_repository",
        inventoryRevision: "repository-now",
      }),
    ],
  );
});

it("finishes an old text run that already holds a repository test on its repository configuration", async () => {
  const user = userEvent.setup();
  bothProfiles();
  // Planned before runs carried one configuration per profile: the Ledger
  // test sits on the text configuration, cancelled.
  const old = stoppedRun("cancelled", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-2", outcome: "cancelled", score: null },
  ]);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(old.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(old.summaries);
  vi.mocked(benchmarkApi.extendRun).mockResolvedValue({
    ...old.run,
    state: "running",
  });
  show({
    runId: "run-2",
    definitions: [test(1, "Alpha"), repositoryTest(2, "Ledger")],
  });
  const finish = await screen.findByRole("button", { name: "Start run" });
  await waitFor(() => expect(finish).toBeEnabled());
  await user.click(finish);
  // The wrongly paired test reads as missing and goes to its own profile.
  expect(benchmarkApi.extendRun).toHaveBeenCalledWith(
    "run-2",
    ["version-2"],
    [expect.objectContaining({ executionProfile: "protected_repository" })],
  );
  expect(
    within(
      screen.getByText("Ledger").closest("label") as HTMLElement,
    ).getByRole("checkbox"),
  ).toBeChecked();
});

it("keeps a run going when only a profile with nothing left went stale", async () => {
  // Every repository test is complete; its pin moved; the text test is left.
  bothProfiles("repository-newer");
  const paused = stoppedRun("paused", [
    { versionId: "version-1", outcome: null, score: null },
    { versionId: "version-2", outcome: "pass", score: 1 },
  ]);
  const repositoryConfiguration = {
    ...configuration,
    id: "config-1-repository",
    executionProfile: "protected_repository",
    inventoryRevision: "repository-now",
  };
  paused.run.request.configurations = [
    ...paused.run.request.configurations,
    repositoryConfiguration,
  ];
  paused.run.attempts = paused.run.attempts.map((attempt) =>
    attempt.versionId === "version-2"
      ? { ...attempt, configuration: repositoryConfiguration }
      : attempt,
  );
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(paused.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(paused.summaries);
  show({
    runId: "run-2",
    definitions: [test(1, "Alpha"), repositoryTest(2, "Ledger")],
  });
  const resume = await screen.findByRole("button", { name: "Resume" });
  await waitFor(() => expect(resume).toBeEnabled());
  expect(screen.queryByText(/older sandbox or CLI version/)).toBeNull();
});

it("stops a run whose repository configuration went stale", async () => {
  bothProfiles("repository-newer");
  const paused = stoppedRun("paused", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-2", outcome: null, score: null },
  ]);
  paused.run.request.configurations = [
    ...paused.run.request.configurations,
    {
      ...configuration,
      id: "config-1-repository",
      executionProfile: "protected_repository",
      inventoryRevision: "repository-now",
    },
  ];
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(paused.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(paused.summaries);
  show({
    runId: "run-2",
    definitions: [test(1, "Alpha"), repositoryTest(2, "Ledger")],
  });
  expect(
    await screen.findByText(/This run used an earlier execution environment/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});

it("waits for today's inventory before offering to resume a paused run", async () => {
  const paused = stoppedRun("paused", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-5", outcome: null, score: null },
  ]);
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(paused.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(paused.summaries);
  let answer: (
    value: Awaited<ReturnType<typeof benchmarkApi.getInventory>>,
  ) => void = () => {};
  vi.mocked(benchmarkApi.getInventory).mockReturnValue(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  show({ runId: "run-2" });
  const resume = await screen.findByRole("button", { name: "Resume" });
  expect(resume).toBeDisabled();
  answer([
    {
      configuration: { ...configuration, inventoryRevision: "runtime-now" },
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: true,
      reason: null,
    },
  ]);
  await waitFor(() => expect(resume).toBeEnabled());
});

it("shows the test list's scrollbar", async () => {
  show();
  await screen.findByRole("dialog");
  expect(screen.getByRole("list")).toHaveClass("scrollbar-visible");
});

it("keeps a run open past 24 hours by the time it spent paused", async () => {
  const stopped = stoppedRun("paused", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-5", outcome: null, score: null },
  ]);
  // Started 25 hours ago, paused for the last two.
  stopped.run.createdAt = Date.now() - 25 * 3_600_000;
  stopped.run.pausedSince = Date.now() - 2 * 3_600_000;
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(stopped.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(stopped.summaries);
  show({ runId: "run-2" });
  expect(await screen.findByRole("button", { name: "Resume" })).toBeEnabled();
  expect(screen.queryByText(/window, pauses left out, is over/)).toBeNull();
});

async function settleClockQueries() {
  // Query notifications are queued separately from the promises they observe.
  for (let index = 0; index < 4; index += 1)
    await act(async () => vi.advanceTimersByTimeAsync(1));
}

it("ticks only the running row while keeping settled tests still", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  const currentRun = liveRun("running");
  currentRun.attempts = currentRun.attempts.map((entry) =>
    entry.versionId === "version-5"
      ? {
          ...entry,
          startedAt: Date.now() - 5_000,
          finishedAt: null,
          durationMs: null,
        }
      : entry,
  );
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(currentRun);
  show({
    runId: "run-2",
    definitions: [
      ...definitions,
      ...Array.from({ length: 200 }, (_, index) =>
        test(index + 100, `Invented ${index}`),
      ),
    ],
  });
  await settleClockQueries();
  const live = within(screen.getByText("Echo").closest("li") as HTMLElement);
  expect(live.getByText("≥ 5 s")).toBeInTheDocument();
  checkboxRenders.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(live.getByText("≥ 6 s")).toBeInTheDocument();
  expect(checkboxRenders).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("checkbox")).toHaveLength(207);
});

it("keeps paused rows still, updates the archive date, and expires only after the resumed window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  const stopped = stoppedRun("paused", [
    { versionId: "version-1", outcome: "pass", score: 1 },
    { versionId: "version-5", outcome: null, score: null },
  ]);
  stopped.run.createdAt = Date.now() - 24 * 3_600_000 + 1_500;
  stopped.run.pausedSince = Date.now();
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(stopped.run);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(stopped.summaries);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BenchmarkModelRunDialog
        row={leaderboardRow({})}
        definitions={definitions}
        runId="run-2"
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await settleClockQueries();
  expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
  const archiveTime = screen
    .getByLabelText("Run overview")
    .querySelectorAll("time")[1];
  const initialArchive = Date.parse(archiveTime.dateTime);
  checkboxRenders.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(Date.parse(archiveTime.dateTime)).toBe(initialArchive + 3_000);
  expect(checkboxRenders).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
  // Cancelling/resuming removes the open pause and saves its accumulated time.
  const resumed = {
    ...stopped.run,
    state: "cancelled",
    pausedSince: null,
    pausedMs: 3_000,
  };
  act(() => client.setQueryData(["benchmarks", "run", "run-2"], resumed));
  await settleClockQueries();
  expect(screen.getByRole("button", { name: "Start run" })).toBeEnabled();
  checkboxRenders.mockClear();
  const remaining = runWindowCloses(resumed) - Date.now();
  await act(async () => vi.advanceTimersByTimeAsync(remaining - 1));
  expect(checkboxRenders).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Start run" })).toBeEnabled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(
    screen.queryByRole("button", { name: "Start run" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  expect(screen.getByText(/This run is archived/)).toBeInTheDocument();
  // Memoized rows still receive changed selection and are not frozen at expiry.
  const alpha = within(
    screen.getByText("Alpha").closest("label") as HTMLElement,
  ).getByRole("checkbox");
  const wasChecked = alpha.getAttribute("aria-checked");
  fireEvent.click(alpha);
  expect(alpha.getAttribute("aria-checked")).not.toBe(wasChecked);
  client.clear();
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
  show({
    runId: "run-2",
    measured: {
      versionIds: complete.summaries.map((entry) => entry.versionId),
      attemptIds: complete.summaries.map((entry) => entry.id),
    },
  });
  const again = await screen.findByRole("button", {
    name: "Measure all again (18 attempts)",
  });
  await waitFor(() => expect(again).toBeEnabled());
  expect(screen.getByRole("alert")).toHaveTextContent(
    /All tests measured. Measuring again starts a new paid run/,
  );
  expect(
    screen.queryByRole("button", { name: "Start run" }),
  ).not.toBeInTheDocument();
  // Nothing is owed, so nothing starts checked and Start says why it waits.
  expect(screen.getByText("0 of 6 tests, 0 attempts")).toBeInTheDocument();
  expect(screen.getByText("Measured")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  await user.click(again);
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
    screen.queryByRole("button", { name: "Start run" }),
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
