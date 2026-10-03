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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { benchmarkApi } from "../api/benchmarks";
import { BenchmarkAttemptList } from "../ui/BenchmarkAttemptList";
import { BenchmarkEditor } from "../ui/BenchmarkEditor";
import { BenchmarksView } from "../ui/BenchmarksView";
import { LeaderboardView } from "../ui/LeaderboardView";
import { BenchmarkConfigurationPage } from "../ui/BenchmarkConfigurationPage";
import { rowKey } from "../lib/benchmarkBoards";
import { NerfBenchView } from "../ui/NerfBenchView";
import { BenchmarkRoutingDialog } from "../ui/BenchmarkRoutingDialog";
import {
  BenchmarkExportDialog,
  BenchmarkImportDialog,
  BenchmarkSchedulesDialog,
} from "../ui/BenchmarkManagementDialogs";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import type { BenchmarkLocation } from "../lib/benchmarkNavigation";
import {
  attempt,
  attemptSummary,
  cohort,
  configuration,
  definition,
  draft,
  leaderboardRow,
  run,
  runSummary,
} from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) =>
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error),
  benchmarkApi: {
    listDefinitions: vi.fn(),
    listRuns: vi.fn(),
    listAttempts: vi.fn(),
    getRun: vi.fn(),
    getEvidence: vi.fn(),
    listBaselines: vi.fn(),
    getLeaderboard: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    listDesigns: vi.fn(),
    getRoutingEvidence: vi.fn(),
    getUsageSeries: vi.fn(),
    getComparisons: vi.fn(),
    getUsageComparisons: vi.fn(),
    listSchedules: vi.fn(),
    saveSchedule: vi.fn(),
    saveDraft: vi.fn(),
    validateDraft: vi.fn(),
    publishVersion: vi.fn(),
    getInventory: vi.fn(),
    getCapabilities: vi.fn(),
    getCandidateObservations: vi.fn(),
    listCatalog: vi.fn(),
    startRun: vi.fn(),
    previewRun: vi.fn(),
    eventsSince: vi.fn(),
    listen: vi.fn(),
    exportDataset: vi.fn(),
    generateVariant: vi.fn(),
    importDefinition: vi.fn(),
  },
}));
vi.mock("@/features/stats/lib/usageLedger", () => ({
  projectBenchmarkUsage: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));

const scopeProps = {
  loading: false,
  scope: { versionId: "all", runId: "all" },
  onScopeChange: vi.fn(),
  suiteOptions: [{ value: "all", label: "All published versions" }],
  runOptions: [{ value: "all", label: "All runs" }],
  page: 0,
  pageSize: 50,
  onPageChange: vi.fn(),
};

function wrap(content: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>{content}</QueryClientProvider>,
  );
  return {
    ...view,
    rerender: (next: ReactNode) =>
      view.rerender(
        <QueryClientProvider client={client}>{next}</QueryClientProvider>,
      ),
  };
}

describe("benchmark authoring and saved evidence", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = () => false;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.scrollIntoView = () => {};
    useBenchmarkViewStore.setState({ dirty: false, pending: null });
    vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([definition]);
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([runSummary]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getRun).mockResolvedValue(run);
    vi.mocked(benchmarkApi.getEvidence).mockResolvedValue(attempt);
    vi.mocked(benchmarkApi.listBaselines).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getCandidateObservations).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listCatalog).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listDesigns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort: null,
      rows: [],
    });
    vi.mocked(benchmarkApi.getUsageSeries).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listSchedules).mockResolvedValue([]);
    vi.mocked(benchmarkApi.eventsSince).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listen).mockResolvedValue(() => {});
  });
  it("saves the current revision before immutable publication", async () => {
    const user = userEvent.setup();
    const saved = {
      ...definition,
      draftRevision: 2,
      draft: { ...draft, name: "Revised extraction" },
    };
    vi.mocked(benchmarkApi.saveDraft).mockResolvedValue(saved);
    vi.mocked(benchmarkApi.publishVersion).mockResolvedValue(
      definition.versions[0],
    );
    wrap(
      <BenchmarkEditor
        definition={definition}
        onSaved={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "Revised extraction",
    );
    expect(useBenchmarkViewStore.getState().dirty).toBe(true);
    await user.click(screen.getByRole("button", { name: "Publish version" }));
    await waitFor(() =>
      expect(benchmarkApi.publishVersion).toHaveBeenCalledWith(
        "definition-1",
        2,
      ),
    );
    expect(benchmarkApi.saveDraft).toHaveBeenCalledWith(
      "definition-1",
      1,
      expect.objectContaining({ name: "Revised extraction" }),
    );
    expect(useBenchmarkViewStore.getState().dirty).toBe(false);
  });
  it("retains dirty text after an optimistic conflict", async () => {
    vi.mocked(benchmarkApi.saveDraft).mockRejectedValue({
      code: "revision_conflict",
      message: "A newer draft exists",
    });
    wrap(
      <BenchmarkEditor
        definition={definition}
        onSaved={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "new prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A newer draft exists",
    );
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue(
      "new prompt",
    );
    expect(useBenchmarkViewStore.getState().dirty).toBe(true);
  });
  it("rejects an empty fixture path before IPC", async () => {
    wrap(
      <BenchmarkEditor
        definition={definition}
        onSaved={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add fixture" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "fixture body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("alert");
    expect(benchmarkApi.saveDraft).not.toHaveBeenCalled();
  });
  it("hides single-value execution limits that the catalog fixes", () => {
    wrap(
      <BenchmarkEditor
        definition={definition}
        onSaved={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("spinbutton", { name: /turns/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /network/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Time limit (seconds)" }),
    ).toHaveValue(120);
  });
  it("opens every view without probing inventory or starting inference", async () => {
    function Workspace() {
      const [location, setLocation] = useState<BenchmarkLocation>({
        section: "leaderboard",
      });
      return (
        <BenchmarksView
          location={location}
          onNavigate={setLocation}
          onSelectSession={vi.fn()}
        />
      );
    }
    wrap(<Workspace />);
    await screen.findByText("No results for this selection.");
    for (const label of [
      "Design Bench",
      "Bench development",
      "Nerf Bench",
      "Usage Bench",
      "Leaderboard",
    ]) {
      await userEvent.click(screen.getByRole("tab", { name: label }));
    }
    expect(benchmarkApi.getInventory).not.toHaveBeenCalled();
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("replaces the run dialog with captured evidence when Inspect is clicked", async () => {
    function Workspace() {
      const [location, setLocation] = useState<BenchmarkLocation>({
        section: "leaderboard",
        runId: run.id,
      });
      return (
        <BenchmarksView
          location={location}
          onNavigate={setLocation}
          onSelectSession={vi.fn()}
        />
      );
    }
    wrap(<Workspace />);
    const drawer = await screen.findByRole("dialog", { name: "Run run-1" });
    await userEvent.click(
      await within(drawer).findByRole("button", { name: "Inspect" }),
    );
    const evidence = await screen.findByRole("dialog", {
      name: "claude-acp / model-1 / high",
    });
    expect(
      await within(evidence).findByText("Captured output"),
    ).toBeInTheDocument();
    expect(
      within(evidence).getByText("4", { selector: "pre" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Run run-1" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("shows an unfinished configuration without a rank and opens its page", async () => {
    const inspect = vi.fn();
    const open = vi.fn();
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([attemptSummary]);
    const unfinished = leaderboardRow({
      passed: 0,
      scored: 0,
      attempted: 0,
      planned: 4,
      quality: null,
      medianDurationMs: null,
      medianOutputTokens: null,
      cost: null,
      measuredAt: null,
      points: null,
      efficiencyPoints: null,
      speedPoints: null,
      costPoints: null,
      status: "preliminary",
      reason: "No valid evidence",
      missingVersionIds: ["version-1"],
    });
    const report = { cohort, rows: [unfinished] };
    wrap(<LeaderboardView {...scopeProps} report={report} onOpen={open} />);
    const row = screen.getByRole("row", { name: /model-1/ });
    expect(within(row).getAllByRole("cell")[0]).toHaveTextContent("–");
    expect(within(row).getByText("Preliminary")).toBeInTheDocument();
    expect(within(row).getByText("0 / 4 measured")).toBeInTheDocument();
    // Rank, points, price and context all stay unknown.
    expect(within(row).getAllByText("–")).toHaveLength(4);
    expect(row).not.toHaveTextContent("0.0%");
    // Nothing explains itself in prose above the rows.
    expect(screen.queryByText(/scored ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/configurations shown/)).not.toBeInTheDocument();
    await userEvent.click(
      within(row).getByRole("button", { name: "Open model-1" }),
    );
    expect(open).toHaveBeenCalledWith(rowKey(unfinished));
    cleanup();
    const catchUp = vi.fn();
    wrap(
      <BenchmarkConfigurationPage
        row={unfinished}
        report={report}
        runs={[]}
        versions={definition.versions}
        onEvidence={inspect}
        onRun={catchUp}
        onOpenRun={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "model-1" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Preliminary")).toBeInTheDocument();
    // The service's English reason is not page text; the badge explains on hold.
    expect(screen.queryByText("No valid evidence")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Run the 1 missing case" }),
    );
    expect(catchUp).toHaveBeenCalledWith(["version-1"]);
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText("Integer transformation"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(inspect).toHaveBeenCalledWith("attempt-1");
    expect(benchmarkApi.listAttempts).toHaveBeenCalledWith({
      attemptIds: ["attempt-1"],
      offset: 0,
      limit: 50,
    });
  });
  it("does not offer gaps an unfinished run already plans again", async () => {
    vi.mocked(benchmarkApi.getHistory).mockResolvedValue([]);
    const catchUp = vi.fn();
    const openRun = vi.fn();
    const gaps = leaderboardRow({
      status: "preliminary",
      missingVersionIds: ["version-1", "version-2"],
    });
    const queued = {
      ...runSummary,
      id: "active-run-1",
      state: "paused",
      request: { ...runSummary.request, versionIds: ["version-1"] },
    };
    const { rerender } = wrap(
      <BenchmarkConfigurationPage
        row={gaps}
        report={{ cohort, rows: [gaps] }}
        runs={[queued, runSummary]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={catchUp}
        onOpenRun={openRun}
        onBack={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Run the 1 missing case" }),
    );
    expect(catchUp).toHaveBeenCalledWith(["version-2"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Queued in run active-r" }),
    );
    expect(openRun).toHaveBeenCalledWith("active-run-1");
    rerender(
      <BenchmarkConfigurationPage
        row={gaps}
        report={{ cohort, rows: [gaps] }}
        runs={[
          {
            ...queued,
            request: {
              ...queued.request,
              versionIds: ["version-1", "version-2"],
            },
          },
        ]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={catchUp}
        onOpenRun={openRun}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /missing case/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Queued in run active-r" }),
    ).toBeInTheDocument();
  });
  it("starts a catch-up from the model page on today's runtime", async () => {
    const stale = {
      ...configuration,
      inventoryRevision: "runtime-of-the-last-attempt",
    };
    const unfinished = leaderboardRow({
      configuration: stale,
      status: "preliminary",
      missingVersionIds: ["version-1"],
    });
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort,
      rows: [unfinished],
    });
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getHistory).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getCapabilities).mockResolvedValue([]);
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
    vi.mocked(invoke).mockResolvedValue({
      accounts: [],
      defaults: {},
      automaticSwitching: {},
    });
    wrap(
      <BenchmarksView
        location={{
          section: "leaderboard",
          configurationId: rowKey(unfinished),
        }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Run the 1 missing case" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Run benchmarks",
    });
    expect(await within(dialog).findByText("1 execution")).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Check plan" }),
    );
    await waitFor(() =>
      expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
        expect.objectContaining({
          versionIds: ["version-1"],
          configurations: [
            expect.objectContaining({
              modelId: "model-1",
              effort: "high",
              inventoryRevision: "runtime-now",
            }),
          ],
        }),
      ),
    );
    expect(benchmarkApi.getInventory).toHaveBeenCalledWith(
      "claude-acp",
      "account-1",
    );
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("starts a different attempt set on its first page", async () => {
    vi.mocked(benchmarkApi.listAttempts).mockImplementation(async (query) =>
      Array.from(
        {
          length: Math.max(
            0,
            Math.min(50, (query.attemptIds?.length ?? 0) - (query.offset ?? 0)),
          ),
        },
        (_, index) => ({
          ...attemptSummary,
          id: query.attemptIds?.[(query.offset ?? 0) + index] ?? "",
        }),
      ),
    );
    const many = Array.from({ length: 60 }, (_, index) => `current-${index}`);
    const { rerender } = wrap(
      <BenchmarkAttemptList
        query={{ attemptIds: many }}
        versions={definition.versions}
        onEvidence={vi.fn()}
      />,
    );
    await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
        attemptIds: many,
        offset: 50,
        limit: 50,
      }),
    );
    rerender(
      <BenchmarkAttemptList
        query={{ attemptIds: ["older-0", "older-1"] }}
        versions={definition.versions}
        onEvidence={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
        attemptIds: ["older-0", "older-1"],
        offset: 0,
        limit: 50,
      }),
    );
    expect(
      await screen.findAllByRole("button", { name: "Inspect" }),
    ).toHaveLength(2);
  });
  it("keeps the page while the listed attempts only grow", async () => {
    vi.mocked(benchmarkApi.listAttempts).mockImplementation(async (query) =>
      Array.from(
        {
          length: Math.max(
            0,
            Math.min(50, (query.attemptIds?.length ?? 0) - (query.offset ?? 0)),
          ),
        },
        (_, index) => ({
          ...attemptSummary,
          id: query.attemptIds?.[(query.offset ?? 0) + index] ?? "",
        }),
      ),
    );
    const many = Array.from({ length: 60 }, (_, index) => `current-${index}`);
    const list = (ids: string[], resetKey?: string) => (
      <BenchmarkAttemptList
        query={{ attemptIds: ids }}
        versions={definition.versions}
        resetKey={resetKey}
        onEvidence={vi.fn()}
      />
    );
    const lastCall = (attemptIds: string[], offset: number) =>
      waitFor(() =>
        expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
          attemptIds,
          offset,
          limit: 50,
        }),
      );
    const { rerender } = wrap(list(many));
    await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await lastCall(many, 50);
    // A case settles while the run goes on: its attempts join the list.
    const grown = [...many, "settled-60"];
    rerender(list(grown));
    await lastCall(grown, 50);
    // Another reset key is another listing, read from its first page.
    rerender(list(grown, "current"));
    await lastCall(grown, 0);
    await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await lastCall(grown, 50);
    const point = [...grown, "settled-61"];
    rerender(list(point, "current"));
    await lastCall(point, 50);
    rerender(list(point, "true:point-1"));
    await lastCall(point, 0);
  });
  it("ranks every board on its own and re-ranks from a table column", async () => {
    const rows = [
      leaderboardRow({
        configuration: { ...configuration, id: "a", modelId: "alpha" },
        points: 1000,
        efficiencyPoints: 200,
        speedPoints: 200,
        costPoints: 100,
      }),
      leaderboardRow({
        configuration: { ...configuration, id: "b", modelId: "beta" },
        points: 500,
        efficiencyPoints: 1000,
        speedPoints: 1000,
        costPoints: 1000,
      }),
      leaderboardRow({
        configuration: { ...configuration, id: "c", modelId: "gamma" },
        points: 1000,
        efficiencyPoints: 111,
        speedPoints: 67,
        costPoints: 33,
      }),
      leaderboardRow({
        configuration: { ...configuration, id: "d", modelId: "delta" },
        points: 900,
        status: "preliminary",
        scored: 1,
        planned: 4,
      }),
    ];
    wrap(
      <LeaderboardView
        {...scopeProps}
        onOpen={vi.fn()}
        report={{ cohort, rows }}
      />,
    );
    const order = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => {
          const cells = within(row).getAllByRole("cell");
          return `${cells[0].textContent} ${cells[1].querySelector(".font-medium")?.textContent}`;
        });
    expect(order()).toEqual(["1 alpha", "1 gamma", "3 beta"]);
    // Rows without a rank stay out of the way until asked for.
    expect(screen.queryByText("delta")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 unranked configuration" }),
    );
    expect(order()).toEqual(["1 alpha", "1 gamma", "3 beta", "– delta"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Hide unranked configurations" }),
    );
    expect(
      screen.getByRole("tab", { name: "Simple coding" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Speed" }));
    expect(order()).toEqual(["1 beta", "2 alpha", "3 gamma"]);
    await userEvent.click(screen.getByRole("radio", { name: "Table" }));
    await userEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(order()).toEqual(["1 beta", "2 alpha", "3 gamma"]);
    expect(screen.getByRole("button", { name: "Cost" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const first = screen.getAllByRole("row")[1];
    expect(
      within(first)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "1",
      // The vendor icon carries its own title text.
      "ClaudebetahighAnthropic",
      "500",
      "–",
      "1000",
      "1000",
      "1000",
      "–",
      "–",
      "",
    ]);
  });
  it("places ranks over every row and pages only the rendered list", async () => {
    const rows = Array.from({ length: 55 }, (_, index) =>
      leaderboardRow({
        configuration: {
          ...configuration,
          id: `m${index}`,
          modelId: `model-${String(index).padStart(2, "0")}`,
        },
        // Listed weakest first, so a page-local rank would be wrong.
        points: 100 + index,
      }),
    );
    const onPageChange = vi.fn();
    const view = wrap(
      <LeaderboardView
        {...scopeProps}
        onPageChange={onPageChange}
        onOpen={vi.fn()}
        report={{ cohort, rows }}
      />,
    );
    const ranks = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(ranks()).toHaveLength(50);
    expect(ranks()[0]).toBe("1");
    expect(screen.getByText("model-54")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
    view.rerender(
      <LeaderboardView
        {...scopeProps}
        page={1}
        onPageChange={onPageChange}
        onOpen={vi.fn()}
        report={{ cohort, rows }}
      />,
    );
    expect(ranks()).toEqual(["51", "52", "53", "54", "55"]);
    expect(screen.getByText("model-00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
  it("reads another board from its top", async () => {
    // Every row ranks on Overall; only thirty have a known cost.
    const rows = Array.from({ length: 55 }, (_, index) =>
      leaderboardRow({
        configuration: {
          ...configuration,
          id: `m${index}`,
          modelId: `model-${String(index).padStart(2, "0")}`,
        },
        points: 100 + index,
        costPoints: index < 30 ? 100 + index : null,
      }),
    );
    const onPageChange = vi.fn();
    wrap(
      <LeaderboardView
        {...scopeProps}
        page={1}
        onPageChange={onPageChange}
        onOpen={vi.fn()}
        report={{ cohort, rows }}
      />,
    );
    const ranks = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(ranks()).toEqual(["51", "52", "53", "54", "55"]);
    await userEvent.click(screen.getByRole("tab", { name: "Cost" }));
    expect(onPageChange).toHaveBeenCalledWith(0);
    // Even before the page resets, the shorter board never renders empty.
    expect(ranks()).toHaveLength(30);
    expect(ranks()[0]).toBe("1");
  });
  it("asks the service for the whole leaderboard at once", async () => {
    wrap(
      <BenchmarksView
        location={{ section: "leaderboard" }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(benchmarkApi.getLeaderboard).toHaveBeenCalledWith({
        runId: null,
        versionIds: null,
        offset: 0,
        limit: 500,
      }),
    );
  });
  it("labels every outcome the service emits instead of showing raw keys", () => {
    wrap(
      <LeaderboardView
        {...scopeProps}
        onOpen={vi.fn()}
        report={{
          cohort: null,
          rows: ["budget_reached", "selection_changed", "confirmed_change"].map(
            (status) =>
              leaderboardRow({
                configuration: {
                  ...configuration,
                  id: status,
                  modelId: status,
                },
                passed: 0,
                quality: 0,
                status,
                reason: "",
                attemptIds: [],
              }),
          ),
        }}
      />,
    );
    expect(screen.getByText("Artifact budget exceeded")).toBeInTheDocument();
    expect(screen.getByText("Selection changed")).toBeInTheDocument();
    expect(screen.getByText("Confirmed change")).toBeInTheDocument();
  });
  it("opens the attempts behind a Nerf comparison", async () => {
    const onEvidence = vi.fn();
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([attemptSummary]);
    wrap(
      <NerfBenchView
        {...scopeProps}
        versions={definition.versions}
        baseline={null}
        baselineId="baseline"
        baselineOptions={[{ value: "baseline", label: "Frozen" }]}
        onBaselineChange={vi.fn()}
        onCreateBaseline={vi.fn()}
        comparisons={[
          {
            baselineId: "baseline",
            configurationId: "model-1",
            configuration,
            qualityChange: -0.1,
            retainedQualityPercent: 90,
            intervalLow: -0.2,
            intervalHigh: 0,
            status: "preliminary",
            reason: "Synthetic",
            attemptIds: ["attempt-7", "attempt-8"],
            durationChangePercent: 12.34,
            tokenChangePercent: null,
            method: "paired",
            measuredAt: null,
          },
        ]}
        onEvidence={onEvidence}
      />,
    );
    const row = screen.getByRole("row", { name: /model-1/ });
    expect(row).toHaveTextContent("90.0%");
    expect(row).toHaveTextContent("−10.0 pp");
    expect(row).toHaveTextContent("+12.3%");
    await userEvent.click(
      within(row).getByRole("button", { name: "Open model-1" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "model-1" });
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Inspect" }),
    );
    expect(onEvidence).toHaveBeenCalledWith("attempt-1");
    expect(benchmarkApi.listAttempts).toHaveBeenCalledWith({
      attemptIds: ["attempt-7", "attempt-8"],
      offset: 0,
      limit: 50,
    });
  });
  it("defaults dataset export to exclude held-out outcomes", async () => {
    vi.mocked(benchmarkApi.exportDataset).mockResolvedValue({
      id: "export",
      path: "results.jsonl",
      manifestPath: "manifest.json",
      rowCount: 1,
      contentHash: "hash",
    });
    wrap(<BenchmarkExportDialog onClose={vi.fn()} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await userEvent.click(
      screen.getByRole("button", { name: "Export dataset" }),
    );
    await waitFor(() =>
      expect(benchmarkApi.exportDataset).toHaveBeenCalledWith(false),
    );
  });
  it("never enables automatic retesting on mount", async () => {
    wrap(<BenchmarkSchedulesDialog runs={[runSummary]} onClose={vi.fn()} />);
    await act(async () => {});
    expect(
      screen.getByRole("checkbox", { name: /Enable this campaign/ }),
    ).not.toBeChecked();
    expect(benchmarkApi.saveSchedule).not.toHaveBeenCalled();
  });
  it("saves declared role context and a bounded workflow before any run", async () => {
    vi.mocked(benchmarkApi.saveDraft).mockResolvedValue(definition);
    wrap(
      <BenchmarkEditor
        definition={definition}
        onSaved={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Role ID" }), {
      target: { value: "reviewer" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Frozen role instructions" }),
      { target: { value: "Report verified errors only." } },
    );
    const workflow = {
      schemaVersion: 1,
      driverRevision: "1",
      steps: [
        {
          id: "analyze",
          prompt: "Extract the integer.",
          includePreviousOutput: false,
        },
        { id: "answer", prompt: "Return it.", includePreviousOutput: true },
      ],
    };
    fireEvent.change(
      screen.getByRole("textbox", { name: "Bounded workflow (JSON or null)" }),
      { target: { value: JSON.stringify(workflow) } },
    );
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(benchmarkApi.saveDraft).toHaveBeenCalledWith(
        "definition-1",
        1,
        expect.objectContaining({
          roleId: "reviewer",
          rolePrompt: "Report verified errors only.",
          workflow,
        }),
      ),
    );
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("requires explicit discovery and keeps new campaigns disabled", async () => {
    const user = userEvent.setup();
    wrap(<BenchmarkSchedulesDialog runs={[runSummary]} onClose={vi.fn()} />);
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "Calibration",
    );
    await user.click(screen.getByRole("combobox", { name: "Frozen plan" }));
    await user.click(screen.getByRole("option", { name: /run-1/ }));
    await user.click(
      screen.getByRole("checkbox", {
        name: "Refresh models within the plan's provider and account",
      }),
    );
    expect(
      screen.getByRole("checkbox", { name: /Calibrate newly discovered/ }),
    ).not.toBeChecked();
    await user.click(
      screen.getByRole("checkbox", { name: /Calibrate newly discovered/ }),
    );
    await user.click(screen.getByRole("button", { name: "Save campaign" }));
    await waitFor(() =>
      expect(benchmarkApi.saveSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          maxRuns: 20,
          maxTotalExecutions: 100,
          discovery: {
            providerId: "claude-acp",
            accountId: "account-1",
            includeNewModels: true,
            modelIds: [],
            maxCandidates: 4,
          },
        }),
      ),
    );
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("reads selector evidence only on request and leaves availability unknown", async () => {
    vi.mocked(benchmarkApi.getRoutingEvidence).mockResolvedValue({
      schemaVersion: 1,
      generatedAt: 10,
      queryHash: "query-hash",
      mode: "exact",
      candidates: [],
    });
    wrap(
      <BenchmarkRoutingDialog
        versions={definition.versions}
        runs={[runSummary]}
        onClose={vi.fn()}
        onEvidence={vi.fn()}
      />,
    );
    expect(benchmarkApi.getRoutingEvidence).not.toHaveBeenCalled();
    expect(
      screen.getByRole("checkbox", { name: "Available now" }),
    ).not.toBeChecked();
    await userEvent.click(
      screen.getByRole("button", { name: "Read evidence" }),
    );
    await waitFor(() =>
      expect(benchmarkApi.getRoutingEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "exact",
          purpose: "analysis",
          targetVersionId: "version-1",
          permittedSplits: ["development", "train"],
          candidates: [
            expect.objectContaining({ available: false, configuration }),
          ],
        }),
      ),
    );
    expect(
      await screen.findByText("No candidates were supplied."),
    ).toBeInTheDocument();
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("derives a fresh variant of a generated family and opens it as a draft", async () => {
    const generated = {
      ...definition,
      id: "generated-1",
      draft: {
        ...draft,
        name: "Two-worker list schedule",
        taskFamily: "seed-two-worker-schedule",
        environment: {
          generator: { family: "seed-two-worker-schedule", seed: 0 },
        },
      },
    };
    vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([generated]);
    vi.mocked(benchmarkApi.generateVariant).mockResolvedValue({
      ...generated.draft,
      name: "Two-worker list schedule (variant 7)",
    });
    vi.mocked(benchmarkApi.importDefinition).mockResolvedValue({
      ...generated,
      id: "variant-1",
    });
    const onNavigate = vi.fn();
    wrap(
      <BenchmarksView
        location={{ section: "development" }}
        onNavigate={onNavigate}
        onSelectSession={vi.fn()}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Actions for Two-worker list schedule",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "New variant" }),
    );
    await waitFor(() =>
      expect(benchmarkApi.generateVariant).toHaveBeenCalledWith(
        "seed-two-worker-schedule",
        expect.any(Number),
      ),
    );
    const seed = vi.mocked(benchmarkApi.generateVariant).mock.calls[0][1];
    expect(seed).toBeGreaterThan(0);
    expect(benchmarkApi.importDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Two-worker list schedule (variant 7)",
      }),
    );
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        { section: "development", benchmarkId: "variant-1" },
        expect.anything(),
      ),
    );
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("imports several definition files in one step and returns to the library", async () => {
    if (!File.prototype.text) {
      File.prototype.text = function text() {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsText(this);
        });
      };
    }
    vi.mocked(benchmarkApi.importDefinition).mockResolvedValue(definition);
    const onImported = vi.fn();
    wrap(<BenchmarkImportDialog onClose={vi.fn()} onImported={onImported} />);
    const files = ["first", "second"].map(
      (name) =>
        new File([JSON.stringify({ ...draft, name })], `${name}.json`, {
          type: "application/json",
        }),
    );
    fireEvent.change(screen.getByLabelText("Definition JSON file"), {
      target: { files },
    });
    expect(await screen.findByText("2 files selected")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Publish definitions/ }),
    );
    vi.mocked(benchmarkApi.publishVersion).mockResolvedValue(
      definition.versions[0],
    );
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(benchmarkApi.importDefinition).toHaveBeenCalledTimes(2),
    );
    expect(benchmarkApi.importDefinition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "second" }),
    );
    expect(benchmarkApi.publishVersion).toHaveBeenCalledTimes(2);
    expect(benchmarkApi.publishVersion).toHaveBeenCalledWith(
      definition.id,
      definition.draftRevision,
    );
    expect(onImported).toHaveBeenCalledWith();
  });
  it("loads saved-test results only on opening the tab and requests bounded historical pages", async () => {
    vi.mocked(benchmarkApi.listAttempts).mockImplementation(async (query) =>
      Array.from({ length: query.offset === 0 ? 50 : 1 }, (_, index) => ({
        id: `saved-attempt-${(query.offset ?? 0) + index}`,
        runId: "older-run",
        versionId: "version-1",
        modelId: query.offset === 0 ? "first-page-model" : "older-page-model",
        repetition: 0,
        phase: "terminal",
        outcome: "pass",
        finishedAt: null,
        durationMs: null,
        outputTokens: null,
        cost: null,
      })),
    );
    const onNavigate = vi.fn();
    wrap(
      <BenchmarksView
        location={{ section: "development", benchmarkId: definition.id }}
        onNavigate={onNavigate}
        onSelectSession={vi.fn()}
      />,
    );
    await screen.findByRole("textbox", { name: "Name" });
    expect(benchmarkApi.listAttempts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("tab", { name: "Results" }));
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenCalledWith({
        versionIds: ["version-1"],
        offset: 0,
        limit: 50,
      }),
    );
    expect(await screen.findAllByText("first-page-model")).toHaveLength(50);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("older-page-model")).toBeInTheDocument();
    expect(screen.queryByText("first-page-model")).not.toBeInTheDocument();
    expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
      versionIds: ["version-1"],
      offset: 50,
      limit: 50,
    });
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(onNavigate).toHaveBeenCalledWith({
      section: "development",
      benchmarkId: definition.id,
      attemptId: "saved-attempt-50",
    });
  });
});

describe("configuration history", () => {
  afterEach(cleanup);

  it("charts points per measurement and shows the page as it stood at an older one", async () => {
    const older = {
      ...runSummary,
      id: "run-0",
      createdAt: 500,
      updatedAt: 600,
    };
    const pointAt = Date.UTC(2026, 0, 10, 12);
    const latestAt = Date.UTC(2026, 1, 1, 12);
    const olderRow = leaderboardRow({
      points: 600,
      quality: 0.6,
      measuredAt: pointAt - 60_000,
      attemptIds: ["attempt-0"],
    });
    const latestRow = leaderboardRow({
      points: 900,
      quality: 0.9,
      measuredAt: latestAt,
      missingVersionIds: ["version-1"],
    });
    vi.mocked(benchmarkApi.getHistory).mockResolvedValue([
      {
        id: "old",
        runId: older.id,
        createdAt: pointAt,
        report: { cohort, rows: [olderRow] },
        recalculatedReport: {
          cohort,
          rows: [
            {
              ...olderRow,
              points: 750,
              quality: 0.75,
              status: "preliminary",
              reason:
                "1/1 current cases; 1 first measured later, 0 reviewed later; recalculated using today's evidence",
              // The backfilled case finished months after the point.
              measuredAt: Date.UTC(2026, 5, 20, 12),
            },
          ],
        },
        backfilledVersionIds: ["later-case"],
        revisedVersionIds: [],
      },
      {
        id: "latest",
        runId: runSummary.id,
        createdAt: latestAt,
        report: { cohort, rows: [latestRow] },
      },
    ]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    const catchUp = vi.fn();
    wrap(
      <BenchmarkConfigurationPage
        row={latestRow}
        report={{ cohort, rows: [latestRow] }}
        runs={[runSummary, older]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={catchUp}
        onOpenRun={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    const rating = () =>
      screen.getByText("Overall rating").nextElementSibling?.textContent;
    const measured = () =>
      screen.getByText("Measured").nextElementSibling?.textContent;
    expect(rating()).toBe("900");
    const oldPoint = await screen.findByRole("button", {
      name: /: 750 points · 1\/1 cases$/,
    });
    expect(
      screen.getByRole("button", { name: /: 900 points · 1\/1 cases$/ }),
    ).toHaveAttribute("aria-pressed", "false");
    // The chart carries points and dates only, with no caption below it.
    const chart = screen.getByLabelText("Overall points per measurement");
    expect(
      [...chart.querySelectorAll("text")].some((text) =>
        text.textContent?.includes("/"),
      ),
    ).toBe(false);
    expect(chart.querySelector("title")).toBeNull();
    expect(screen.queryByText(/today's cases/)).not.toBeInTheDocument();
    expect(screen.queryByText(/at each date/)).not.toBeInTheDocument();
    await userEvent.click(oldPoint);
    expect(rating()).toBe("750");
    expect(oldPoint).toHaveAttribute("aria-pressed", "true");
    expect(measured()).toMatch(/Jan 10, 2026/);
    expect(screen.getByText("Preliminary")).toBeInTheDocument();
    expect(
      screen.queryByText(/recalculated using today's evidence/),
    ).not.toBeInTheDocument();
    expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
      attemptIds: ["attempt-0"],
      offset: 0,
      limit: 50,
    });
    // Catch-up fills today's gaps, whichever point is shown.
    await userEvent.click(
      screen.getByRole("button", { name: "Run the 1 missing case" }),
    );
    expect(catchUp).toHaveBeenCalledWith(["version-1"]);
    expect(benchmarkApi.getHistory).toHaveBeenCalledWith(configuration);
    await userEvent.click(
      screen.getByRole("button", { name: "Show current results" }),
    );
    expect(rating()).toBe("900");
    await userEvent.click(screen.getByRole("button", { name: "As recorded" }));
    await userEvent.click(screen.getByRole("button", { name: /: 600 points/ }));
    expect(rating()).toBe("600");
    expect(measured()).toMatch(/Jan 10, 2026/);
    // A dated point lists the verdicts that stood at its date.
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
        attemptIds: ["attempt-0"],
        asOf: pointAt,
        offset: 0,
        limit: 50,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Current pool" }));
    expect(rating()).toBe("900");
  });

  it("offers only a mode that has measurements", async () => {
    const dated = leaderboardRow({ points: 600, attemptIds: ["attempt-0"] });
    vi.mocked(benchmarkApi.getHistory).mockResolvedValue([
      {
        id: "only-recorded",
        runId: runSummary.id,
        createdAt: 1_000,
        report: { cohort, rows: [dated] },
        // Today's pool has no measured point for this observation.
        recalculatedReport: {
          cohort,
          rows: [{ ...dated, points: null, quality: null }],
        },
      },
    ]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    const current = leaderboardRow({ points: 900 });
    wrap(
      <BenchmarkConfigurationPage
        row={current}
        report={{ cohort, rows: [current] }}
        runs={[runSummary]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /: 600 points/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "As recorded" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Current pool" }),
    ).not.toBeInTheDocument();
  });

  it("keeps following a selected point while its run settles more cells", async () => {
    const point = (id: string, createdAt: number, points: number) => ({
      id,
      runId: runSummary.id,
      createdAt,
      report: { cohort, rows: [leaderboardRow({ points })] },
    });
    vi.mocked(benchmarkApi.getHistory).mockResolvedValue([
      point("earlier:1", 1_000, 400),
      point(`${runSummary.id}:2000`, 2_000, 500),
    ]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const current = leaderboardRow({ points: 900 });
    render(
      <QueryClientProvider client={client}>
        <BenchmarkConfigurationPage
          row={current}
          report={{ cohort, rows: [current] }}
          runs={[runSummary]}
          versions={definition.versions}
          onEvidence={vi.fn()}
          onRun={vi.fn()}
          onOpenRun={vi.fn()}
          onBack={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const rating = () =>
      screen.getByText("Overall rating").nextElementSibling?.textContent;
    await userEvent.click(
      await screen.findByRole("button", { name: /: 500 points/ }),
    );
    expect(rating()).toBe("500");
    // The running run's single point moved to its newest settled cell.
    vi.mocked(benchmarkApi.getHistory).mockResolvedValue([
      point("earlier:1", 1_000, 400),
      point(`${runSummary.id}:3000`, 3_000, 700),
    ]);
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(rating()).toBe("700"));
    expect(
      screen.getByRole("button", { name: /: 700 points/ }),
    ).toHaveAttribute("aria-pressed", "true");
    client.clear();
  });
});

describe("model filter", () => {
  afterEach(cleanup);

  it("narrows the board to the chosen models and shows all again on request", async () => {
    const rows = ["alpha", "beta", "gamma"].map((modelId, index) =>
      leaderboardRow({
        configuration: { ...configuration, id: modelId, modelId },
        points: 1000 - index * 100,
      }),
    );
    wrap(
      <LeaderboardView
        {...scopeProps}
        onOpen={vi.fn()}
        report={{ cohort, rows }}
      />,
    );
    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map(
          (row) =>
            within(row).getAllByRole("cell")[1].querySelector(".font-medium")
              ?.textContent,
        );
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
    // No filter by test or run is offered: the whole cohort is the board.
    expect(
      screen.queryByText("All published versions"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("All runs")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Models" }));
    const list = await screen.findByRole("listbox");
    await userEvent.click(within(list).getByText("alpha"));
    await userEvent.click(within(list).getByText("gamma"));
    expect(names()).toEqual(["alpha", "gamma"]);
    expect(screen.getByRole("button", { name: "Models" })).toHaveTextContent(
      "2",
    );
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("post-run evaluation history", () => {
  afterEach(cleanup);
  it("keeps the current score visible after a later evaluation", async () => {
    const current = leaderboardRow({ points: 900, quality: 0.9 });
    const historical = leaderboardRow({ points: 600, quality: 0.6 });
    vi.mocked(benchmarkApi.getHistory).mockResolvedValue([
      {
        id: "historical",
        runId: runSummary.id,
        createdAt: 1000,
        report: { cohort, rows: [historical] },
      },
    ]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listCatalog).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getCandidateObservations).mockResolvedValue([]);
    wrap(
      <BenchmarkConfigurationPage
        row={current}
        report={{ cohort, rows: [current] }}
        runs={[runSummary]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Overall rating").nextElementSibling?.textContent,
    ).toBe("900");
    await screen.findByRole("button", { name: /: 600 points/ });
    expect(
      screen.getByText("Overall rating").nextElementSibling?.textContent,
    ).toBe("900");
  });
});
