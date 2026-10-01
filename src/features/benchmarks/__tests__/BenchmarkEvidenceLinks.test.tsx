import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BenchmarkEvidenceLinks } from "../ui/BenchmarkEvidenceLinks";
import { LeaderboardView } from "../ui/LeaderboardView";
import { NerfBenchView } from "../ui/NerfBenchView";
import { configuration } from "./fixtures";

describe("bounded benchmark evidence links", () => {
  afterEach(cleanup);

  it("makes every attempt reachable without mounting more than five evidence buttons", async () => {
    const onEvidence = vi.fn();
    const ids = Array.from(
      { length: 12 },
      (_, index) => `attempt-${index + 1}`,
    );
    const view = render(
      <BenchmarkEvidenceLinks attemptIds={ids} onEvidence={onEvidence} />,
    );
    expect(screen.getByText("1–5 of 12 attempts")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    for (const id of ["1", "5"])
      await userEvent.click(screen.getByRole("button", { name: id }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("6–10 of 12 attempts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "10" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("11–12 of 12 attempts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "12" }));
    expect(onEvidence.mock.calls.map(([id]) => id)).toEqual([
      "attempt-1",
      "attempt-5",
      "attempt-10",
      "attempt-12",
    ]);
    view.rerender(
      <BenchmarkEvidenceLinks attemptIds={[...ids]} onEvidence={onEvidence} />,
    );
    expect(screen.getByText("11–12 of 12 attempts")).toBeInTheDocument();
    view.rerender(
      <BenchmarkEvidenceLinks
        attemptIds={["filtered-attempt"]}
        onEvidence={onEvidence}
      />,
    );
    expect(screen.getByText("1–1 of 1 attempts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1" }));
    expect(onEvidence).toHaveBeenLastCalledWith("filtered-attempt");
  });

  it("bounds a large leaderboard row and resets its page after filtering it out", async () => {
    render(
      <LeaderboardView
        rows={[
          {
            configuration,
            passed: 2000,
            attempted: 2000,
            planned: 2000,
            quality: 1,
            medianDurationMs: 9,
            cost: null,
            status: "comparable",
            reason: "Synthetic",
            attemptIds: Array.from({ length: 2000 }, (_, i) => `attempt-${i}`),
          },
        ]}
        onEvidence={vi.fn()}
      />,
    );
    const row = screen.getByRole("row", { name: /model-1/ });
    expect(within(row).getAllByRole("button")).toHaveLength(7);
    await userEvent.click(within(row).getByRole("button", { name: "Next" }));
    expect(within(row).getByText("6–10 of 2000 attempts")).toBeInTheDocument();
    const search = screen.getByRole("textbox", { name: "Model" });
    await userEvent.type(search, "absent");
    expect(
      screen.queryByRole("row", { name: /model-1/ }),
    ).not.toBeInTheDocument();
    await userEvent.clear(search);
    expect(screen.getByText("1–5 of 2000 attempts")).toBeInTheDocument();
  });

  it("bounds Nerf evidence with the same complete navigation", async () => {
    const onEvidence = vi.fn();
    render(
      <NerfBenchView
        comparisons={[
          {
            baselineId: "baseline",
            configurationId: "model-1",
            qualityChange: null,
            retainedQualityPercent: null,
            intervalLow: null,
            intervalHigh: null,
            status: "preliminary",
            reason: "Synthetic",
            attemptIds: Array.from({ length: 2000 }, (_, i) => `attempt-${i}`),
            durationChangePercent: null,
            tokenChangePercent: null,
            method: "paired",
          },
        ]}
        onEvidence={onEvidence}
      />,
    );
    const row = screen.getByRole("row", { name: /model-1/ });
    expect(within(row).getAllByRole("button")).toHaveLength(7);
    await userEvent.click(within(row).getByRole("button", { name: "Next" }));
    await userEvent.click(within(row).getByRole("button", { name: "6" }));
    expect(onEvidence).toHaveBeenCalledWith("attempt-5");
  });
});
