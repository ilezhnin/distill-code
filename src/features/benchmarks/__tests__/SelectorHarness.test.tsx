import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { personaPrior, rewardPoints } from "../lib/benchmarkSelector";
import type { Configuration } from "../types";
import { SelectorHarness } from "../ui/SelectorHarness";
import { cohort, configuration, leaderboardRow } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) => String(error),
  benchmarkApi: {
    getLeaderboard: vi.fn(),
    selectorHarness: vi.fn(),
  },
}));

const model = (
  providerId: string,
  modelId: string,
  effort: string | null,
): Configuration => ({
  ...configuration,
  id: `${providerId}-${modelId}-${effort}`,
  providerId,
  modelId,
  effort,
});

describe("persona prior", () => {
  it("answers each ranked candidate with its measured model at its effort", () => {
    const opus = model("claude-acp", "opus", "xhigh");
    const opusLow = model("claude-acp", "opus", "low");
    const fable = model("claude-acp", "claude-fable-5-1", "xhigh");
    const haiku = model("claude-acp", "haiku", null);
    // Debugging ranks Fable, then Opus at xhigh; Haiku is in no ranking.
    const prior = personaPrior("debug", [haiku, opusLow, opus, fable]);
    expect(prior[0]).toBe(fable);
    expect(prior).toContain(opus);
    expect(prior).not.toContain(opusLow);
    expect(prior).not.toContain(haiku);
    expect(personaPrior("unknown-class", [opus])).toEqual([]);
  });

  it("reads rewards as points out of 1000", () => {
    expect(rewardPoints(0.8125)).toBe(813);
  });
});

describe("selector harness", () => {
  beforeEach(() => {
    vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
      cohort: { ...cohort, workClasses: ["debug", "writing"] },
      rows: [leaderboardRow({})],
    });
    vi.mocked(benchmarkApi.selectorHarness).mockImplementation(
      async (query) => ({
        workClassId: query.workClassId,
        cases: query.workClassId === "debug" ? 6 : 0,
        policies: [
          { policy: "selector", candidateKey: null, meanReward: 0.5 },
          { policy: "best_fixed", candidateKey: "a", meanReward: 0.75 },
          { policy: "oracle", candidateKey: null, meanReward: 1 },
        ],
        selectorGain: -0.25,
        reason: "",
      }),
    );
  });
  afterEach(cleanup);

  it("lists every class with held-out cases and its selector gain", async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <SelectorHarness />
      </QueryClientProvider>,
    );
    const row = (await screen.findByText("Debugging and bug fixing")).closest(
      "tr",
    ) as HTMLElement;
    const cells = within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    // Class, cases, selector, best fixed, persona (none), oracle, gain.
    expect(cells).toEqual([
      "Debugging and bug fixing",
      "6",
      "500",
      "750",
      "-",
      "1000",
      "-250",
    ]);
    // A class without a held-out case is left out.
    expect(screen.queryByText("Writing")).not.toBeInTheDocument();
  });
});
