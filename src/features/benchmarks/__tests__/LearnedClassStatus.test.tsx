import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import type { ClassPolicy } from "../lib/benchmarkGovernance";
import type { LearnedPreviewSummary } from "../lib/benchmarkLearning";
import { LearnedClassStatus } from "../ui/LearnedClassStatus";

vi.mock("../api/benchmarkGovernance", () => ({
  benchmarkGovernanceApi: { classPolicies: vi.fn() },
}));

const empty: ClassPolicy = {
  workClassId: "debug",
  certificateId: null,
  certifiedAt: null,
  campaignId: null,
  modelId: null,
  qualifiedTraining: 3,
  qualifiedHeldOut: 1,
  heldOutWorkflows: 1,
  fits: 0,
  campaigns: 0,
};

function show(classId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LearnedClassStatus classId={classId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.mocked(api.classPolicies).mockReset());
afterEach(cleanup);

it("says what an uncertified class still needs", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([empty]);
  show("debug");
  const status = await screen.findByText(/No certified task policy yet/);
  expect(status).toHaveAttribute("data-certified", "false");
  expect(status).toHaveTextContent(
    /3 training, 1 held-out; 0 fits, 0 comparisons/,
  );
});

it("says a certified class chooses through its selector", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([
    {
      ...empty,
      certificateId: "certificate-1",
      certifiedAt: Date.UTC(2026, 9, 8),
      campaignId: "campaign-1",
      modelId: "invented-model",
    },
  ]);
  show("debug");
  const status = await screen.findByText(/Certified task policy available/);
  expect(status).toHaveAttribute("data-certified", "true");
  expect(status).toHaveTextContent(/Certified task policy available/);
  expect(status).toHaveTextContent(
    /fallback preferences apply if the policy abstains/,
  );
});

it("reports unreadable status and an absent class policy honestly", async () => {
  vi.mocked(api.classPolicies).mockRejectedValueOnce(new Error("offline"));
  show("debug");
  expect(
    await screen.findByText(/Task policy status could not be read/),
  ).toBeVisible();
  cleanup();
  vi.mocked(api.classPolicies).mockResolvedValue([empty]);
  show("writing");
  await vi.waitFor(() => expect(api.classPolicies).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(/No certified task policy yet/)).toBeVisible();
});

const policyResult = (policy: string, utility: number, key: string | null) => ({
  policy,
  selectedFixedKey: key,
  quality: utility,
  utility,
  meanDurationMs: null,
  meanCost: null,
  missingDurationCases: 0,
  missingCostCases: 0,
  utilityInterval: { lower: utility, upper: utility },
  learnedUtilityGain: 0.71 - utility,
  learnedGainInterval: { lower: -0.04, upper: 0.32 },
});
const preview: LearnedPreviewSummary = {
  modelId: "invented-fit",
  createdAt: Date.UTC(2026, 9, 18),
  status: "retrospective_preview",
  trainingCases: 10,
  heldOutCases: 5,
  groups: 5,
  fallbackCases: 0,
  candidates: [
    {
      candidateKey: "fast",
      providerId: "invented-provider",
      modelId: "fast-model",
      modelName: "Fast Model",
      effort: "low",
      fastMode: null,
      trainingQuality: 0.4,
      learnedCases: 1,
    },
    {
      candidateKey: "deep",
      providerId: "invented-provider",
      modelId: "deep-model",
      modelName: null,
      effort: "xhigh",
      fastMode: null,
      trainingQuality: 0.6,
      learnedCases: 4,
    },
  ],
  learned: policyResult("learned", 0.71, null),
  bestFixed: policyResult("best_fixed", 0.58, "fast"),
  aggregate: policyResult("aggregate", 0.6, null),
};

it("shows a learned preview as research next to the fallback order", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([
    { ...empty, fits: 1, preview },
  ]);
  show("debug");
  const line = await screen.findByTestId("learned-class-preview");
  expect(line).toHaveTextContent(/Learned preview from .+, not certified/);
  expect(line).toHaveTextContent(
    /on 5 held-out cases in 5 groups that were measured earlier/,
  );
  expect(line).toHaveTextContent(/reached utility 0\.71 against 0\.58/);
  expect(line).toHaveTextContent(/best single model \(Fast Model · low\)/);
  expect(line).toHaveTextContent(/a difference of \+0\.13/);
  expect(line).toHaveTextContent(
    /Paired 95% interval of the difference: -0\.04 to \+0\.32/,
  );
  expect(line).toHaveTextContent(/picks deep-model · xhigh on 4 of them/);
  const status = screen.getByTestId("learned-class-status");
  expect(status).toHaveAttribute("data-preview", "true");
  expect(status).toHaveAttribute("data-certified", "false");
  expect(status).toHaveTextContent(/No certified task policy yet/);
});

it("says when a preview found no measured held-out case and hides it once certified", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([
    {
      ...empty,
      preview: {
        ...preview,
        status: "no_held_out_cases",
        heldOutCases: 0,
        learned: null,
        bestFixed: null,
        aggregate: null,
      },
    },
  ]);
  show("debug");
  expect(
    await screen.findByText(/no measured held-out case of this class/),
  ).toBeVisible();
  cleanup();
  vi.mocked(api.classPolicies).mockResolvedValue([
    {
      ...empty,
      certificateId: "certificate-1",
      certifiedAt: Date.UTC(2026, 9, 18),
      campaignId: "campaign-1",
      modelId: "invented-model",
      preview,
    },
  ]);
  show("debug");
  expect(
    await screen.findByText(/Certified task policy available/),
  ).toBeVisible();
  expect(screen.queryByTestId("learned-class-preview")).toBeNull();
});

it("shows no interval for a preview with fewer than four groups", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([
    { ...empty, preview: { ...preview, heldOutCases: 3, groups: 3 } },
  ]);
  show("debug");
  const line = await screen.findByTestId("learned-class-preview");
  expect(line).toHaveTextContent(/in 3 groups/);
  expect(line).toHaveTextContent(
    /Fewer than 4 groups, so no interval is shown/,
  );
  expect(line).not.toHaveTextContent(/95%/);
});
