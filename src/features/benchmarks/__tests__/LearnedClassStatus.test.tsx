import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import type { ClassPolicy } from "../lib/benchmarkGovernance";
import type { ClassEvaluationSummary } from "../lib/benchmarkLearning";
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

const evaluation: ClassEvaluationSummary = {
  id: "invented-evaluation",
  modelId: "invented-fit",
  createdAt: Date.UTC(2026, 9, 19),
  status: "not_certified",
  look: 3,
  trainingCases: 10,
  heldOutCases: 21,
  groups: 21,
  observedQuality: 0.62,
  reasons: ["not_superior_to_every_registered_baseline"],
  certificateId: null,
};

it("shows the newest held-out evaluation next to the fallback order", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([
    { ...empty, fits: 1, evaluation },
  ]);
  show("debug");
  const line = await screen.findByTestId("learned-class-preview");
  expect(line).toHaveTextContent(
    /Held-out evaluation 3 of 3 from .+, not certified/,
  );
  expect(line).toHaveTextContent(/on 21 held-out cases in 21 groups/);
  expect(line).toHaveTextContent(/reached 62% quality/);
  expect(line).toHaveTextContent(/did not clearly beat the fallback order/);
  expect(line).toHaveTextContent(/Fitted on 10 training cases/);
  const status = screen.getByTestId("learned-class-status");
  expect(status).toHaveAttribute("data-preview", "true");
  expect(status).toHaveAttribute("data-certified", "false");
  expect(status).toHaveTextContent(/No certified task policy yet/);
});

it("shows the newest evaluation whether it found no case or certified the class", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([
    {
      ...empty,
      evaluation: {
        ...evaluation,
        status: "insufficient_evidence",
        heldOutCases: 0,
        groups: 0,
        observedQuality: null,
        reasons: [],
      },
    },
  ]);
  show("debug");
  expect(
    await screen.findByText(/no qualified held-out case of this class/),
  ).toBeVisible();
  cleanup();
  vi.mocked(api.classPolicies).mockResolvedValue([
    {
      ...empty,
      certificateId: "certificate-1",
      certifiedAt: Date.UTC(2026, 9, 19),
      campaignId: "evaluation-1",
      modelId: "invented-model",
      evaluation: { ...evaluation, status: "certified", reasons: [] },
    },
  ]);
  show("debug");
  expect(
    await screen.findByText(/Certified task policy available/),
  ).toBeVisible();
  expect(screen.getByTestId("learned-class-preview")).toHaveTextContent(
    /Held-out evaluation 3 of 3 from .+ certified this class: on 21 held-out cases/,
  );
});
