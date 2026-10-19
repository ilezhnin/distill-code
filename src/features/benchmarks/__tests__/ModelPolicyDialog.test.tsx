import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import type { PromotionState } from "../lib/benchmarkGovernance";
import type { SelectorFitSummary } from "../lib/benchmarkLearning";
import type { WorkflowCampaign } from "../lib/workflowCampaign";
import { ModelPolicyDialog } from "../ui/ModelPolicyDialog";
import { definition } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: Error) => error.message,
  benchmarkApi: {
    listDefinitions: vi.fn(),
    listSelectorFits: vi.fn(),
    listWorkflowCampaigns: vi.fn(),
  },
}));
vi.mock("../api/benchmarkGovernance", () => ({
  benchmarkGovernanceApi: {
    listPromotions: vi.fn(),
    previewLearnedClass: vi.fn(),
    revokePromotion: vi.fn(),
  },
}));
const learning = vi.fn();
const comparison = vi.fn();
vi.mock("../ui/BenchmarkLearningDialog", () => ({
  BenchmarkLearningDialog: (props: { onClose: () => void }) => {
    learning(props);
    return (
      <button type="button" onClick={props.onClose}>
        Back from training
      </button>
    );
  },
}));
vi.mock("../ui/WorkflowCampaignDialog", () => ({
  WorkflowCampaignDialog: (props: { onClose: () => void }) => {
    comparison(props);
    return (
      <button type="button" onClick={props.onClose}>
        Back from comparison
      </button>
    );
  },
}));
const fit: SelectorFitSummary = {
  id: "fit-debug",
  workClassId: "debug",
  createdAt: 1000,
  trainingCases: 24,
  commonCases: 24,
  groups: 8,
  candidates: 3,
  status: "research_only",
  dispatchAllowed: false,
};
const campaign: WorkflowCampaign = {
  plan: {
    id: "comparison-debug",
    createdAt: 2000,
    request: {
      requestKey: "request",
      modelId: fit.id,
      versionIds: [],
      candidates: [],
      personaPriorIds: [],
      minQuality: 0.5,
      repetitions: 3,
      timeoutSeconds: 120,
      maxExecutions: 24,
    },
    modelSnapshotHash: "snapshot",
    cases: [],
    policies: [],
    cells: Array.from({ length: 12 }, () => ({
      caseIndex: 0,
      policyIndex: 0,
      repetition: 0,
    })),
    orderAlgorithm: "test",
    aggregateRecipe: "test",
    evaluation: {
      recipe: "test",
      cellSelection: "test",
      scoreSelection: "test",
      primaryMetric: "utility",
      resampling: "group",
      bootstrapSamples: 2000,
      seed: 1,
      intervalMass: 0.95,
      weights: { quality: 0.85, speed: 0.15, cost: 0 },
    },
  },
  planHash: "plan",
  stateReason: null,
  revision: 1,
  nextCell: 3,
  state: "cancelled",
};
const certificate: PromotionState = {
  revokedAt: null,
  revocationReason: null,
  certificate: {
    id: "certificate-debug",
    createdAt: 3000,
    modelId: fit.id,
    modelSnapshotHash: "snapshot",
    campaignId: campaign.plan.id,
    campaignPlanHash: "plan",
    reportHash: "report",
    ruleHash: "rule",
    artifactHash: "artifact",
    priorKeys: ["prior"],
    minPredictionQuality: 0.5,
    qualifications: [],
    contract: {
      workClassId: "debug",
      roleId: "worker",
      rolePrompt: "",
      permissions: definition.draft.permissions,
      executionProfile: "native_text",
      limits: definition.draft.limits,
      entryPresent: false,
    },
    assessment: {
      rule: {
        recipe: "independent-group-sign-holm-v1",
        alpha: 0.05,
        minimumGroupUtilityGain: 0.01,
        minimumObservedQuality: 0.9,
      },
      groups: 8,
      observedQuality: 0.95,
      comparisons: [],
      passed: true,
      reasons: [],
      limitations: [],
    },
  },
};
const navigate = vi.fn();
function show() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ModelPolicyDialog
        classId="debug"
        onClose={vi.fn()}
        onNavigate={navigate}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([
    {
      ...definition,
      draft: { ...definition.draft, workClassId: "debug" },
      versions: definition.versions.map((v) => ({
        ...v,
        manifest: { ...v.manifest, workClassId: "debug" },
      })),
    },
  ]);
  vi.mocked(benchmarkApi.listSelectorFits).mockResolvedValue([
    fit,
    { ...fit, id: "fit-writing", workClassId: "writing" },
  ]);
  vi.mocked(benchmarkApi.listWorkflowCampaigns).mockResolvedValue([campaign]);
  vi.mocked(api.listPromotions).mockResolvedValue([]);
});
afterEach(cleanup);

it("connects an uncertified category to its actual tasks, fit and comparison without dispatch", async () => {
  const user = userEvent.setup();
  show();
  expect(await screen.findByText(/No issued certificates/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "View comparisons" }));
  expect(await screen.findByText("3 / 12 workflows recorded")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Report and acceptance" }),
  );
  expect(comparison).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialCampaignId: campaign.plan.id,
      initialWorkClassId: "debug",
      showGovernance: true,
    }),
  );
  await user.click(screen.getByText("Back from comparison"));
  await user.click(screen.getByRole("tab", { name: "Training" }));
  expect(screen.getByText(/8 training groups/)).toBeVisible();
  expect(screen.queryByText(/fit-writing/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Inspect" }));
  expect(learning).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialWorkClassId: "debug",
      initialFitId: fit.id,
    }),
  );
  await user.click(screen.getByText("Back from training"));
  await user.click(screen.getByRole("tab", { name: "Tasks" }));
  await user.click(screen.getByRole("button", { name: "Review and qualify" }));
  expect(navigate).toHaveBeenCalledWith({
    section: "development",
    benchmarkId: definition.id,
  });
});

it("lists issued and revoked scoped certificates without treating a fit as a certificate", async () => {
  vi.mocked(api.listPromotions).mockResolvedValue([
    certificate,
    {
      ...certificate,
      revokedAt: 4000,
      revocationReason: "Grader revoked",
      certificate: { ...certificate.certificate, id: "revoked-debug" },
    },
    {
      ...certificate,
      certificate: {
        ...certificate.certificate,
        id: "unrelated-writing",
        contract: {
          ...certificate.certificate.contract,
          workClassId: "writing",
        },
      },
    },
  ]);
  show();
  expect(await screen.findByText("Issued")).toBeVisible();
  expect(screen.getByText("Revoked")).toBeVisible();
  expect(screen.getByText("Grader revoked")).toBeVisible();
  expect(screen.queryByText(/unrelated-writing/)).toBeNull();
  expect(screen.getAllByText(/95% observed quality/)).toHaveLength(2);
  fireEvent.click(
    screen.getAllByRole("button", { name: "Manage certificate" })[0],
  );
  expect(comparison).toHaveBeenCalledWith(
    expect.objectContaining({
      initialCampaignId: campaign.plan.id,
      showGovernance: true,
    }),
  );
});

it("revokes a holdout certificate that no campaign manages", async () => {
  const user = userEvent.setup();
  const holdout: PromotionState = {
    ...certificate,
    certificate: {
      ...certificate.certificate,
      id: "holdout-debug",
      // A holdout plan, not a comparison campaign.
      campaignId: "holdout-plan",
    },
  };
  vi.mocked(api.listPromotions).mockResolvedValue([holdout]);
  vi.mocked(api.revokePromotion).mockResolvedValue({
    ...holdout,
    revokedAt: 5000,
    revocationReason: "Wrong prior",
  });
  show();
  expect(await screen.findByText("Issued")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Manage certificate" }),
  ).toBeDisabled();
  const revoke = screen.getByRole("button", { name: "Revoke promotion" });
  // A reason comes first.
  expect(revoke).toBeDisabled();
  await user.type(
    screen.getByLabelText("Reason for revocation"),
    "Wrong prior",
  );
  await user.click(revoke);
  expect(api.revokePromotion).toHaveBeenCalledWith(
    "holdout-debug",
    "Wrong prior",
  );
  // The registry reads again and shows the revocation.
  await waitFor(() => expect(api.listPromotions).toHaveBeenCalledTimes(2));
});

it("does not describe unreadable certificate evidence as an empty registry", async () => {
  vi.mocked(api.listPromotions).mockRejectedValue(
    new Error("Certificate store unreadable"),
  );
  show();
  expect(await screen.findByText("Certificate store unreadable")).toBeVisible();
  expect(screen.queryByText(/No issued certificates/)).toBeNull();
});

it("previews the learned choice of the category from its own training cells only", async () => {
  const user = userEvent.setup();
  vi.mocked(api.previewLearnedClass).mockResolvedValue({
    modelId: "fit-preview",
    workClassId: "debug",
    createdAt: 3000,
    recipe: "retrospective-exposed-holdout-preview-v1",
    runtimeMatch: "model_identity",
    trainingCases: 10,
    trainingGroups: 10,
    excludedProviders: ["kimi-acp", "zai-acp"],
    candidates: [],
    cases: Array.from({ length: 5 }, (_, index) => ({
      versionId: `held-${index}`,
      group: `group-${index}`,
      learnedKey: "a",
      aggregateKey: "a",
      usedFallback: false,
    })),
    groups: 5,
    fallbackCases: 0,
    policies: [],
    limitations: [],
    status: "retrospective_preview",
    dispatchAllowed: false,
    artifactHash: "hash",
  });
  show();
  await user.click(await screen.findByRole("tab", { name: "Training" }));
  await user.click(
    screen.getByRole("button", { name: "Preview learned choice" }),
  );
  expect(api.previewLearnedClass).toHaveBeenCalledWith({
    workClassId: "debug",
  });
  expect(
    await screen.findByText(/Preview saved: 5 held-out cases compared/),
  ).toBeVisible();
  expect(screen.getByText(/makes no model calls/)).toBeVisible();
});

it("shows why a preview could not fit the category", async () => {
  const user = userEvent.setup();
  vi.mocked(api.previewLearnedClass).mockRejectedValue(
    new Error("Fewer than two candidates share eight complete training cases"),
  );
  show();
  await user.click(await screen.findByRole("tab", { name: "Training" }));
  await user.click(
    screen.getByRole("button", { name: "Preview learned choice" }),
  );
  expect(
    await screen.findByText(/Fewer than two candidates share eight/),
  ).toBeVisible();
});
