import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import type { Attempt, BenchmarkDefinition, BenchmarkRun } from "../types";
import { BenchmarkRunDrawer } from "../ui/BenchmarkRunDrawer";
import { attempt, configuration, definition, run } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: {
    getRun: vi.fn(),
    listAttempts: vi.fn(),
    listDefinitions: vi.fn(),
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
  },
}));

const named = (id: string, name: string): BenchmarkDefinition => ({
  ...definition,
  id: `definition-${id}`,
  versions: [
    {
      ...definition.versions[0],
      id,
      manifest: { ...definition.versions[0].manifest, name },
    },
  ],
});

const at = (overrides: Partial<Attempt>): Attempt => ({
  ...attempt,
  ...overrides,
});

function attempts(): Attempt[] {
  return [
    at({
      id: "a-1",
      versionId: "version-a",
      startedAt: 10_000,
      finishedAt: 22_000,
    }),
    at({
      id: "a-2",
      versionId: "version-b",
      phase: "running",
      outcome: null,
      startedAt: Date.now() - 65_000,
      finishedAt: null,
      durationMs: null,
    }),
    at({
      id: "a-3",
      versionId: "version-c",
      phase: "pending",
      outcome: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    }),
  ];
}

function show(subject: BenchmarkRun) {
  vi.mocked(benchmarkApi.getRun).mockResolvedValue(subject);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDrawer
        runId={subject.id}
        onClose={vi.fn()}
        onEvidence={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

const row = (name: string) =>
  within(screen.getByText(name).closest("li") as HTMLElement);

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([
    named("version-a", "Alpha"),
    named("version-b", "Bravo"),
    named("version-c", "Charlie"),
  ]);
  vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
    {
      id: "a-1",
      runId: run.id,
      versionId: "version-a",
      modelId: "model-1",
      repetition: 0,
      phase: "terminal",
      outcome: "pass",
      finishedAt: 22_000,
      durationMs: 11_000,
      outputTokens: null,
      cost: null,
      score: 1,
    },
  ]);
});
afterEach(cleanup);

it("lists one model's run by test, in its order, timing the test running now", async () => {
  show({ ...run, state: "running", attempts: attempts() });
  expect(await screen.findByText("Alpha")).toBeInTheDocument();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("heading")).toHaveTextContent("model-1");
  expect(within(dialog).getByRole("heading")).toHaveTextContent("high");
  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent ?? ""),
  ).toEqual([
    expect.stringMatching(/^Alpha/),
    expect.stringMatching(/^Bravo/),
    expect.stringMatching(/^Charlie/),
  ]);
  expect(await row("Alpha").findByLabelText("Pass")).toBeInTheDocument();
  expect(row("Alpha").getByText("12 s")).toBeInTheDocument();
  expect(row("Bravo").getByLabelText("Running")).toBeInTheDocument();
  expect(row("Bravo").getByText(/^1 min [5-7] s$/)).toBeInTheDocument();
  expect(screen.getByText("Bravo").closest("li")).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(row("Charlie").getByText("Queued")).toBeInTheDocument();
  expect(
    row("Charlie").getByRole("button", { name: "Inspect" }),
  ).toBeDisabled();
  // One model's run names it once, in the title, not on every row.
  expect(screen.queryByText(/claude-acp/)).not.toBeInTheDocument();
  expect(screen.getByText("1 / 3 attempts settled")).toBeInTheDocument();
});

it("keeps a paused run's waiting tests queued and names each model of a matrix", async () => {
  const second = { ...configuration, id: "config-2", modelId: "model-2" };
  show({
    ...run,
    id: "run-matrix",
    state: "paused",
    request: {
      ...run.request,
      configurations: [configuration, second],
    },
    attempts: [
      ...attempts().slice(0, 1),
      at({
        id: "a-4",
        versionId: "version-c",
        configuration: second,
        phase: "pending",
        outcome: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      }),
    ],
  });
  expect(await screen.findByText("Charlie")).toBeInTheDocument();
  expect(screen.getByText("Run run-matr")).toBeInTheDocument();
  expect(row("Charlie").getByText("Queued")).toBeInTheDocument();
  expect(row("Charlie").getByText(/model-2/)).toBeInTheDocument();
  expect(row("Alpha").getByText(/model-1/)).toBeInTheDocument();
});

it("shows a test the provider's usage limit put back as waiting, not queued", async () => {
  const limit = JSON.stringify({
    code: -32000,
    message:
      "Authentication required: 403 You've reached your 5-hour usage limit.",
  });
  show({
    ...run,
    state: "running",
    attempts: [
      ...attempts().slice(0, 1),
      at({
        id: "a-3",
        versionId: "version-c",
        phase: "pending",
        outcome: null,
        reason: limit,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      }),
    ],
  });
  expect(await screen.findByText("Charlie")).toBeInTheDocument();
  const waiting = row("Charlie").getByText("Usage limit, waiting");
  expect(waiting).toHaveAttribute("title", limit);
  expect(row("Charlie").queryByText("Queued")).not.toBeInTheDocument();
  // The run's place in the queue is the waiting test.
  expect(screen.getByText("Charlie").closest("li")).toHaveAttribute(
    "aria-current",
    "step",
  );
});

it("says when a waiting test is tried again, where the runner knows", async () => {
  const waitingOn = (id: string, versionId: string, more: Partial<Attempt>) =>
    at({
      id,
      versionId,
      phase: "pending",
      outcome: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      ...more,
    });
  const until = Date.now() + 10 * 60_000;
  const time = new Date(until).toLocaleTimeString("en", { timeStyle: "short" });
  const busy =
    "another Grok test still runs on the sign-in that is due for renewal; this test starts when it finishes";
  show({
    ...run,
    state: "running",
    attempts: [
      waitingOn("a-1", "version-a", {
        reason: "You've reached your 5-hour usage limit.",
        waitUntil: until,
      }),
      waitingOn("a-2", "version-b", {
        reason: "The Grok sign-in expires too soon for this test",
        waitUntil: until,
      }),
      waitingOn("a-3", "version-c", { reason: busy }),
    ],
  });
  expect(await screen.findByText("Charlie")).toBeInTheDocument();
  expect(
    row("Alpha").getByText(`Usage limit, next try at ${time}`),
  ).toBeInTheDocument();
  expect(
    row("Bravo").getByText(`Grok sign-in renews at ${time}`),
  ).toBeInTheDocument();
  // A wait for another test names what it waits for instead of a time.
  expect(
    row("Charlie").getByText("Waits for a running Grok test"),
  ).toHaveAttribute("title", busy);
});

it("shows a run the usage limit stopped as stopped, for the operator", async () => {
  const stopped =
    "A test did not finish: the usage limit ran out and does not reset in time for the run to wait. You've reached your weekly usage limit.";
  show({
    ...run,
    state: "needs_attention",
    attempts: [
      at({
        id: "a-3",
        versionId: "version-c",
        phase: "pending",
        outcome: null,
        reason: stopped,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      }),
    ],
  });
  expect(await screen.findByText("Charlie")).toBeInTheDocument();
  expect(row("Charlie").getByText("Usage limit, stopped")).toHaveAttribute(
    "title",
    stopped,
  );
  expect(screen.getByText("Needs attention")).toBeInTheDocument();
});
