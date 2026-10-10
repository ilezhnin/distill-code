import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import { workerLayerRoleIds } from "@/features/conductor/roleLayers";
import {
  type DeploymentContract,
  type PromotionRegistration,
  type PromotionState,
  type QualificationBinding,
  type QualificationRecord,
  type QualificationRequest,
  type RegisteredPromotionRule,
  rolesWavesCannotName,
} from "../lib/benchmarkGovernance";
import type { WorkflowCampaign } from "../lib/workflowCampaign";
import { BenchmarkQualificationPanel } from "../ui/BenchmarkQualificationPanel";
import { WorkflowPromotionPanel } from "../ui/WorkflowPromotionPanel";
import { definition } from "./fixtures";

vi.mock("../api/benchmarkGovernance", () => ({
  benchmarkGovernanceApi: {
    qualifyVersion: vi.fn(),
    getQualification: vi.fn(),
    qualificationBindings: vi.fn(),
    revokeQualification: vi.fn(),
    registerPromotionRule: vi.fn(),
    campaignDeployment: vi.fn(),
    getPromotionRule: vi.fn(),
    promoteSelector: vi.fn(),
    listPromotions: vi.fn(),
    revokePromotion: vi.fn(),
  },
}));

const version = {
  ...definition.versions[0],
  manifest: {
    ...definition.draft,
    executionProfile: "native_text",
    permissions: { tools: [], network: false, context: "clean" },
    limits: { timeoutSeconds: 120, maxTurns: 1, maxArtifactBytes: 1024 },
  },
};
const controls: QualificationRequest["controls"] = [
  {
    id: "positive-a",
    output: "4",
    expected: "pass",
    rationale: "First accepted mechanism",
  },
  {
    id: "positive-b",
    output: " 4",
    expected: "pass",
    rationale: "Independently reviewed alternative",
  },
  { id: "negative-a", output: "5", expected: "fail", rationale: "Wrong value" },
  {
    id: "negative-b",
    output: "",
    expected: "fail",
    rationale: "Missing result",
  },
];
const requirements = [
  {
    id: "value",
    statement: "Correct result",
    positiveControls: ["positive-a", "positive-b"],
    negativeControls: ["negative-a", "negative-b"],
  },
];
const binding: QualificationBinding = {
  id: "qualification",
  versionId: version.id,
  contentHash: version.contentHash,
  manifestHash: "manifest",
  evaluatorRevision: "1",
  createdAt: 1,
  recordHash: "record",
  status: "failed",
  revokedAt: null,
  revocationReason: null,
};
const request: QualificationRequest = {
  requestKey: "qualification-request",
  versionId: version.id,
  contentHash: version.contentHash,
  evaluatorRevision: "1",
  reviewer: "Fixture operator",
  contractReview: "Coverage reviewed",
  alternativeReview: "Mechanisms reviewed",
  familyReview: "Independent family reviewed",
  exposureReview: "No exposure reviewed",
  requirements,
  controls,
};
const record: QualificationRecord = {
  id: binding.id,
  createdAt: 1,
  request,
  manifestHash: "manifest",
  status: "failed",
  finishedAt: 2,
  controls: [
    {
      controlId: "positive-a",
      outputHash: "output",
      evaluation: null,
      error: "Grader interrupted",
    },
  ],
  failure: "First control did not complete",
  limitations: ["Independent review remains an operator attestation."],
};
const campaign: WorkflowCampaign = {
  plan: {
    id: "campaign",
    createdAt: 3,
    request: {
      requestKey: "comparison",
      modelId: "fit",
      versionIds: [version.id],
      candidates: [],
      personaPriorIds: [],
      minQuality: 0.6,
      repetitions: 3,
      timeoutSeconds: 120,
      maxExecutions: 30,
    },
    modelSnapshotHash: "snapshot",
    cases: [
      {
        versionId: version.id,
        contentHash: version.contentHash,
        manifestHash: "manifest",
        family: "family",
        group: "group",
        evaluatorRevision: "1",
        steps: 2,
      },
    ],
    policies: [],
    cells: [],
    orderAlgorithm: "fixture",
    aggregateRecipe: "fixture",
    evaluation: {
      recipe: "fixture",
      cellSelection: "first",
      scoreSelection: "first",
      primaryMetric: "utility",
      resampling: "group",
      bootstrapSamples: 2000,
      seed: 1,
      intervalMass: 0.95,
      weights: { quality: 0.8, speed: 0.15, cost: 0.05 },
    },
  },
  planHash: "plan",
  state: "reserved",
  stateReason: null,
  nextCell: 0,
  revision: 1,
};
// The native projection of what the frozen campaign evaluated.
const contract: DeploymentContract = {
  workClassId: version.manifest.workClassId,
  roleId: version.manifest.roleId,
  rolePrompt: version.manifest.rolePrompt,
  permissions: version.manifest.permissions,
  executionProfile: "native_text",
  limits: version.manifest.limits,
  entryPresent: true,
  budgetRecipe: "native-root-wall-budget-v1",
};
const registration: PromotionRegistration = {
  requestKey: "rule-request",
  campaignId: "campaign",
  operator: "Fixture operator",
  rule: {
    recipe: "independent-group-sign-holm-v1",
    alpha: 0.01,
    minimumGroupUtilityGain: 0.1,
    minimumObservedQuality: 0.8,
  },
  contract,
  qualificationIds: ["qualification"],
};
const registered: RegisteredPromotionRule = {
  request: registration,
  createdAt: 4,
  planHash: "plan",
  qualificationHashes: ["record"],
  artifactHash: "rule-hash",
};
const state: PromotionState = {
  certificate: {
    id: "certificate",
    createdAt: 8,
    modelId: "fit",
    modelSnapshotHash: "snapshot",
    campaignId: "campaign",
    campaignPlanHash: "plan",
    reportHash: "report",
    ruleHash: "rule-hash",
    contract: registration.contract,
    assessment: {
      rule: registration.rule,
      groups: 8,
      observedQuality: 0.9,
      comparisons: [],
      passed: true,
      reasons: [],
      limitations: ["Independent-group assumptions remain reviewed."],
    },
    qualifications: [
      { ...binding, status: "controls_verified_review_attested" },
    ],
    priorKeys: ["worker:prior"],
    minPredictionQuality: 0.6,
    artifactHash: "certificate-hash",
  },
  revokedAt: null,
  revocationReason: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.qualificationBindings).mockResolvedValue([]);
  vi.mocked(api.getPromotionRule).mockResolvedValue(null);
  vi.mocked(api.listPromotions).mockResolvedValue([]);
  vi.mocked(api.campaignDeployment).mockResolvedValue({
    contract,
    trajectory: null,
  });
});
afterEach(cleanup);
function show(
  content: React.ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>{content}</QueryClientProvider>,
  );
}
function fill(name: string, value: string) {
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
}
async function fillQualification() {
  const user = userEvent.setup();
  await user.click(
    screen.getByText("Grader qualification", { selector: "summary" }),
  );
  await screen.findByLabelText("Reviewing operator");
  fill("Reviewing operator", "Fixture operator");
  for (const label of [
    "Requirement coverage review",
    "Independent alternatives and mechanisms review",
    "Family and group independence review",
    "Prior exposure and source exclusions review",
  ])
    fill(label, "Fixture review attestation");
  fill("Requirement-to-control map (JSON)", JSON.stringify(requirements));
  fill("Alternative and negative controls (JSON)", JSON.stringify(controls));
  return user;
}
async function fillRule() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByText("Preregister deployment rule before starting", {
      selector: "summary",
    }),
  );
  fill("Approving operator", "Fixture operator");
  fill("Family-wise error budget (0–0.05, exclusive zero)", "0.01");
  fill("Minimum group utility gain (0–1, exclusive one)", "0.1");
  fill("Minimum observed quality (0–1)", "0.8");
  fill("Exact qualification record IDs", "qualification, second-qualification");
  return user;
}

it("requires attributable reviews and sends the exact published contract only on explicit qualification", async () => {
  show(<BenchmarkQualificationPanel version={version} />);
  const user = userEvent.setup();
  await user.click(
    screen.getByText("Grader qualification", { selector: "summary" }),
  );
  expect(
    await screen.findByRole("button", {
      name: "Reserve and evaluate first controls",
    }),
  ).toBeDisabled();
  expect(api.qualifyVersion).not.toHaveBeenCalled();
  await user.click(
    screen.getByText("Grader qualification", { selector: "summary" }),
  );
  await fillQualification();
  vi.mocked(api.qualifyVersion).mockResolvedValue(record);
  await user.click(
    screen.getByRole("button", { name: "Reserve and evaluate first controls" }),
  );
  await waitFor(() => expect(api.qualifyVersion).toHaveBeenCalledOnce());
  expect(api.qualifyVersion).toHaveBeenCalledWith(
    expect.objectContaining({
      versionId: version.id,
      contentHash: version.contentHash,
      evaluatorRevision: "1",
      reviewer: "Fixture operator",
      requirements,
      controls,
    }),
  );
});

it("registers rubric score bands and displays the exact maximum judge calls before dispatch", async () => {
  const rubricVersion = {
    ...version,
    manifest: {
      ...version.manifest,
      evaluator: { ...version.manifest.evaluator, kind: "rubric" },
      environment: {
        judgePanel: { recipe: "frozen-native-panel-v1", judges: [{}, {}, {}] },
      },
    },
  };
  show(<BenchmarkQualificationPanel version={rubricVersion} />);
  const user = await fillQualification();
  expect(screen.getByText(/Up to 12 judge calls/)).toBeInTheDocument();
  expect(api.qualifyVersion).not.toHaveBeenCalled();
  fill("Minimum accepted control score", "0.85");
  fill("Maximum rejected control score", "0.15");
  vi.mocked(api.qualifyVersion).mockResolvedValue({
    ...record,
    status: "reserved",
    finishedAt: null,
  });
  await user.click(
    screen.getByRole("button", { name: "Reserve and evaluate first controls" }),
  );
  await waitFor(() => expect(api.qualifyVersion).toHaveBeenCalledOnce());
  expect(api.qualifyVersion).toHaveBeenCalledWith(
    expect.objectContaining({
      rubric: {
        minimumAcceptedScore: 0.85,
        maximumRejectedScore: 0.15,
        maxJudgeCalls: 12,
      },
      versionId: version.id,
      controls,
    }),
  );
});

it("retains the first panel identity after an unreadable reply and prohibits editing when native lookup fails", async () => {
  show(<BenchmarkQualificationPanel version={version} />);
  const user = await fillQualification();
  vi.mocked(api.qualifyVersion).mockRejectedValue({
    message: "Qualification reply unavailable",
  });
  vi.mocked(api.qualificationBindings).mockRejectedValue({
    message: "Qualification lookup unavailable",
  });
  await user.click(
    screen.getByRole("button", { name: "Reserve and evaluate first controls" }),
  );
  await screen.findByText("Qualification reply unavailable");
  expect(screen.getByLabelText("Reviewing operator")).toBeDisabled();
  expect(
    screen.queryByRole("button", {
      name: "Change inputs after confirmed refusal",
    }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", {
      name: "Retry the same qualification request",
    }),
  );
  await waitFor(() => expect(api.qualifyVersion).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.qualifyVersion).mock.calls[0][0]).toEqual(
    vi.mocked(api.qualifyVersion).mock.calls[1][0],
  );
});

it("inspects failed and unrecorded first controls, then revokes with an explicit reason", async () => {
  let saved = binding;
  vi.mocked(api.qualificationBindings).mockImplementation(async () => [saved]);
  vi.mocked(api.getQualification).mockResolvedValue(record);
  vi.mocked(api.revokeQualification).mockImplementation(async (_, reason) => {
    saved = { ...binding, revokedAt: 10, revocationReason: reason };
  });
  show(<BenchmarkQualificationPanel version={version} />);
  const user = userEvent.setup();
  await user.click(
    screen.getByText("Grader qualification", { selector: "summary" }),
  );
  expect(
    await screen.findByText("Grader interrupted", {
      exact: false,
      selector: "li",
    }),
  ).toBeVisible();
  expect(
    screen.getAllByText("No first result recorded", {
      exact: false,
      selector: "li",
    }),
  ).toHaveLength(3);
  expect(screen.queryByLabelText("Reviewing operator")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Revoke qualification" }),
  ).toBeDisabled();
  fill("Reason for revocation", "Independence review withdrawn");
  await user.click(
    screen.getByRole("button", { name: "Revoke qualification" }),
  );
  expect(await screen.findByText(/Qualification revoked/)).toBeVisible();
  expect(api.revokeQualification).toHaveBeenCalledWith(
    "qualification",
    "Independence review withdrawn",
  );
  expect(api.qualifyVersion).not.toHaveBeenCalled();
});

it("never defaults to approval and freezes explicit rule, exact scope and qualification IDs before campaign start", async () => {
  let saved: RegisteredPromotionRule | null = null;
  vi.mocked(api.getPromotionRule).mockImplementation(async () => saved);
  vi.mocked(api.registerPromotionRule).mockImplementation(async (request) => {
    saved = { ...registered, request };
    return saved;
  });
  const pending = vi.fn();
  show(
    <WorkflowPromotionPanel campaign={campaign} onPendingChange={pending} />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByText("Preregister deployment rule before starting", {
      selector: "summary",
    }),
  );
  expect(
    screen.getByRole("button", { name: "Approve and freeze deployment rule" }),
  ).toBeDisabled();
  expect(api.registerPromotionRule).not.toHaveBeenCalled();
  await user.click(
    screen.getByText("Preregister deployment rule before starting", {
      selector: "summary",
    }),
  );
  await fillRule();
  await user.click(
    screen.getByRole("button", { name: "Approve and freeze deployment rule" }),
  );
  expect(
    await screen.findByText("Deployment rule registered before execution"),
  ).toBeVisible();
  expect(api.registerPromotionRule).toHaveBeenCalledWith({
    ...registration,
    requestKey: expect.any(String),
    qualificationIds: ["qualification", "second-qualification"],
  });
  expect(pending).toHaveBeenCalledWith(true);
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(api.promoteSelector).not.toHaveBeenCalled();
});

it("keeps campaign start blocked while registration cannot be reconciled and retries identical inputs", async () => {
  const pending = vi.fn();
  show(
    <WorkflowPromotionPanel campaign={campaign} onPendingChange={pending} />,
  );
  const user = await fillRule();
  vi.mocked(api.registerPromotionRule).mockRejectedValue({
    message: "Rule reply unavailable",
  });
  vi.mocked(api.getPromotionRule).mockRejectedValue({
    message: "Rule lookup unavailable",
  });
  await user.click(
    screen.getByRole("button", { name: "Approve and freeze deployment rule" }),
  );
  await screen.findByText("Rule lookup unavailable");
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(screen.getByLabelText("Approving operator")).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Retry the same rule registration" }),
  );
  await waitFor(() =>
    expect(api.registerPromotionRule).toHaveBeenCalledTimes(2),
  );
  expect(vi.mocked(api.registerPromotionRule).mock.calls[0][0]).toEqual(
    vi.mocked(api.registerPromotionRule).mock.calls[1][0],
  );
});

it("cannot approve an already started research campaign", async () => {
  show(
    <WorkflowPromotionPanel
      campaign={{ ...campaign, state: "paused", nextCell: 1 }}
      onPendingChange={vi.fn()}
    />,
  );
  expect(await screen.findByText(/remains research only/)).toBeVisible();
  expect(
    screen.queryByRole("button", {
      name: "Approve and freeze deployment rule",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: "Validate evidence and activate promotion",
    }),
  ).not.toBeInTheDocument();
  expect(api.registerPromotionRule).not.toHaveBeenCalled();
});

it.each([
  "requestKey",
  "campaignId",
  "planHash",
  "rule",
  "contract",
  "qualificationIds",
  "absent",
])("retains its owner and reachable identical retry after a background rule recovery mismatches %s", async (mismatch) => {
  const pending = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  show(
    <WorkflowPromotionPanel campaign={campaign} onPendingChange={pending} />,
    client,
  );
  const user = await fillRule();
  vi.mocked(api.registerPromotionRule).mockRejectedValue({
    message: "Rule reply unavailable",
  });
  vi.mocked(api.getPromotionRule).mockRejectedValue({
    message: "Rule lookup unavailable",
  });
  await user.click(
    screen.getByRole("button", { name: "Approve and freeze deployment rule" }),
  );
  await screen.findByText("Rule lookup unavailable");
  const frozen = vi.mocked(api.registerPromotionRule).mock.calls[0][0];
  const recovered: RegisteredPromotionRule = {
    ...registered,
    request: structuredClone(frozen),
  };
  if (mismatch === "requestKey")
    recovered.request.requestKey = "unrelated-request";
  if (mismatch === "campaignId")
    recovered.request.campaignId = "unrelated-campaign";
  if (mismatch === "planHash") recovered.planHash = "unrelated-plan";
  if (mismatch === "rule") recovered.request.rule.alpha = 0.02;
  if (mismatch === "contract")
    recovered.request.contract.rolePrompt = "Unrelated role";
  if (mismatch === "qualificationIds")
    recovered.request.qualificationIds = ["unrelated-qualification"];
  vi.mocked(api.getPromotionRule).mockResolvedValue(
    mismatch === "absent" ? null : recovered,
  );
  await act(async () => {
    await client.refetchQueries({
      queryKey: ["benchmarks", "promotion-rule", "campaign"],
    });
  });
  if (mismatch !== "absent")
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Approving operator"),
      ).not.toBeInTheDocument(),
    );
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(
    screen.queryByText("Deployment rule registered before execution"),
  ).not.toBeInTheDocument();
  const retry = screen.getByRole("button", {
    name: "Retry the same rule registration",
  });
  expect(retry).toBeEnabled();
  vi.mocked(api.getPromotionRule).mockResolvedValue({
    ...registered,
    request: frozen,
  });
  await user.click(retry);
  await waitFor(() =>
    expect(api.registerPromotionRule).toHaveBeenCalledTimes(2),
  );
  await waitFor(() =>
    expect(
      client.getQueryData(["benchmarks", "promotion-rule", "campaign"]),
    ).toEqual({ ...registered, request: frozen }),
  );
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  expect(vi.mocked(api.registerPromotionRule).mock.calls[1][0]).toEqual(frozen);
});

it("refuses a rule operation when a sibling already owns admission even before disabled props update", async () => {
  const pending = vi.fn(() => false);
  show(
    <WorkflowPromotionPanel campaign={campaign} onPendingChange={pending} />,
  );
  const user = await fillRule();
  await user.click(
    screen.getByRole("button", { name: "Approve and freeze deployment rule" }),
  );
  expect(pending).toHaveBeenCalledWith(true);
  expect(api.registerPromotionRule).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Approving operator")).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Retry the same rule registration" }),
  ).not.toBeInTheDocument();
});

it("activates only a completed preregistered report and exposes certificate fallback, limits and revocation", async () => {
  let saved: PromotionState[] = [];
  vi.mocked(api.getPromotionRule).mockResolvedValue(registered);
  vi.mocked(api.listPromotions).mockImplementation(async () => saved);
  vi.mocked(api.promoteSelector).mockImplementation(async () => {
    saved = [state];
    return state;
  });
  vi.mocked(api.revokePromotion).mockImplementation(async (_, reason) => {
    const revoked = { ...state, revokedAt: 10, revocationReason: reason };
    saved = [revoked];
    return revoked;
  });
  show(
    <WorkflowPromotionPanel
      campaign={{ ...campaign, state: "completed" }}
      onPendingChange={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  const activate = await screen.findByRole("button", {
    name: "Validate evidence and activate promotion",
  });
  expect(api.promoteSelector).not.toHaveBeenCalled();
  await user.click(activate);
  expect(await screen.findByText("Promotion certificate issued")).toBeVisible();
  expect(
    screen.getByText(/worker:prior.*minimum predicted quality: 0.6/),
  ).toBeVisible();
  await user.click(
    screen.getByText("Certificate evidence, assessment, scope and limits", {
      selector: "summary",
    }),
  );
  expect(
    screen.getByText(/certificate-hash/, { selector: "pre" }),
  ).toHaveTextContent('"timeoutSeconds": 120');
  expect(
    screen.getByRole("button", { name: "Revoke promotion" }),
  ).toBeDisabled();
  fill("Reason for revocation", "Runtime review withdrawn");
  await user.click(screen.getByRole("button", { name: "Revoke promotion" }));
  expect(await screen.findByText("Promotion revoked")).toBeVisible();
  expect(api.promoteSelector).toHaveBeenCalledWith("campaign");
  expect(api.revokePromotion).toHaveBeenCalledWith(
    "certificate",
    "Runtime review withdrawn",
  );
  expect(
    screen.queryByRole("button", {
      name: "Validate evidence and activate promotion",
    }),
  ).not.toBeInTheDocument();
});

it("registers and shows the exact native trajectory a mixed-role campaign evaluated", async () => {
  const review: DeploymentContract = {
    ...contract,
    workClassId: "code-review",
    roleId: "invented-reviewer",
    rolePrompt: "Review carefully.",
    limits: { ...contract.limits, timeoutSeconds: 60 },
  };
  const trajectory = { rootBudgetSeconds: 120, steps: [contract, review] };
  vi.mocked(api.campaignDeployment).mockResolvedValue({
    contract,
    trajectory,
  });
  let saved: RegisteredPromotionRule | null = null;
  vi.mocked(api.getPromotionRule).mockImplementation(async () => saved);
  vi.mocked(api.registerPromotionRule).mockImplementation(async (request) => {
    saved = { ...registered, request };
    return saved;
  });
  show(
    <WorkflowPromotionPanel campaign={campaign} onPendingChange={vi.fn()} />,
  );
  const user = await fillRule();
  expect(
    await screen.findByText(/exact 2-step trajectory with a 120 s root budget/),
  ).toBeVisible();
  expect(
    screen.getByText(/Conductor waves can name only their worker roles/),
  ).toHaveTextContent("invented-reviewer");
  await user.click(
    screen.getByRole("button", { name: "Approve and freeze deployment rule" }),
  );
  expect(
    await screen.findByText("Deployment rule registered before execution"),
  ).toBeVisible();
  expect(api.campaignDeployment).toHaveBeenCalledWith("campaign");
  expect(api.registerPromotionRule).toHaveBeenCalledWith({
    ...registration,
    requestKey: expect.any(String),
    qualificationIds: ["qualification", "second-qualification"],
    trajectory,
  });
});

it("says a trajectory certificate covers only its exact step sequence", async () => {
  const certified: PromotionState = {
    ...state,
    certificate: {
      ...state.certificate,
      trajectory: {
        rootBudgetSeconds: 120,
        steps: [
          { contract, modelId: "fit", modelSnapshotHash: "snapshot" },
          {
            contract: { ...contract, workClassId: "code-review" },
            modelId: "review-fit",
            modelSnapshotHash: "review-snapshot",
          },
        ],
      },
    },
  };
  vi.mocked(api.getPromotionRule).mockResolvedValue(registered);
  vi.mocked(api.listPromotions).mockResolvedValue([certified]);
  show(
    <WorkflowPromotionPanel
      campaign={{ ...campaign, state: "completed" }}
      onPendingChange={vi.fn()}
    />,
  );
  expect(
    await screen.findByText(/covers only its exact 2-step trajectory/),
  ).toBeVisible();
});

it("names only the step roles a conductor wave cannot use", () => {
  const worker = workerLayerRoleIds()[0];
  expect(
    rolesWavesCannotName([worker, null, "invented-role", "invented-role"]),
  ).toEqual(["invented-role"]);
});
