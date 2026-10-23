import type {
  HistorySnapshot,
  ModelHistoryViewPoint,
} from "../hooks/useBenchmarks";
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
import { i18n } from "@/shared/i18n";
import { benchmarkApi } from "../api/benchmarks";
import { BenchmarkAttemptList } from "../ui/BenchmarkAttemptList";
import { BenchmarkEditor } from "../ui/BenchmarkEditor";
import { BenchmarksView } from "../ui/BenchmarksView";
import { LeaderboardView } from "../ui/LeaderboardView";
import { BenchmarkConfigurationPage } from "../ui/BenchmarkConfigurationPage";
import { rowKey } from "../lib/benchmarkBoards";
import { modelKey } from "../lib/benchmarkModels";
import { BenchmarkRoutingDialog } from "../ui/BenchmarkRoutingDialog";
import {
  BenchmarkExportDialog,
  BenchmarkImportDialog,
  BenchmarkSchedulesDialog,
} from "../ui/BenchmarkManagementDialogs";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import type { BenchmarkDefinition } from "../types";
import {
  BENCHMARK_SECTIONS,
  type BenchmarkLocation,
  type BenchmarkSection,
} from "../lib/benchmarkNavigation";
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

/** Canonical projection of invented full-history fixtures, never a scoring rewrite. */
function modelHistoryViewFixture(
  snapshots: HistorySnapshot[],
): ModelHistoryViewPoint[] {
  return snapshots.map((snapshot) => ({
    id: snapshot.id ?? snapshot.runId,
    runId: snapshot.runId,
    createdAt: snapshot.createdAt,
    recalculatedReport: snapshot.recalculatedReport ?? snapshot.report,
    backfilledVersionIds: snapshot.backfilledVersionIds ?? [],
    revisedVersionIds: snapshot.revisedVersionIds ?? [],
  }));
}

const repetitionRenders = vi.hoisted(() => vi.fn());
vi.mock("../ui/BenchmarkTestStatus", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../ui/BenchmarkTestStatus")>();
  return {
    ...original,
    RepetitionDots: (props: Parameters<typeof original.RepetitionDots>[0]) => {
      repetitionRenders(props.states);
      return <original.RepetitionDots {...props} />;
    },
  };
});

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) =>
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error),
  benchmarkApi: {
    listDefinitions: vi.fn(),
    getDefinition: vi.fn(),
    getVersion: vi.fn(),
    listRuns: vi.fn(),
    listWorkflowCampaigns: vi.fn().mockResolvedValue([]),
    listAttempts: vi.fn(),
    getRun: vi.fn(),
    getEvidence: vi.fn(),
    getLeaderboard: vi.fn(),
    getModelHistoryView: vi.fn().mockResolvedValue([]),
    listDesigns: vi.fn(),
    listReleases: vi.fn().mockResolvedValue([]),
    getCaseStats: vi.fn().mockResolvedValue([]),
    selectorHarness: vi.fn(),
    getRoutingEvidence: vi.fn(),
    listSchedules: vi.fn(),
    saveSchedule: vi.fn(),
    saveDraft: vi.fn(),
    validateDraft: vi.fn(),
    publishVersion: vi.fn(),
    getInventory: vi.fn(),
    getCapabilities: vi.fn(),
    getCandidateObservations: vi.fn(),
    providerDataUse: vi.fn().mockResolvedValue([]),
    listCatalog: vi.fn(),
    startRun: vi.fn(),
    previewRun: vi.fn(),
    cancelRun: vi.fn(),
    eventsSince: vi.fn(),
    listen: vi.fn(),
    exportDataset: vi.fn(),
    generateVariant: vi.fn(),
    importDefinition: vi.fn(),
  },
}));
vi.mock("@/features/stats/lib/usageLedger", () => ({
  projectBenchmarkUsageBatch: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));

/** Lists these tests and serves each one in full, the way the service does. */
function catalog(definitions: BenchmarkDefinition[]) {
  vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue(definitions);
  vi.mocked(benchmarkApi.getDefinition).mockImplementation(async (id) => {
    const found = definitions.find((entry) => entry.id === id);
    if (!found) throw new Error("Definition not found");
    return found;
  });
  vi.mocked(benchmarkApi.getVersion).mockImplementation(async (id) => {
    const found = definitions
      .flatMap((entry) => entry.versions)
      .find((entry) => entry.id === id);
    if (!found) throw new Error("Published version not found");
    return found;
  });
}

/** A measured simple-coding axis with the given board points. */
function codingAxis(points: number) {
  return {
    id: "algorithms",
    quality: points / 1000,
    points,
    passed: 1,
    scored: 1,
    planned: 1,
  };
}

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

/** Serves each page of listed attempt ids the way the service pages them. */
function serveListedPages() {
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
}

function attemptList(ids: string[], resetKey?: string) {
  return (
    <BenchmarkAttemptList
      query={{ attemptIds: ids }}
      versions={definition.versions}
      resetKey={resetKey}
      onEvidence={vi.fn()}
    />
  );
}

function listedPage(attemptIds: string[], offset: number) {
  return waitFor(() =>
    expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
      attemptIds,
      offset,
      limit: 50,
    }),
  );
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
    catalog([definition]);
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([runSummary]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getRun).mockResolvedValue(run);
    vi.mocked(benchmarkApi.getEvidence).mockResolvedValue(attempt);
    vi.mocked(benchmarkApi.getCandidateObservations).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listCatalog).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listDesigns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort: null,
      rows: [],
    });
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
    await user.click(screen.getByRole("button", { name: "Create version" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
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
      screen.getByRole("spinbutton", {
        name: "Minimum time limit (seconds)",
      }),
    ).toHaveValue(120);
  });
  it("opens every view without probing inventory or starting inference", async () => {
    const view = (section: BenchmarkSection) => (
      <BenchmarksView
        location={{ section }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />
    );
    const { rerender } = wrap(view("leaderboard"));
    await screen.findByText("No results for this selection.");
    // The sections are chosen from the sidebar; the page keeps only its
    // actions, in the section's own first row, and never repeats the section
    // names as tabs.
    for (const section of BENCHMARK_SECTIONS) {
      rerender(view(section));
      expect(screen.getByTestId("benchmark-toolbar")).toContainElement(
        screen.getByRole("button", { name: "New test" }),
      );
      expect(
        screen.queryByRole("tab", { name: "Design Bench" }),
      ).not.toBeInTheDocument();
    }
    expect(benchmarkApi.getInventory).not.toHaveBeenCalled();
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("keeps authoring, run selection and editable new-task defaults in the chosen class", async () => {
    const user = userEvent.setup();
    const sample = (id: string, workClassId: string, name: string) => ({
      ...definition,
      id,
      draft: { ...draft, workClassId, name },
      versions: [
        {
          ...definition.versions[0],
          id: `${id}-version`,
          definitionId: id,
          manifest: { ...draft, workClassId, name },
        },
      ],
    });
    catalog([
      sample("algorithm", "algorithms", "Algorithm sample"),
      sample("writing", "writing", "Writing sample"),
      {
        ...sample("archived", "algorithms", "Archived algorithm"),
        archived: true,
      },
    ]);
    vi.mocked(benchmarkApi.getCapabilities).mockResolvedValue([]);
    function Authoring() {
      const [location, setLocation] = useState<BenchmarkLocation>({
        section: "development",
      });
      return (
        <BenchmarksView
          location={location}
          onNavigate={setLocation}
          onSelectSession={vi.fn()}
        />
      );
    }
    wrap(<Authoring />);
    await screen.findByRole("button", { name: "Writing sample" });
    await user.click(
      screen.getByRole("tab", { name: "Algorithms and clean code" }),
    );
    expect(
      screen.getByRole("button", { name: "Algorithm sample" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Writing sample" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archived algorithm" }),
    ).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("searchbox", { name: "Search tests" }),
      "Writing",
    );
    expect(
      screen.queryByRole("button", { name: "Algorithm sample" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Writing sample" }),
    ).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search tests" }));
    await user.click(screen.getByRole("button", { name: "Run tests" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Run benchmarks" }),
    );
    expect(
      dialog.getByRole("checkbox", { name: /Algorithm sample/ }),
    ).toBeInTheDocument();
    expect(
      dialog.queryByRole("checkbox", { name: /Writing sample/ }),
    ).not.toBeInTheDocument();
    await user.click(dialog.getAllByRole("button", { name: "Close" })[0]);
    await user.click(screen.getByRole("button", { name: "New test" }));
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
      "Algorithms and clean code",
    );
    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(screen.getByRole("option", { name: "Writing" }));
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent(
      "Writing",
    );
    expect(benchmarkApi.saveDraft).not.toHaveBeenCalled();
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
  });
  it("keeps the page actions in the first row of the board and the model page", async () => {
    const row = leaderboardRow({ points: 120 });
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort,
      rows: [row],
    });
    vi.mocked(benchmarkApi.listRuns).mockRejectedValue(
      new Error("Runs are unavailable"),
    );
    const view = (location: BenchmarkLocation) => (
      <BenchmarksView
        location={location}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />
    );
    const { rerender } = wrap(view({ section: "leaderboard" }));
    // The boards, the model filter and the actions share one row, so it
    // wraps only when all of them overflow together.
    const boards = await screen.findByRole("tablist");
    const toolbar = screen.getByTestId("benchmark-toolbar");
    expect(toolbar).toContainElement(boards);
    expect(toolbar).toContainElement(
      screen.getByRole("button", { name: "Models" }),
    );
    expect(toolbar).toContainElement(
      screen.getByRole("button", { name: "Run tests" }),
    );
    // A failure banner sits above the row, never beside the actions.
    expect(toolbar).not.toContainElement(await screen.findByRole("alert"));
    rerender(view({ section: "leaderboard", configurationId: rowKey(row) }));
    // A model page carries only its own controls: the sidebar and the top
    // bar lead back, and the page actions belong to the sections.
    expect(
      await screen.findByRole("button", { name: "Run" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Leaderboard" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run tests" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("benchmark-toolbar")).not.toBeInTheDocument();
  });
  it("opens a section switched to from outside the page on its first page", async () => {
    const rows = Array.from({ length: 55 }, (_, index) =>
      leaderboardRow({
        configuration: {
          ...configuration,
          id: `m${index}`,
          modelId: `model-${String(index).padStart(2, "0")}`,
        },
        points: 100 + index,
      }),
    );
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort,
      rows,
    });
    const view = (section: BenchmarkSection) => (
      <BenchmarksView
        location={{ section }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />
    );
    const firstRank = () =>
      within(screen.getAllByRole("row")[1]).getAllByRole("cell")[0].textContent;
    const { rerender } = wrap(view("leaderboard"));
    await screen.findByText("model-54");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(firstRank()).toBe("51");
    rerender(view("design"));
    rerender(view("leaderboard"));
    await screen.findByText("model-54");
    expect(firstRank()).toBe("1");
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
    // The run reads as a grid of task blocks; a block opens its evidence.
    await userEvent.click(
      await within(drawer).findByRole("button", { name: /^Task 1: / }),
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
  it("shows a row per effort and fast mode, with profiles under one row, in both views", async () => {
    const measured = leaderboardRow({ scored: 8, complete: 8, points: 640 });
    const variants = [
      measured,
      leaderboardRow({
        configuration: {
          ...configuration,
          executionProfile: "protected_repository",
        },
        scored: 0,
        complete: 0,
        points: null,
      }),
      ...["protected_repository", "isolated_ui"].map((executionProfile) =>
        leaderboardRow({
          configuration: {
            ...configuration,
            executionProfile,
            effort: "max",
            fastMode: true,
          },
          scored: 0,
          complete: 0,
          points: null,
        }),
      ),
    ];
    const open = vi.fn();
    wrap(
      <LeaderboardView
        {...scopeProps}
        report={{ cohort, rows: variants }}
        onOpen={open}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
    const high = screen.getByRole("button", { name: "Open model-1 · high" });
    const row = high.closest("tr")!;
    expect(row).toHaveTextContent("640");
    expect(row).not.toHaveTextContent("runtime");
    expect(within(row).getByText("high")).toBeInTheDocument();
    const fast = screen
      .getByRole("button", { name: "Open model-1 · max · fast" })
      .closest("tr")!;
    expect(within(fast).getByText("max")).toBeInTheDocument();
    expect(within(fast).getByText("fast")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Table" }));
    expect(screen.getAllByRole("row")).toHaveLength(3);
    await userEvent.click(
      screen.getByRole("button", { name: "Open model-1 · high" }),
    );
    expect(open).toHaveBeenCalledWith(modelKey(configuration));
  });

  it("shows the model's combined results without asking for an execution configuration", async () => {
    const text = leaderboardRow({ scored: 8, complete: 8 });
    const repository = leaderboardRow({
      configuration: {
        ...configuration,
        id: "repository",
        executionProfile: "protected_repository",
      },
      scored: 0,
      complete: 0,
      points: null,
      attemptIds: ["repository-attempt"],
      resultAttemptIds: [],
    });
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort,
      rows: [repository, text],
      models: [
        {
          key: modelKey(configuration),
          providerId: configuration.providerId,
          modelId: configuration.modelId,
          configurationKeys: [rowKey(text), rowKey(repository)],
          row: {
            ...text,
            points: 550,
            attemptIds: ["text-attempt", "repository-attempt"],
          },
        },
      ],
    });
    wrap(
      <BenchmarksView
        location={{
          section: "leaderboard",
          configurationId: modelKey(configuration),
        }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "model-1" });
    expect(
      screen.queryByRole("combobox", { name: "Run configuration" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Clean text, no tools")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Protected code artifact"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime revision")).not.toBeInTheDocument();
    expect(screen.getAllByText("550").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptIds: ["text-attempt", "repository-attempt"],
        }),
      ),
    );
    expect(screen.getAllByRole("heading", { name: "model-1" })).toHaveLength(1);
    expect(benchmarkApi.startRun).not.toHaveBeenCalled();
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
      status: "preliminary",
      reason: "No valid evidence",
      missingVersionIds: ["version-1"],
    });
    const report = { cohort, rows: [unfinished] };
    wrap(<LeaderboardView {...scopeProps} report={report} onOpen={open} />);
    const row = screen.getByRole("row", { name: /model-1/ });
    expect(within(row).getAllByRole("cell")[0]).toHaveTextContent("–");
    expect(within(row).queryByText("Preliminary")).not.toBeInTheDocument();
    expect(within(row).queryByText(/measured/)).not.toBeInTheDocument();
    // Rank, points, full-test date, price and context all stay unknown.
    expect(within(row).getAllByText("–")).toHaveLength(5);
    expect(row).not.toHaveTextContent("0.0%");
    // Avoid unrelated summary counters above the rows.
    expect(screen.queryByText(/scored ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/configurations shown/)).not.toBeInTheDocument();
    await userEvent.click(
      within(row).getByRole("button", { name: "Open model-1 · high" }),
    );
    expect(open).toHaveBeenCalledWith(modelKey(unfinished.configuration));
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
      />,
    );
    expect(
      screen.getByRole("heading", { name: "model-1" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Preliminary")).not.toBeInTheDocument();
    // Routine measurement status and the service's reason stay off the page.
    expect(screen.queryByText("No valid evidence")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(catchUp).toHaveBeenCalledWith(null);
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    // The measured case is a block named for the reader; it opens its evidence.
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Task 1: Integer transformation",
      }),
    );
    expect(inspect).toHaveBeenCalledWith("attempt-1");
    expect(benchmarkApi.listAttempts).toHaveBeenCalledWith({
      attemptIds: ["attempt-1"],
      limit: 100,
    });
  });
  it("lists only the attempts that measured something", async () => {
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([attemptSummary]);
    // attempt-2 is a call the provider refused: kept for its spend, no result.
    const row = leaderboardRow({
      attemptIds: ["attempt-1", "attempt-2"],
      resultAttemptIds: ["attempt-1"],
    });
    wrap(
      <BenchmarkConfigurationPage
        row={row}
        report={{ cohort, rows: [row] }}
        runs={[]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    expect(await screen.findByText("Tests · 1 cases")).toBeInTheDocument();
    // Every standing attempt shows in the grid, the refused call as a
    // failed repetition of its case; only the scored one is a result.
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
        attemptIds: ["attempt-1", "attempt-2"],
        limit: 100,
      }),
    );
  });
  it("keeps model task totals aligned with eligible current versions", async () => {
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([attemptSummary]);
    const versions = [
      ["version-1", "A measured task"],
      ["author-task", "B author-excluded task"],
      ["unmeasured-task", "C unmeasured task"],
      ["unsupported-task", "D unsupported task"],
      ["old-version", "E historical version"],
    ].map(([id, name]) => ({
      ...definition.versions[0],
      id,
      manifest: { ...draft, name },
    }));
    const row = leaderboardRow({
      planned: 3,
      suitePlanned: 3,
      suiteComplete: 1,
      scoredVersionIds: ["version-1"],
      missingVersionIds: ["unmeasured-task"],
      unsupportedVersionIds: ["unsupported-task"],
    });
    wrap(
      <BenchmarkConfigurationPage
        row={row}
        report={{
          cohort: {
            ...cohort,
            versionIds: versions.slice(0, 4).map((version) => version.id),
          },
          rows: [row],
        }}
        runs={[]}
        versions={versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    expect(await screen.findByText("Tests · 3 cases")).toBeInTheDocument();
    // The leaderboard's own count and name: suite cases with a complete cell.
    expect(
      screen.getByText("Fully tested", { selector: "dt" }).nextElementSibling,
    ).toHaveTextContent("1/3");
    expect(
      screen.getByRole("button", { name: "Task 1: A measured task" }),
    ).toBeInTheDocument();
    // Keep the shared pool numbers used by run dialogs after filtering.
    expect(screen.getByText("Task 3")).toBeInTheDocument();
    expect(screen.getByText("Task 4")).toBeInTheDocument();
    expect(screen.queryByText("Task 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Task 5")).not.toBeInTheDocument();
  });
  it("names the model an alias resolved to on its page, not on every attempt", async () => {
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
      {
        ...attemptSummary,
        modelId: "sonnet",
        resolvedModel: "claude-sonnet-5",
      },
      { ...attemptSummary, id: "attempt-2", resolvedModel: null },
    ]);
    const sonnet = leaderboardRow({
      configuration: { ...configuration, modelId: "sonnet" },
      attemptIds: ["attempt-1", "attempt-2"],
      resolvedModels: ["claude-sonnet-5"],
    });
    const page = (row: typeof sonnet) => (
      <BenchmarkConfigurationPage
        row={row}
        report={{ cohort, rows: [row] }}
        runs={[]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />
    );
    wrap(page(sonnet));
    const spec = (label: string) =>
      screen.getByText(label, { selector: "dt" }).nextElementSibling;
    expect(spec("Resolved model")).toHaveTextContent("claude-sonnet-5");
    expect(spec("API model ID")).toHaveTextContent("sonnet");
    // Every attempt on the page ran this one model, so the blocks never
    // repeat it: a block carries its number, its mark, time and spend.
    expect(
      await screen.findByRole("button", { name: /^Task 1: / }),
    ).not.toHaveTextContent(/sonnet/);
    cleanup();
    // A row recorded before attempts kept the model names none.
    wrap(page({ ...sonnet, resolvedModels: undefined }));
    expect(spec("Resolved model")).toHaveTextContent("Not reported");
  });
  it("shows compact metrics without score bars and explains coverage on hover", async () => {
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    const row = leaderboardRow({
      passed: 1,
      scored: 2,
      planned: 7,
      suitePlanned: 7,
      suiteComplete: 1,
      status: "preliminary",
      axes: [
        {
          id: "security",
          passed: 1,
          scored: 2,
          planned: 5,
          quality: 1,
          points: 990,
        },
        {
          id: "architecture",
          passed: 0,
          scored: 0,
          planned: 2,
          quality: null,
          points: null,
        },
      ],
    });
    wrap(
      <BenchmarkConfigurationPage
        row={row}
        report={{
          cohort: { ...cohort, workClasses: ["security", "architecture"] },
          rows: [row],
        }}
        runs={[]}
        versions={[]}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    const security = within(
      screen
        .getByText("Security", { exact: true })
        .closest("li") as HTMLElement,
    );
    expect(security.getByText("2/5")).toBeInTheDocument();
    expect(screen.getByText("2/7")).toBeInTheDocument();
    // Two cases scored, one complete: the page shows the board's count.
    expect(
      screen.getByText("Fully tested", { selector: "dt" }).nextElementSibling,
    ).toHaveTextContent("1/7");
    expect(screen.queryByText(/Passed: 1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not tested: 3/)).not.toBeInTheDocument();
    expect(screen.queryByText("Preliminary")).not.toBeInTheDocument();
    expect(screen.queryByText("Not ranked")).not.toBeInTheDocument();
    expect(security.queryByText("1/1")).not.toBeInTheDocument();
    expect(security.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(security.getByText("990")).toBeInTheDocument();
    const architecture = within(
      screen
        .getByText("Architecture", { exact: true })
        .closest("li") as HTMLElement,
    );
    expect(architecture.getByText("0/2")).toBeInTheDocument();
    expect(screen.queryByText(/not tested: 2/)).not.toBeInTheDocument();
    expect(screen.queryByText("Untested")).not.toBeInTheDocument();
    await userEvent.hover(security.getByText("2/5"));
    expect(
      await screen.findByRole("tooltip", {}, { timeout: 4_000 }),
    ).toHaveTextContent(
      "Tested 2 of 5. Passed: 1; not passed: 1; not tested: 3.",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Only current test versions count; revised tests need a new run.",
    );
    await userEvent.unhover(security.getByText("2/5"));
    await userEvent.hover(security.getByText("990"));
    expect(
      await screen.findByRole("tooltip", {}, { timeout: 4_000 }),
    ).toHaveTextContent(
      "990 / 1000, based on 2 of 5 current tests. 3 unmeasured tests are not included.",
    );
    await userEvent.unhover(security.getByText("990"));
    await userEvent.hover(screen.getByText("1000"));
    expect(
      await screen.findByRole("tooltip", {}, { timeout: 4_000 }),
    ).toHaveTextContent(
      "1000 / 1000, based on 2 of 7 current tests. 5 unmeasured tests are not included. Average of the measured category scores.",
    );
  });
  it("opens the run dialog, following a run that measures the model now", async () => {
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    const openDialog = vi.fn();
    const openRun = vi.fn();
    const gaps = leaderboardRow({
      status: "preliminary",
      missingVersionIds: ["version-1", "version-2"],
    });
    const paused = {
      ...runSummary,
      id: "paused-run-1",
      state: "paused",
      request: { ...runSummary.request, versionIds: ["version-1"] },
    };
    const page = (runs: (typeof runSummary)[]) => (
      <BenchmarkConfigurationPage
        row={gaps}
        report={{ cohort, rows: [gaps] }}
        runs={runs}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={openDialog}
        onOpenRun={openRun}
      />
    );
    const { rerender } = wrap(page([paused, runSummary]));
    // A run not baked yet goes to the dialog, which goes on with it inside
    // its window and explains it once the window closed.
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(openDialog).toHaveBeenLastCalledWith("paused-run-1");
    await userEvent.click(
      screen.getByRole("button", { name: "Queued in run paused-r" }),
    );
    expect(openRun).toHaveBeenCalledWith("paused-run-1");
    rerender(
      page([
        {
          ...paused,
          id: "running-run-1",
          state: "running",
          openCells: [
            {
              configurationId: configuration.id,
              versionId: "version-1",
              running: true,
            },
          ],
        },
      ]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(openDialog).toHaveBeenLastCalledWith("running-run-1");
  });
  it("keeps settled model cards unchanged while opening Run and uses fresh evidence navigation", async () => {
    const row = leaderboardRow({});
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort,
      rows: [row],
    });
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
      { ...attemptSummary, score: 1 },
    ]);
    vi.mocked(benchmarkApi.getInventory).mockResolvedValue([]);
    const location: BenchmarkLocation = {
      section: "leaderboard",
      configurationId: rowKey(row),
    };
    const oldNavigate = vi.fn();
    const newNavigate = vi.fn();
    const selectSession = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = (onNavigate: typeof oldNavigate) => (
      <QueryClientProvider client={client}>
        <BenchmarksView
          location={location}
          onNavigate={onNavigate}
          onSelectSession={selectSession}
        />
      </QueryClientProvider>
    );
    const rendered = render(view(oldNavigate));
    const task = await screen.findByRole("button", { name: /^Task 1: / });
    await waitFor(() => expect(task).toBeEnabled());
    // The grid keeps three planned repetition dots; the dialog's standing
    // result separately shows its one recorded repetition.
    const gridDots = repetitionRenders.mock.calls.at(-1)?.[0];
    expect(gridDots).toEqual(["passed", "queued", "queued"]);
    repetitionRenders.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByRole("dialog");
    await waitFor(() => expect(benchmarkApi.getInventory).toHaveBeenCalled());
    expect(
      repetitionRenders.mock.calls.some(([dots]) => dots === gridDots),
    ).toBe(false);
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    rendered.rerender(view(newNavigate));
    await userEvent.click(screen.getByRole("button", { name: /^Task 1: / }));
    expect(newNavigate).toHaveBeenLastCalledWith({
      ...location,
      attemptId: attemptSummary.id,
    });
    expect(oldNavigate).not.toHaveBeenCalled();
    client.clear();
  });

  it("keeps unchanged cards quiet across evidence navigation while live results still update", async () => {
    const secondVersion = {
      ...definition.versions[0],
      id: "version-2",
      manifest: { ...draft, name: "Second transformation" },
    };
    catalog([
      { ...definition, versions: [...definition.versions, secondVersion] },
    ]);
    const secondAttempt = {
      ...attempt,
      id: "attempt-2",
      versionId: "version-2",
    };
    const row = leaderboardRow({
      scoredVersionIds: ["version-1", "version-2"],
      attemptIds: [attempt.id, secondAttempt.id],
    });
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort: { ...cohort, versionIds: row.scoredVersionIds },
      rows: [row],
    });
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([]);
    const summaries = [
      { ...attemptSummary, score: 1 },
      {
        ...attemptSummary,
        id: secondAttempt.id,
        versionId: "version-2",
        score: 1,
      },
    ];
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue(summaries);
    vi.mocked(benchmarkApi.getEvidence).mockImplementation(async (id) =>
      id === secondAttempt.id ? secondAttempt : attempt,
    );
    vi.mocked(benchmarkApi.getRun).mockResolvedValue({
      ...run,
      attempts: [attempt, secondAttempt],
    });
    const initialLocation: BenchmarkLocation = {
      section: "leaderboard",
      configurationId: rowKey(row),
    };
    const navigated = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    function Host({ canonical = false }: { canonical?: boolean }) {
      const [location, setLocation] = useState(initialLocation);
      return (
        <QueryClientProvider client={client}>
          <div style={{ overflowY: "auto" }}>
            <BenchmarksView
              location={
                canonical
                  ? { ...location, configurationId: modelKey(configuration) }
                  : location
              }
              onNavigate={(next) => {
                navigated(next);
                setLocation(next);
              }}
              onSelectSession={vi.fn()}
            />
          </div>
        </QueryClientProvider>
      );
    }
    const rendered = render(<Host />);
    const first = await screen.findByRole("button", { name: /^Task 1: / });
    const second = await screen.findByRole("button", { name: /^Task 2: / });
    await waitFor(() => {
      expect(first).toBeEnabled();
      expect(second).toBeEnabled();
    });
    repetitionRenders.mockClear();
    act(() => second.focus());
    await userEvent.tab({ shift: true });
    expect(first).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(benchmarkApi.getEvidence).toHaveBeenCalledWith(attempt.id),
    );
    expect(navigated).toHaveBeenLastCalledWith({
      ...initialLocation,
      attemptId: attempt.id,
    });
    expect(repetitionRenders).not.toHaveBeenCalled();

    // A genuine query update still changes the affected card behind the dialog.
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
      summaries[0],
      { ...summaries[1], outcome: "fail", score: 0 },
    ]);
    await act(async () => {
      await client.refetchQueries({ queryKey: ["benchmarks", "cells"] });
    });
    await waitFor(() =>
      expect(
        within(second).getByRole("img", { hidden: true }),
      ).toHaveAccessibleName(/0 of 1/),
    );
    expect(repetitionRenders.mock.calls).toEqual([
      [["failed", "queued", "queued"]],
    ]);
    repetitionRenders.mockClear();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(navigated).toHaveBeenLastCalledWith({
      ...initialLocation,
      attemptId: undefined,
    });
    await waitFor(() => expect(first).toHaveFocus());
    expect(repetitionRenders).not.toHaveBeenCalled();
    // The legacy configuration URL and canonical model URL share this page.
    // A stable handler must still preserve the newly committed route fields.
    rendered.rerender(<Host canonical />);
    await userEvent.click(second);
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(benchmarkApi.getEvidence).toHaveBeenCalledWith(secondAttempt.id),
    );
    expect(navigated).toHaveBeenLastCalledWith({
      ...initialLocation,
      configurationId: modelKey(configuration),
      attemptId: secondAttempt.id,
    });
    expect(repetitionRenders).not.toHaveBeenCalled();
    client.clear();
  });

  it.each([
    "model",
    "section",
    "point",
  ] as const)("does not restore a stale model task after its %s scope changes", async (change) => {
    const row = leaderboardRow();
    const report = { cohort, rows: [row] };
    const snapshot: ModelHistoryViewPoint = {
      id: "invented-point-a",
      runId: run.id,
      createdAt: 1_000,
      recalculatedReport: report,
      backfilledVersionIds: [],
      revisedVersionIds: [],
    };
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue(report);
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([snapshot]);
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
      { ...attemptSummary, score: 1 },
    ]);
    const initial: BenchmarkLocation = {
      section: "leaderboard",
      configurationId: rowKey(row),
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    let navigate = (_location: BenchmarkLocation) => {};
    function Host() {
      const [location, setLocation] = useState(initial);
      navigate = setLocation;
      return (
        <QueryClientProvider client={client}>
          <div style={{ overflowY: "auto" }}>
            <BenchmarksView
              location={location}
              onNavigate={setLocation}
              onSelectSession={vi.fn()}
            />
          </div>
        </QueryClientProvider>
      );
    }
    const view = render(<Host />);
    if (change === "point") {
      await waitFor(() =>
        expect(
          view.container.querySelector(
            '[data-history-point="invented-point-a"]',
          ),
        ).not.toBeNull(),
      );
      const point = view.container.querySelector(
        '[data-history-point="invented-point-a"]',
      );
      if (!point) throw new Error("Missing invented history point");
      fireEvent.click(point);
    }
    const task = await screen.findByRole("button", { name: /^Task 1: / });
    await waitFor(() => expect(task).toBeEnabled());
    act(() => task.focus());
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("dialog");
    if (change === "point") {
      act(() => {
        client.setQueriesData({ queryKey: ["benchmarks", "history"] }, [
          { ...snapshot, id: "invented-point-b", createdAt: 2_000 },
        ]);
      });
      await waitFor(() =>
        expect(
          view.container.querySelector(
            '[data-history-point="invented-point-b"]',
          ),
        ).not.toBeNull(),
      );
    } else {
      act(() =>
        navigate(
          change === "model"
            ? {
                ...initial,
                configurationId: modelKey(configuration),
                attemptId: attempt.id,
              }
            : { section: "development", attemptId: attempt.id },
        ),
      );
    }
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    if (change === "section") act(() => navigate(initial));
    const current = await screen.findByRole("button", { name: /^Task 1: / });
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(current).not.toHaveFocus();
    client.clear();
  });

  it("runs the model page's model from its dialog on today's runtime", async () => {
    const stale = {
      ...configuration,
      inventoryRevision: "runtime-of-the-last-attempt",
    };
    const unfinished = leaderboardRow({
      configuration: stale,
      status: "preliminary",
      scoredVersionIds: [],
      missingVersionIds: ["version-1"],
    });
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort,
      rows: [unfinished],
    });
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
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
    vi.mocked(benchmarkApi.startRun).mockResolvedValue(run);
    vi.mocked(benchmarkApi.getRun).mockResolvedValue(run);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    await userEvent.click(await screen.findByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("model-1");
    expect(
      within(dialog).getByText("1 of 1 tests, 3 attempts"),
    ).toBeInTheDocument();
    const start = within(dialog).getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);
    await waitFor(() =>
      expect(benchmarkApi.startRun).toHaveBeenCalledWith(
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
  });
  it("hands the run dialog the model's own row, whose cells span its configurations", async () => {
    // The model ran on two runtimes: each configuration row holds part of
    // its cells, the model row holds them all.
    const older = { ...configuration, inventoryRevision: "runtime-older" };
    const own = leaderboardRow({
      configuration,
      scoredVersionIds: [],
      attemptIds: [],
      completeVersionIds: [],
    });
    const other = leaderboardRow({
      configuration: older,
      scoredVersionIds: ["version-2"],
      attemptIds: ["older-only"],
    });
    const model = leaderboardRow({
      configuration,
      scoredVersionIds: ["version-1"],
      attemptIds: ["older-only"],
      completeVersionIds: ["version-1"],
    });
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort,
      rows: [own, other],
      models: [
        {
          key: "model-1",
          providerId: configuration.providerId,
          modelId: configuration.modelId,
          configurationKeys: [rowKey(own), rowKey(other)],
          row: model,
        },
      ],
    });
    vi.mocked(benchmarkApi.listRuns).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getCapabilities).mockResolvedValue([]);
    vi.mocked(benchmarkApi.getInventory).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    vi.mocked(invoke).mockResolvedValue({
      accounts: [],
      defaults: {},
      automaticSwitching: {},
    });
    wrap(
      <BenchmarksView
        location={{ section: "leaderboard", configurationId: rowKey(own) }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Run" }));
    const dialog = await screen.findByRole("dialog");
    // The model row holds the test complete, measured on the older runtime:
    // nothing is owed, though this configuration alone has no cell of it.
    expect(
      await within(dialog).findByText("0 of 1 tests, 0 attempts"),
    ).toBeInTheDocument();
  });
  it("starts a different attempt set on its first page", async () => {
    serveListedPages();
    const many = Array.from({ length: 60 }, (_, index) => `current-${index}`);
    const { rerender } = wrap(attemptList(many));
    await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await listedPage(many, 50);
    rerender(attemptList(["older-0", "older-1"]));
    await listedPage(["older-0", "older-1"], 0);
    expect(
      await screen.findAllByRole("button", { name: "Inspect" }),
    ).toHaveLength(2);
  });
  it("keeps the page while the listed attempts only grow", async () => {
    serveListedPages();
    const many = Array.from({ length: 60 }, (_, index) => `current-${index}`);
    const { rerender } = wrap(attemptList(many));
    await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await listedPage(many, 50);
    // A case settles while the run goes on: its attempts join the list.
    const grown = [...many, "settled-60"];
    rerender(attemptList(grown));
    await listedPage(grown, 50);
    // Another reset key is another listing, read from its first page.
    rerender(attemptList(grown, "current"));
    await listedPage(grown, 0);
    await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await listedPage(grown, 50);
    const point = [...grown, "settled-61"];
    rerender(attemptList(point, "current"));
    await listedPage(point, 50);
    rerender(attemptList(point, "true:point-1"));
    await listedPage(point, 0);
  });
  it("keeps the page of a chosen listing while newer cells replace its attempts", async () => {
    serveListedPages();
    const many = Array.from({ length: 60 }, (_, index) => `current-${index}`);
    const { rerender } = wrap(attemptList(many, "false:current"));
    await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await listedPage(many, 50);
    // A retested case settles: its new attempts replace the older cell's.
    const replaced = [...many.slice(1), "retest-0", "retest-1", "retest-2"];
    rerender(attemptList(replaced, "false:current"));
    await listedPage(replaced, 50);
    // A listing that shrinks below the page shows its last page instead.
    const fewer = replaced.slice(0, 40);
    rerender(attemptList(fewer, "false:current"));
    await listedPage(fewer, 0);
  });
  it("starts a listing the reader returns to on its first page", async () => {
    serveListedPages();
    const many = Array.from({ length: 60 }, (_, index) => `current-${index}`);
    const point = ["point-0", "point-1"];
    // With a reset key per choice, and without one, where the ids tell.
    for (const [current, older] of [
      ["false:current", "false:point-1"],
      [undefined, undefined],
    ]) {
      cleanup();
      const { rerender } = wrap(attemptList(many, current));
      await screen.findAllByRole("button", { name: "Inspect" });
      await userEvent.click(screen.getByRole("button", { name: "Next" }));
      await listedPage(many, 50);
      rerender(attemptList(point, older));
      await listedPage(point, 0);
      rerender(attemptList(many, current));
      await listedPage(many, 0);
      expect(
        await screen.findByRole("button", { name: "Previous" }),
      ).toBeDisabled();
    }
  });
  it("ranks every board on its own and re-ranks from a table column", async () => {
    const rows = [
      leaderboardRow({
        configuration: { ...configuration, id: "a", modelId: "alpha" },
        points: 1000,
        axes: [codingAxis(200)],
      }),
      leaderboardRow({
        configuration: { ...configuration, id: "b", modelId: "beta" },
        points: 500,
        axes: [codingAxis(1000)],
      }),
      leaderboardRow({
        configuration: { ...configuration, id: "c", modelId: "gamma" },
        points: 1000,
        axes: [codingAxis(67)],
      }),
      leaderboardRow({
        configuration: { ...configuration, id: "d", modelId: "delta" },
        points: 900,
        status: "preliminary",
        axes: [codingAxis(900)],
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
    // Ranked rows by score first; a row not fully tested has no rank and
    // follows them.
    expect(order()).toEqual(["1 alpha", "1 gamma", "3 beta", "– delta"]);
    const profile = within(screen.getAllByRole("row")[1]).getByRole("img");
    expect(profile).toHaveAccessibleName("Algorithms and clean code: 200");
    expect(
      screen.queryByRole("button", { name: /unranked/ }),
    ).not.toBeInTheDocument();
    // Only the overall board and one board per work class remain.
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "",
      "",
    ]);
    await userEvent.click(
      screen.getByRole("tab", { name: "Algorithms and clean code" }),
    );
    expect(order()).toEqual(["1 beta", "2 alpha", "3 gamma", "– delta"]);
    await userEvent.click(screen.getByRole("radio", { name: "Table" }));
    await userEvent.click(screen.getByRole("button", { name: "Overall" }));
    expect(order()).toEqual(["1 alpha", "1 gamma", "3 beta", "– delta"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Algorithms and clean code" }),
    );
    expect(order()).toEqual(["1 beta", "2 alpha", "3 gamma", "– delta"]);
    expect(
      screen.getByRole("button", { name: "Algorithms and clean code" }),
    ).toHaveAttribute("aria-pressed", "true");
    const first = screen.getAllByRole("row")[1];
    expect(
      within(first)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "1",
      // The vendor icon carries its own title text; the effort follows the name.
      "ClaudebetahighAnthropic",
      "500",
      "1000",
      // Fully tested, then price and context: unknown here.
      "–",
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
        axes: index < 30 ? [codingAxis(100 + index)] : [],
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
    await userEvent.click(
      screen.getByRole("tab", { name: "Algorithms and clean code" }),
    );
    expect(onPageChange).toHaveBeenCalledWith(0);
    // Before the page resets, the second page holds the rows the class board
    // cannot rank; they follow every ranked row.
    expect(ranks()).toEqual(["–", "–", "–", "–", "–"]);
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
          rows: ["budget_reached", "selection_changed", "untested"].map(
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
    expect(screen.getByText("Untested")).toBeInTheDocument();
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
          permittedSplits: ["train"],
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
  it.each([
    "development",
    "held_out",
  ])("keeps %s diagnostics separate from selector training evidence", async (split) => {
    vi.mocked(benchmarkApi.getRoutingEvidence).mockResolvedValue({
      schemaVersion: 1,
      generatedAt: 10,
      queryHash: "query-hash",
      mode: "exact",
      candidates: [],
    });
    const user = userEvent.setup();
    wrap(
      <BenchmarkRoutingDialog
        versions={definition.versions.map((version) => ({
          ...version,
          manifest: { ...version.manifest, split },
        }))}
        runs={[runSummary]}
        onClose={vi.fn()}
        onEvidence={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Read evidence" }));
    await waitFor(() =>
      expect(benchmarkApi.getRoutingEvidence).toHaveBeenLastCalledWith(
        expect.objectContaining({
          purpose: "analysis",
          permittedSplits: [split],
        }),
      ),
    );
    await user.click(screen.getByRole("combobox", { name: "Purpose" }));
    await user.click(screen.getByRole("option", { name: /Selector input/ }));
    await user.click(screen.getByRole("button", { name: "Read evidence" }));
    await waitFor(() =>
      expect(benchmarkApi.getRoutingEvidence).toHaveBeenLastCalledWith(
        expect.objectContaining({
          purpose: "selector",
          permittedSplits: ["train"],
        }),
      ),
    );
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
    catalog([generated]);
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
  it("shows how each library case separates the models and marks smoke cases", async () => {
    const smoke = {
      ...definition,
      id: "definition-2",
      draft: { ...definition.draft, name: "Every model passes" },
      versions: [
        {
          ...definition.versions[0],
          id: "version-2",
          definitionId: "definition-2",
        },
      ],
    };
    catalog([definition, smoke]);
    vi.mocked(benchmarkApi.getCaseStats).mockResolvedValue([
      {
        versionId: "version-1",
        definitionId: definition.id,
        models: 3,
        passed: 2,
        spread: 0.5,
        flaky: 1,
        smoke: false,
      },
      {
        versionId: "version-2",
        definitionId: "definition-2",
        models: 3,
        passed: 3,
        spread: 0,
        flaky: 0,
        smoke: true,
      },
    ]);
    wrap(
      <BenchmarksView
        location={{ section: "development" }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    const first = (
      await screen.findByRole("button", { name: definition.draft.name })
    ).closest("tr") as HTMLElement;
    expect(within(first).getByText("2 / 3")).toBeInTheDocument();
    expect(first).not.toHaveTextContent("flaky");
    expect(
      screen.queryByRole("columnheader", { name: "Work class" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Version" }),
    ).toBeInTheDocument();
    expect(within(first).getByText("v1")).toBeInTheDocument();
    expect(
      within(first).getByRole("img", { name: "General" }),
    ).toBeInTheDocument();
    expect(first).not.toHaveTextContent("Smoke set");
    const second = screen
      .getByRole("button", { name: "Every model passes" })
      .closest("tr") as HTMLElement;
    expect(second).toHaveTextContent("Smoke set");
    expect(within(second).getByText("3 / 3")).toBeInTheDocument();
    expect(second).not.toHaveTextContent("flaky");
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
  it("lists summaries and reads only the opened test in full", async () => {
    const full = {
      ...definition,
      versions: [
        {
          ...definition.versions[0],
          manifest: {
            ...definition.versions[0].manifest,
            prompt: "Full published prompt",
          },
        },
      ],
    };
    vi.mocked(benchmarkApi.getDefinition).mockResolvedValue(full);
    const view = wrap(
      <BenchmarksView
        location={{ section: "development" }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: definition.draft.name });
    expect(benchmarkApi.getDefinition).not.toHaveBeenCalled();
    expect(benchmarkApi.getVersion).not.toHaveBeenCalled();
    view.rerender(
      <BenchmarksView
        location={{ section: "development", benchmarkId: definition.id }}
        onNavigate={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    expect(await screen.findByText("Full published prompt")).toBeVisible();
    expect(benchmarkApi.getDefinition).toHaveBeenCalledWith(definition.id);
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
    await screen.findByRole("heading", { name: definition.draft.name });
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

  it("uses one current-pool history while keeping each measurement on its original date", async () => {
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
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue(
      modelHistoryViewFixture([
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
                  "1/1 current cases; 1 reviewed later; recalculated using today's evidence",
                // Later review metadata must not move the observation date.
                measuredAt: Date.UTC(2026, 5, 20, 12),
              },
            ],
          },
          backfilledVersionIds: [],
          revisedVersionIds: ["version-1"],
        },
        {
          id: "latest",
          runId: runSummary.id,
          createdAt: latestAt,
          report: { cohort, rows: [latestRow] },
        },
      ]),
    );
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
      screen.queryByRole("button", { name: /: 600 points/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Current pool" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "As recorded" }),
    ).not.toBeInTheDocument();
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
    expect(screen.queryByText("Preliminary")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/recalculated using today's evidence/),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
        attemptIds: ["attempt-0"],
        limit: 100,
      }),
    );
    // Run measures today's model, whichever point is shown, from its
    // newest run not baked yet.
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(catchUp).toHaveBeenCalledWith("run-1");
    expect(benchmarkApi.getModelHistoryView).toHaveBeenCalledWith(
      configuration,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Show current results" }),
    );
    expect(rating()).toBe("900");
  });

  it("omits obsolete observations instead of falling back to a different scoring method", async () => {
    const dated = leaderboardRow({ points: 600, attemptIds: ["attempt-0"] });
    const current = leaderboardRow({ points: 900 });
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue(
      modelHistoryViewFixture([
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
        {
          id: "current-pool",
          runId: runSummary.id,
          createdAt: 2_000,
          report: { cohort, rows: [current] },
          recalculatedReport: { cohort, rows: [current] },
        },
      ]),
    );
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    wrap(
      <BenchmarkConfigurationPage
        row={current}
        report={{ cohort, rows: [current] }}
        runs={[runSummary]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /: 900 points/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /: 600 points/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "As recorded" }),
    ).not.toBeInTheDocument();
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
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue(
      modelHistoryViewFixture([
        point("earlier:1", 1_000, 400),
        point(`${runSummary.id}:2000`, 2_000, 500),
      ]),
    );
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
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue(
      modelHistoryViewFixture([
        point("earlier:1", 1_000, 400),
        point(`${runSummary.id}:3000`, 3_000, 700),
      ]),
    );
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(rating()).toBe("700"));
    expect(
      screen.getByRole("button", { name: /: 700 points/ }),
    ).toHaveAttribute("aria-pressed", "true");
    client.clear();
  });

  it("marks points short of the pool or its repetitions and names the cases each one added", async () => {
    const partial = leaderboardRow({
      points: 950,
      scored: 1,
      planned: 2,
      complete: 1,
      status: "preliminary",
      scoredVersionIds: ["version-1"],
    });
    // Every case scored, one still owing repetitions.
    const settling = leaderboardRow({
      points: 700,
      scored: 2,
      planned: 2,
      complete: 1,
      status: "preliminary",
      scoredVersionIds: ["version-1", "version-2"],
      attemptIds: ["attempt-1", "attempt-2"],
    });
    const whole = leaderboardRow({
      points: 800,
      scored: 2,
      planned: 2,
      complete: 2,
      scoredVersionIds: ["version-1", "version-2"],
      attemptIds: ["attempt-1", "attempt-2", "attempt-3"],
    });
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue(
      modelHistoryViewFixture([
        {
          id: "first",
          runId: "run-0",
          createdAt: 1_000,
          report: { cohort, rows: [partial] },
        },
        {
          id: "settling",
          runId: runSummary.id,
          createdAt: 1_500,
          report: { cohort, rows: [settling] },
        },
        {
          id: "whole",
          runId: runSummary.id,
          createdAt: 2_000,
          report: { cohort, rows: [whole] },
        },
      ]),
    );
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    wrap(
      <BenchmarkConfigurationPage
        row={whole}
        report={{ cohort, rows: [whole] }}
        runs={[runSummary]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    const first = await screen.findByRole("button", {
      name: /: 950 points · 1\/2 cases$/,
    });
    const second = screen.getByRole("button", {
      name: /: 700 points · 2\/2 cases$/,
    });
    const third = screen.getByRole("button", {
      name: /: 800 points · 2\/2 cases$/,
    });
    expect(first).toHaveAttribute("data-coverage", "partial");
    expect(second).toHaveAttribute("data-coverage", "partial");
    expect(third).toHaveAttribute("data-coverage", "complete");
    act(() => second.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "1 case added since the previous point",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "1 case still has repetitions to run",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(/Partial/);
    act(() => second.blur());
    act(() => third.focus());
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(
      /since the previous point|repetitions|Partial/,
    );
    act(() => third.blur());
    act(() => first.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Partial coverage: the points average only the measured cases, not the whole pool.",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(
      /since the previous point/,
    );
  });
});

describe("model page history states", () => {
  afterEach(cleanup);

  function page() {
    const row = leaderboardRow({ points: 900 });
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    wrap(
      <BenchmarkConfigurationPage
        row={row}
        report={{ cohort, rows: [row] }}
        runs={[]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
  }

  it("says the history is loading instead of leaving an empty gap", async () => {
    let settle: (points: never[]) => void = () => {};
    vi.mocked(benchmarkApi.getModelHistoryView).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    page();
    expect(
      screen.getByText(
        /Loading the rating history: each point is recalculated/,
      ),
    ).toBeInTheDocument();
    await act(async () => settle([]));
    await waitFor(() =>
      expect(screen.queryByText(/Loading the rating history/)).toBeNull(),
    );
  });

  it("says why the history failed and reads it again on request", async () => {
    vi.mocked(benchmarkApi.getModelHistoryView).mockRejectedValueOnce(
      new Error("store busy"),
    );
    page();
    expect(
      await screen.findByText(
        "The rating history could not be read: store busy",
      ),
    ).toBeInTheDocument();
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    const reads = vi.mocked(benchmarkApi.getModelHistoryView).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.queryByText(/could not be read/)).toBeNull(),
    );
    expect(vi.mocked(benchmarkApi.getModelHistoryView).mock.calls.length).toBe(
      reads + 1,
    );
  });
});

describe("model page fully tested points", () => {
  afterEach(cleanup);

  it("marks the history points that covered the measurement suite", async () => {
    // Both points cover 1 of 2 pool cases; the suite holds only one.
    const short = leaderboardRow({
      points: 600,
      planned: 2,
      suitePlanned: 1,
      suiteComplete: 0,
      attemptIds: ["attempt-0"],
    });
    const full = leaderboardRow({
      points: 900,
      planned: 2,
      suitePlanned: 1,
      suiteComplete: 1,
    });
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue(
      modelHistoryViewFixture([
        {
          id: "short",
          runId: "run-0",
          createdAt: 1_000,
          report: { cohort, rows: [short] },
        },
        {
          id: "full",
          runId: runSummary.id,
          createdAt: 2_000,
          report: { cohort, rows: [full] },
        },
      ]),
    );
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    wrap(
      <BenchmarkConfigurationPage
        row={full}
        report={{ cohort, rows: [full] }}
        runs={[runSummary]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /: 600 points/ }),
    ).toHaveAttribute("data-coverage", "partial");
    expect(
      screen.getByRole("button", { name: /: 900 points/ }),
    ).toHaveAttribute("data-coverage", "complete");
  });
});

describe("model page effort", () => {
  afterEach(cleanup);

  function page(effort: string | null) {
    const row = leaderboardRow({ configuration: { ...configuration, effort } });
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([]);
    wrap(
      <BenchmarkConfigurationPage
        row={row}
        report={{ cohort, rows: [row] }}
        runs={[]}
        versions={definition.versions}
        onEvidence={vi.fn()}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    return within(
      screen.getByRole("heading", { name: "model-1" })
        .parentElement as HTMLElement,
    );
  }

  it("names the level the model was measured at", () => {
    const title = page("high");
    expect(title.getByText("Effort: high")).toBeInTheDocument();
    expect(title.queryByText("No effort setting")).not.toBeInTheDocument();
  });

  it("says a model without effort levels was measured with none", async () => {
    const title = page(null);
    await userEvent.hover(title.getByText("No effort setting"));
    expect(
      await screen.findByRole("tooltip", {}, { timeout: 4_000 }),
    ).toHaveTextContent(
      "Measured without an effort setting. Models that offer no reasoning effort levels run this way.",
    );
  });

  it("never names the CLI's default as an effort", () => {
    const title = page("default");
    expect(title.queryByText("default")).not.toBeInTheDocument();
    expect(title.queryByText("No effort setting")).not.toBeInTheDocument();
  });
});

describe("leaderboard fully tested", () => {
  afterEach(cleanup);

  const at = Date.UTC(2026, 9, 18, 12);
  function board() {
    const full = leaderboardRow({
      configuration: { ...configuration, id: "a", modelId: "alpha" },
      points: 700,
      suitePlanned: 285,
      suiteComplete: 285,
      fullyTestedAt: at,
    });
    // Covered the suite once; two new cases joined since.
    const grown = leaderboardRow({
      configuration: { ...configuration, id: "b", modelId: "beta" },
      points: 950,
      status: "preliminary",
      suitePlanned: 285,
      suiteComplete: 283,
      fullyTestedAt: at - 86_400_000,
    });
    const partial = leaderboardRow({
      configuration: { ...configuration, id: "c", modelId: "gamma" },
      points: 990,
      status: "preliminary",
      suitePlanned: 285,
      suiteComplete: 174,
      fullyTestedAt: null,
    });
    wrap(
      <LeaderboardView
        {...scopeProps}
        onOpen={vi.fn()}
        report={{ cohort, rows: [partial, grown, full] }}
      />,
    );
    const rowOf = (model: string) =>
      screen
        .getByRole("button", { name: `Open ${model} · high` })
        .closest("tr") as HTMLElement;
    const cell = (model: string) => {
      const index = screen
        .getAllByRole("columnheader")
        .findIndex((header) => header.textContent === "Fully tested");
      return within(rowOf(model)).getAllByRole("cell")[index];
    };
    return { rowOf, cell };
  }

  it("ranks only fully tested rows and lists partial scores muted below them", () => {
    const { rowOf, cell } = board();
    const order = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0].textContent);
    // Higher partial scores still follow the one ranked row.
    expect(order).toEqual(["1", "–", "–"]);
    expect(within(rowOf("alpha")).getByText("700")).not.toHaveClass(
      "text-muted-foreground",
    );
    expect(within(rowOf("gamma")).getByText("990")).toHaveClass(
      "text-muted-foreground",
    );
    expect(cell("alpha")).toHaveTextContent("Oct 18, 2026");
    expect(cell("gamma")).toHaveTextContent("–174/285");
  });

  it("shows a dash for a row short of today's suite, whatever it covered before", async () => {
    const { cell } = board();
    // Beta covered the suite on Oct 17, before it grew.
    expect(cell("beta")).toHaveTextContent("–283/285");
    expect(cell("beta")).not.toHaveTextContent("Oct 17, 2026");
  });

  it("names the column in Spanish", async () => {
    await act(() => i18n.changeLanguage("es"));
    try {
      board();
      expect(
        screen.getByRole("columnheader", { name: "Probado por completo" }),
      ).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage("en"));
    }
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
    await userEvent.click(within(list).getByText("alpha · high"));
    await userEvent.click(within(list).getByText("gamma · high"));
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
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue(
      modelHistoryViewFixture([
        {
          id: "historical",
          runId: runSummary.id,
          createdAt: 1000,
          report: { cohort, rows: [historical] },
        },
      ]),
    );
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

describe("projected model history selection", () => {
  afterEach(cleanup);

  it("keeps native model standings, pool task order and evidence ids from the selected recalculation", async () => {
    const versions = [
      {
        ...definition.versions[0],
        manifest: { ...draft, name: "A text case", workClassId: "algorithms" },
      },
      {
        ...definition.versions[0],
        id: "version-2",
        manifest: {
          ...draft,
          name: "B repository case",
          workClassId: "debugging",
        },
      },
      {
        ...definition.versions[0],
        id: "excluded-case",
        manifest: {
          ...draft,
          name: "Excluded authored case",
          workClassId: "algorithms",
        },
      },
    ];
    const text = leaderboardRow({ points: 250 });
    const repository = leaderboardRow({
      configuration: {
        ...configuration,
        id: "repository-config",
        executionProfile: "native_repository",
      },
      points: 350,
    });
    const selectedRow = leaderboardRow({
      points: 650,
      scored: 2,
      planned: 2,
      complete: 2,
      suitePlanned: 2,
      suiteComplete: 2,
      scoredVersionIds: ["version-1", "version-2"],
      ownVersionIds: ["excluded-case"],
      attemptIds: ["refused-b", "historical-b", "historical-a"],
      resultAttemptIds: ["historical-a", "historical-b"],
      axes: [codingAxis(400)],
    });
    const peer = leaderboardRow({
      configuration: {
        ...configuration,
        id: "peer-config",
        modelId: "peer-model",
      },
      points: 800,
      axes: [codingAxis(800)],
    });
    const recalculatedReport = {
      cohort: {
        ...cohort,
        versionIds: versions.map((version) => version.id),
        workClasses: ["debugging", "algorithms"],
      },
      rows: [text, repository, peer],
      models: [
        {
          key: modelKey(configuration),
          providerId: configuration.providerId,
          modelId: configuration.modelId,
          configurationKeys: [rowKey(text), rowKey(repository)],
          row: selectedRow,
        },
        {
          key: modelKey(peer.configuration),
          providerId: peer.configuration.providerId,
          modelId: peer.configuration.modelId,
          configurationKeys: [rowKey(peer)],
          row: peer,
        },
      ],
    };
    vi.mocked(benchmarkApi.getModelHistoryView).mockResolvedValue([
      {
        id: "selected-observation",
        runId: "historical-run",
        createdAt: 2_000,
        recalculatedReport,
        backfilledVersionIds: ["version-2"],
        revisedVersionIds: ["version-1"],
      },
    ]);
    vi.mocked(benchmarkApi.listAttempts).mockResolvedValue([
      { ...attemptSummary, id: "historical-a", runId: "historical-run" },
      {
        ...attemptSummary,
        id: "historical-b",
        runId: "historical-run",
        versionId: "version-2",
      },
      {
        ...attemptSummary,
        id: "refused-b",
        runId: "historical-run",
        versionId: "version-2",
        repetition: 2,
        outcome: "provider_error",
      },
    ]);
    const current = leaderboardRow({ points: 900 });
    const inspect = vi.fn();
    wrap(
      <BenchmarkConfigurationPage
        row={current}
        report={{ cohort, rows: [current] }}
        runs={[]}
        versions={versions}
        onEvidence={inspect}
        onRun={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /: 650 points · 1\/2 cases$/ }),
    );
    expect(
      screen.getByText("Overall rating").nextElementSibling,
    ).toHaveTextContent("650");
    expect(screen.getByText("Rank").nextElementSibling).toHaveTextContent(
      /2\s*of\s*2/,
    );
    expect(
      screen.getByText("Fully tested", { selector: "dt" }).nextElementSibling,
    ).toHaveTextContent("2/2");
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith({
        attemptIds: ["refused-b", "historical-b", "historical-a"],
        limit: 100,
      }),
    );
    const tasks = screen.getAllByRole("button", { name: /^Task \d:/ });
    expect(tasks.map((task) => task.getAttribute("aria-label"))).toEqual([
      "Task 1: B repository case",
      "Task 2: A text case",
    ]);
    await userEvent.click(tasks[0]);
    expect(inspect).toHaveBeenLastCalledWith("historical-b");
    await userEvent.click(tasks[1]);
    expect(inspect).toHaveBeenLastCalledWith("historical-a");
    expect(
      screen.queryByText("Excluded authored case"),
    ).not.toBeInTheDocument();
  });
});
