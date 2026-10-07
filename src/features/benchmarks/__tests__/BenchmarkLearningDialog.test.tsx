import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { BenchmarkLearningDialog } from "../ui/BenchmarkLearningDialog";
import type { LeaderboardReport } from "../types";
import { configuration, definition } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: { message?: string }) =>
    error.message ?? String(error),
  benchmarkApi: {
    listSelectorFits: vi.fn(async () => []),
    getLeaderboard: vi.fn(),
    fitSelector: vi.fn(),
    getSelectorFit: vi.fn(),
    predictSelector: vi.fn(),
  },
}));
afterEach(cleanup);

it("requires explicit selection and displays a rejected fit without creating a saved result", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  const user = userEvent.setup();
  const versions = Array.from({ length: 8 }, (_, index) => ({
    ...definition.versions[0],
    id: `version-${index}`,
    manifest: { ...definition.draft, name: `Training case ${index}` },
  }));
  const other = { ...configuration, id: "second", modelId: "model-2" };
  // Only these row fields are read by the candidate picker.
  vi.mocked(benchmarkApi.getLeaderboard).mockResolvedValue({
    cohort: null,
    rows: [configuration, other].map((configuration) => ({ configuration })),
  } as LeaderboardReport);
  vi.mocked(benchmarkApi.fitSelector).mockRejectedValue({
    message: "A training cell is incomplete",
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkLearningDialog versions={versions} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  const fit = screen.getByRole("button", { name: "Fit from saved results" });
  expect(fit).toBeDisabled();
  for (let index = 0; index < 8; index++)
    await user.click(
      screen.getByRole("checkbox", { name: `Training case ${index}` }),
    );
  await user.click(
    await screen.findByRole("checkbox", {
      name: "claude-acp / model-1 / high",
    }),
  );
  expect(fit).toBeDisabled();
  await user.click(
    screen.getByRole("checkbox", { name: "claude-acp / model-2 / high" }),
  );
  expect(fit).toBeEnabled();
  await user.click(fit);
  await waitFor(() =>
    expect(screen.getByText("A training cell is incomplete")).toBeVisible(),
  );
  expect(benchmarkApi.fitSelector).toHaveBeenCalledWith(
    expect.objectContaining({
      versionIds: versions.map((v) => v.id),
      configurations: [configuration, other],
    }),
  );
  expect(benchmarkApi.getSelectorFit).not.toHaveBeenCalled();
  expect(benchmarkApi.predictSelector).not.toHaveBeenCalled();
});
