import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { DesignBenchView } from "../ui/DesignBenchView";
import type { Attempt, DesignEntry } from "../types";
import { configuration } from "./fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) => String(error),
  benchmarkApi: {
    getCandidateObservations: vi.fn(),
    listCatalog: vi.fn(),
    getEvidence: vi.fn(),
  },
}));

const entry = (overrides: Partial<DesignEntry>): DesignEntry => ({
  attemptId: "attempt-1",
  runId: "run-1",
  runCreatedAt: 1000,
  versionId: "version-1",
  name: "Development color swatch",
  taskFamily: "development-gallery-swatch",
  difficulty: "medium",
  outputFormat: "svg",
  configuration,
  phase: "terminal",
  outcome: null,
  output:
    "```svg\n<svg viewBox='0 0 4 4'><rect width='4' height='4'/></svg>\n```",
  finishedAt: 2000,
  durationMs: 1000,
  outputTokens: 500,
  cost: 0.02,
  review: null,
  judges: [],
  score: null,
  ...overrides,
});

function show(entries: DesignEntry[], onEvidence = vi.fn()) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DesignBenchView
        entries={entries}
        loading={false}
        onEvidence={onEvidence}
      />
    </QueryClientProvider>,
  );
  return onEvidence;
}

const designOrder = () =>
  screen
    .getAllByRole("button", { name: /^Open the design by / })
    .map((card) => card.getAttribute("aria-label"));

describe("design gallery", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchmarkApi.getCandidateObservations).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listCatalog).mockResolvedValue([]);
  });

  it("shows every rendering of a brief under the model that made it", async () => {
    const onEvidence = show([
      entry({
        attemptId: "attempt-1",
        configuration: { ...configuration, id: "a", modelId: "alpha" },
        review: {
          score: 0.7,
          reason: "Required color swatches present",
          details: { adherence: 0.8, craft: 0.6 },
          createdAt: 3000,
        },
        score: 0.7,
      }),
      entry({
        attemptId: "attempt-2",
        configuration: { ...configuration, id: "b", modelId: "beta" },
      }),
      entry({
        attemptId: "attempt-3",
        configuration: { ...configuration, id: "c", modelId: "gamma" },
        output: null,
        outcome: "budget_timeout",
      }),
      entry({
        attemptId: "attempt-4",
        configuration: { ...configuration, id: "d", modelId: "delta" },
        outcome: "judged",
        score: 0.65,
        judges: [
          {
            configuration: { ...configuration, id: "j1", modelId: "judge-one" },
            score: 0.7,
            reason: "Strong composition",
            details: { adherence: 0.8, craft: 0.6 },
          },
          {
            configuration: { ...configuration, id: "j2", modelId: "judge-two" },
            score: 0.6,
            reason: "Uneven spacing",
            details: { adherence: 0.7, craft: 0.5 },
          },
        ],
      }),
    ]);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Open Development color swatch, 4 designs",
      }),
    );
    const reviewed = screen.getByRole("button", {
      name: "Open the design by alpha · high",
    });
    expect(within(reviewed).getByText("alpha")).toBeInTheDocument();
    expect(within(reviewed).getByText("700")).toBeInTheDocument();
    expect(within(reviewed).getByText("$0.02")).toBeInTheDocument();
    expect(within(reviewed).getByText("1 s")).toBeInTheDocument();
    const image = within(reviewed).getByRole("presentation");
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(image.getAttribute("src")).not.toContain("%60%60%60");
    expect(image.getAttribute("src")).toContain("xmlns");
    // A rendering the panel has not judged yet still names its model.
    const pending = screen.getByRole("button", {
      name: "Open the design by beta · high",
    });
    expect(within(pending).getByText("beta")).toBeInTheDocument();
    expect(
      within(pending).getByText("Awaiting the judge panel"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Entry/)).not.toBeInTheDocument();
    const failed = screen.getByRole("button", {
      name: "Open the design by gamma · high",
    });
    expect(within(failed).getByText("gamma")).toBeInTheDocument();
    expect(within(failed).getByText("Time limit reached")).toBeInTheDocument();
    expect(
      within(failed).queryByText("Awaiting the judge panel"),
    ).not.toBeInTheDocument();
    const judged = screen.getByRole("button", {
      name: "Open the design by delta · high",
    });
    expect(within(judged).getByText("delta")).toBeInTheDocument();
    expect(within(judged).getByText("650")).toBeInTheDocument();
    expect(within(judged).getByText("2 judges")).toBeInTheDocument();
    // Scored designs come first, highest score first.
    expect(designOrder().slice(0, 2)).toEqual([
      "Open the design by alpha · high",
      "Open the design by delta · high",
    ]);
    await userEvent.click(pending);
    const detail = await screen.findByRole("dialog");
    await userEvent.click(
      within(detail).getByRole("button", { name: "Open evidence" }),
    );
    expect(onEvidence).toHaveBeenCalledWith("attempt-2");
  });

  it("promises a panel verdict only to a rendering that waits for one", async () => {
    show([
      entry({
        attemptId: "excluded",
        configuration: { ...configuration, id: "a", modelId: "alpha" },
        output: null,
        outcome: "excluded",
      }),
      entry({
        attemptId: "waiting",
        configuration: { ...configuration, id: "b", modelId: "beta" },
        phase: "awaiting_judges",
        outcome: "pending_review",
      }),
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: /^Open Development color swatch/ }),
    );
    const excluded = screen.getByRole("button", {
      name: "Open the design by alpha · high",
    });
    expect(within(excluded).getByText("alpha")).toBeInTheDocument();
    expect(
      within(excluded).queryByText("Awaiting the judge panel"),
    ).not.toBeInTheDocument();
    const waiting = screen.getByRole("button", {
      name: "Open the design by beta · high",
    });
    expect(
      within(waiting).getByText("Awaiting the judge panel"),
    ).toBeInTheDocument();
  });

  it("shows one card per brief with its count and best rendering", async () => {
    show([
      entry({
        attemptId: "low",
        configuration: { ...configuration, id: "a", modelId: "alpha" },
        score: 0.4,
        rendering: "renders/low.png",
      }),
      entry({
        attemptId: "old-best",
        configuration: { ...configuration, id: "b", modelId: "beta" },
        score: 0.9,
        finishedAt: 1500,
        rendering: "renders/old-best.png",
      }),
      entry({
        attemptId: "new-best",
        configuration: { ...configuration, id: "c", modelId: "gamma" },
        score: 0.9,
        finishedAt: 2500,
        rendering: "renders/new-best.png",
      }),
      entry({
        attemptId: "other",
        versionId: "version-2",
        name: "Development paper lantern",
      }),
    ]);
    // The gallery lists briefs, not designs.
    expect(
      screen.queryByRole("button", { name: /^Open the design by / }),
    ).not.toBeInTheDocument();
    const swatch = screen.getByRole("button", {
      name: "Open Development color swatch, 3 designs",
    });
    expect(within(swatch).getByText("3 designs")).toBeInTheDocument();
    // A tie goes to the newest rendering; the stored image is the cover.
    expect(within(swatch).getByRole("presentation").getAttribute("src")).toBe(
      "asset://renders/new-best.png",
    );
    // A brief without a stored image shows its markup.
    const lantern = screen.getByRole("button", {
      name: "Open Development paper lantern, 1 design",
    });
    expect(
      within(lantern).getByRole("presentation").getAttribute("src"),
    ).toMatch(/^data:image\/svg\+xml/);
    await userEvent.click(swatch);
    expect(
      screen.getByRole("heading", { name: "Development color swatch" }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 designs · best score 900")).toBeInTheDocument();
    expect(designOrder()).toEqual([
      "Open the design by gamma · high",
      "Open the design by beta · high",
      "Open the design by alpha · high",
    ]);
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Filter by model name" }),
      "bet",
    );
    expect(designOrder()).toEqual(["Open the design by beta · high"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Design gallery" }),
    );
    expect(
      screen.getByRole("button", { name: /^Open Development paper lantern/ }),
    ).toBeInTheDocument();
  });

  it("shows each measurement point with its own rendering and score", async () => {
    const onEvidence = show([
      entry({
        attemptId: "rep-1",
        score: 0.8,
        rendering: "renders/rep-1.png",
        points: [
          {
            attemptId: "rep-3",
            runId: "run-1",
            repetition: 2,
            finishedAt: Date.UTC(2026, 9, 18, 12),
            durationMs: 65_000,
            cost: 0.5,
            score: 0.6,
            judges: 3,
            rendering: "renders/rep-3.png",
          },
          {
            attemptId: "rep-1",
            runId: "run-1",
            repetition: 0,
            finishedAt: Date.UTC(2026, 9, 18, 11),
            durationMs: 1000,
            cost: 0.02,
            score: 0.8,
            judges: 2,
            rendering: "renders/rep-1.png",
          },
          {
            attemptId: "rep-2",
            runId: "run-1",
            repetition: 1,
            finishedAt: Date.UTC(2026, 9, 18, 11, 30),
            durationMs: 2000,
            cost: 0.03,
            score: 0.7,
            judges: 3,
            rendering: null,
          },
        ],
      }),
    ]);
    vi.mocked(benchmarkApi.getEvidence).mockResolvedValue({
      output: "<svg viewBox='0 0 2 2'><circle r='1' id='second'/></svg>",
    } as Attempt);
    await userEvent.click(
      screen.getByRole("button", { name: /^Open Development color swatch/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open the design by model-1 · high" }),
    );
    const detail = await screen.findByRole("dialog");
    const image = () =>
      within(detail).getByRole("presentation").getAttribute("src");
    // The design opens on its own point.
    expect(image()).toBe("asset://renders/rep-1.png");
    expect(within(detail).getByText("800")).toBeInTheDocument();
    // A stored image that no longer loads gives way to the markup.
    fireEvent.error(within(detail).getByRole("presentation"));
    expect(image()).toMatch(/^data:image\/svg\+xml/);
    expect(within(detail).getAllByRole("radio")).toHaveLength(3);
    await userEvent.click(
      within(detail).getByRole("radio", { name: /repeat 3/ }),
    );
    expect(image()).toBe("asset://renders/rep-3.png");
    expect(within(detail).getByText("600")).toBeInTheDocument();
    expect(within(detail).getByText("$0.5")).toBeInTheDocument();
    // A point without a stored image shows its own markup.
    await userEvent.click(
      within(detail).getByRole("radio", { name: /repeat 2/ }),
    );
    await vi.waitFor(() => expect(image()).toContain("second"));
    expect(benchmarkApi.getEvidence).toHaveBeenCalledWith("rep-2");
    expect(within(detail).getByText("700")).toBeInTheDocument();
    await userEvent.click(
      within(detail).getByRole("button", { name: "Open evidence" }),
    );
    expect(onEvidence).toHaveBeenCalledWith("rep-2");
  });

  it("offers nothing but the hint when no brief has run", () => {
    show([]);
    expect(screen.getByText("No designs yet.")).toBeInTheDocument();
  });
});
