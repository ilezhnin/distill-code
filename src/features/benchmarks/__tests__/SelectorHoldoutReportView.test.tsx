import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { SelectorHoldoutReportView } from "../ui/SelectorHoldoutReportView";
import type {
  SelectorHoldoutPlan,
  SelectorHoldoutReport,
} from "../lib/benchmarkLearning";
import { configuration } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: { message: string }) => error.message,
  benchmarkApi: {
    getSelectorHoldoutReport: vi.fn(),
    evaluateSelectorHoldout: vi.fn(),
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const plan: SelectorHoldoutPlan = {
  id: "plan",
  createdAt: 1,
  protocol: "unseen-family-reservation-v2",
  request: {
    requestKey: "key",
    modelId: "fit",
    versionIds: [],
    personaPrior: [configuration.id],
    fallbackKey: configuration.id,
    minQuality: 0.5,
  },
  modelSnapshotHash: "snapshot",
  configurations: [configuration],
  cases: [],
  policies: ["learned"],
  evaluation: {
    recipe: "family-paired-report-v1",
    bootstrapSamples: 2000,
    intervalMass: 0.95,
  },
  dispatchAllowed: false,
  status: "reserved_research_holdout",
};
const report: SelectorHoldoutReport = {
  planId: plan.id,
  planHash: "plan-hash",
  artifactHash: "artifact-hash",
  createdAt: 2,
  groups: 4,
  fallbackCases: 2,
  policies: [
    {
      policy: "learned",
      selectedFixedKey: null,
      quality: 0.7,
      utility: 0.6,
      meanDurationMs: 1200,
      meanCost: null,
      missingCostCases: 8,
      missingDurationCases: 0,
      utilityInterval: { lower: 0.4, upper: 0.8 },
      learnedUtilityGain: 0,
      learnedGainInterval: { lower: 0, upper: 0 },
    },
  ],
  limitations: [],
  status: "research_only",
  dispatchAllowed: false,
};
function show(value = plan) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SelectorHoldoutReportView plan={value} />
    </QueryClientProvider>,
  );
}

it("keeps incomplete evidence visible, retries locally and renders the immutable report", async () => {
  vi.mocked(benchmarkApi.getSelectorHoldoutReport).mockResolvedValue(null);
  vi.mocked(benchmarkApi.evaluateSelectorHoldout)
    .mockRejectedValueOnce({ message: "First cell is incomplete" })
    .mockResolvedValueOnce(report);
  const user = userEvent.setup();
  show();
  const save = screen.getByRole("button", {
    name: "Save report from existing evidence",
  });
  await waitFor(() => expect(save).toBeEnabled());
  expect(benchmarkApi.evaluateSelectorHoldout).not.toHaveBeenCalled();
  await user.click(save);
  expect(await screen.findByText("First cell is incomplete")).toBeVisible();
  await user.click(save);
  expect(await screen.findByText("Unknown (8 tasks)")).toBeVisible();
  expect(screen.getByText("1.20 s")).toBeVisible();
  expect(screen.getByText("0.700")).toBeVisible();
  expect(
    screen.queryByRole("button", {
      name: "Save report from existing evidence",
    }),
  ).not.toBeInTheDocument();
  expect(benchmarkApi.evaluateSelectorHoldout).toHaveBeenNthCalledWith(
    1,
    plan.id,
  );
  expect(benchmarkApi.evaluateSelectorHoldout).toHaveBeenNthCalledWith(
    2,
    plan.id,
  );
});

it("does not retrofit a recipe into an older exposed reservation", async () => {
  vi.mocked(benchmarkApi.getSelectorHoldoutReport).mockResolvedValue(null);
  show({ ...plan, evaluation: null });
  await screen.findByText(/This older reservation did not freeze/);
  expect(
    screen.getByRole("button", { name: "Save report from existing evidence" }),
  ).toBeDisabled();
  expect(benchmarkApi.evaluateSelectorHoldout).not.toHaveBeenCalled();
});
