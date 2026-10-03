import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { DesignBenchView } from "../ui/DesignBenchView";
import type { DesignEntry } from "../types";
import { configuration } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) => String(error),
  benchmarkApi: {
    getCandidateObservations: vi.fn(),
    listCatalog: vi.fn(),
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

describe("design gallery", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchmarkApi.getCandidateObservations).mockResolvedValue([]);
    vi.mocked(benchmarkApi.listCatalog).mockResolvedValue([]);
  });

  it("shows every rendering per brief, names a model only after its blind review", async () => {
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
    expect(screen.getByText("Development color swatch")).toBeInTheDocument();
    expect(screen.getByText("4 designs")).toBeInTheDocument();
    const reviewed = screen.getByRole("button", { name: "Open design 1" });
    expect(within(reviewed).getByText("alpha")).toBeInTheDocument();
    expect(within(reviewed).getByText("700")).toBeInTheDocument();
    const image = within(reviewed).getByRole("presentation");
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(image.getAttribute("src")).not.toContain("%60%60%60");
    expect(image.getAttribute("src")).toContain("xmlns");
    const pending = screen.getByRole("button", { name: "Open design 2" });
    expect(within(pending).getByText("Entry 2")).toBeInTheDocument();
    expect(
      within(pending).getByText("Awaiting the judge panel"),
    ).toBeInTheDocument();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    const failed = screen.getByRole("button", { name: "Open design 3" });
    expect(
      within(failed).getByText("Time budget exceeded"),
    ).toBeInTheDocument();
    expect(screen.queryByText("gamma")).not.toBeInTheDocument();
    const judged = screen.getByRole("button", { name: "Open design 4" });
    expect(within(judged).getByText("delta")).toBeInTheDocument();
    expect(within(judged).getByText("650")).toBeInTheDocument();
    expect(within(judged).getByText("2 judges")).toBeInTheDocument();
    await userEvent.click(pending);
    expect(onEvidence).toHaveBeenCalledWith("attempt-2");
  });

  it("offers nothing but the hint when no brief has run", () => {
    show([]);
    expect(screen.getByText("No designs yet.")).toBeInTheDocument();
  });
});
