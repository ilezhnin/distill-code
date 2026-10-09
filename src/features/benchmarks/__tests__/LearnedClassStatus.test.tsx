import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import type { ClassPolicy } from "../lib/benchmarkGovernance";
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
  const status = await screen.findByTestId("learned-class-status");
  expect(status).toHaveAttribute("data-active", "false");
  expect(status).toHaveTextContent(
    /not active yet.*3\/8 training and 1\/8 held-out cases \(1 workflows\), 0 fitted models, 0 comparisons/,
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
  const status = await screen.findByTestId("learned-class-status");
  expect(status).toHaveAttribute("data-active", "true");
  expect(status).toHaveTextContent(/Learned selection is active/);
  expect(status).toHaveTextContent(/used only when it does not choose/);
});

it("reports an unreadable status and stays silent for an unknown class", async () => {
  vi.mocked(api.classPolicies).mockRejectedValueOnce(new Error("offline"));
  show("debug");
  expect(
    await screen.findByText("Learned selection status could not be read."),
  ).toBeVisible();
  cleanup();
  vi.mocked(api.classPolicies).mockResolvedValue([empty]);
  show("writing");
  await vi.waitFor(() => expect(api.classPolicies).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId("learned-class-status")).toBeNull();
});
