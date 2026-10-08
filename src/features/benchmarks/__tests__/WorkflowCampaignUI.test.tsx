import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listProviderAccounts } from "@/features/providers/api/providerAccounts";
import { benchmarkApi } from "../api/benchmarks";
import type { SelectorFitArtifact } from "../lib/benchmarkLearning";
import type {
  WorkflowCampaign,
  WorkflowCampaignReport,
} from "../lib/workflowCampaign";
import { WorkflowCampaignDialog } from "../ui/WorkflowCampaignDialog";
import { WorkflowCampaignForm } from "../ui/WorkflowCampaignForm";
import { configuration, definition } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) =>
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error),
  benchmarkApi: {
    listSelectorFits: vi.fn(),
    getSelectorFit: vi.fn(),
    listWorkflowCampaigns: vi.fn(),
    freezeWorkflowCampaign: vi.fn(),
    controlWorkflowCampaign: vi.fn(),
    workflowCampaignReport: vi.fn(),
    getCapabilities: vi.fn(),
  },
}));
vi.mock("@/features/providers/api/providerAccounts", () => ({
  listProviderAccounts: vi.fn(),
}));

const workers = [
  { ...configuration, accountId: null },
  {
    ...configuration,
    id: "config-2",
    providerId: "codex-acp",
    modelId: "model-2",
    accountId: null,
  },
];
const artifact: SelectorFitArtifact = {
  createdAt: 1,
  model: {
    id: "fit",
    recipe: "test",
    featureVersion: "test",
    cutoffAt: 1,
    snapshotHash: "snapshot",
    workClassId: definition.draft.workClassId,
    trainingCases: 8,
    commonCases: 8,
    trainingFamilies: ["training"],
    trainingGroups: ["training-group"],
    candidates: workers.map((configuration) => ({
      candidateKey: configuration.id,
      configuration,
      cases: 8,
      qualityCoefficients: [],
      utilityCoefficients: [],
    })),
  },
  snapshot: {
    request: {
      workClassId: definition.draft.workClassId,
      versionIds: [],
      configurations: [],
      cutoffAt: 1,
      weights: { quality: 0.8, speed: 0.15, cost: 0.05 },
    },
    examples: [],
  },
};
const versions = Array.from({ length: 8 }, (_, index) => ({
  ...definition.versions[0],
  id: `held-${index}`,
  definitionId: `definition-${index}`,
  manifest: {
    ...definition.draft,
    name: `Held-out workflow ${index}`,
    split: "held_out",
    taskFamily: `held-family-${index}`,
    environment: { splitGroup: `held-group-${Math.floor(index / 2)}` },
    workflow: {
      schemaVersion: 1,
      driverRevision: "test",
      steps: [
        { id: "first", prompt: "Return 4.", includePreviousOutput: false },
        {
          id: "second",
          prompt: "Repeat the previous number.",
          includePreviousOutput: true,
        },
      ],
    },
  },
}));
const campaign: WorkflowCampaign = {
  plan: {
    id: "campaign",
    createdAt: 2,
    request: {
      requestKey: "request",
      modelId: "fit",
      versionIds: versions.map((v) => v.id),
      candidates: workers,
      personaPriorIds: workers.map((c) => c.id),
      minQuality: 0.5,
      repetitions: 3,
      timeoutSeconds: 120,
      maxExecutions: 240,
    },
    modelSnapshotHash: "snapshot",
    cases: [],
    policies: [],
    cells: [{ caseIndex: 0, policyIndex: 0, repetition: 0 }],
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
      weights: { quality: 0.8, speed: 0.15, cost: 0.05 },
    },
  },
  planHash: "plan-hash",
  state: "reserved",
  stateReason: null,
  nextCell: 0,
  revision: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  vi.mocked(benchmarkApi.listSelectorFits).mockResolvedValue([
    {
      id: "fit",
      createdAt: 1,
      workClassId: artifact.model.workClassId,
      trainingCases: 8,
      commonCases: 8,
      groups: 4,
      candidates: 2,
      dispatchAllowed: false,
      status: "research_only",
    },
  ]);
  vi.mocked(benchmarkApi.getSelectorFit).mockResolvedValue(artifact);
  vi.mocked(benchmarkApi.listWorkflowCampaigns).mockResolvedValue([]);
  vi.mocked(benchmarkApi.getCapabilities).mockResolvedValue(
    workers.map((c) => ({
      providerId: c.providerId,
      executionProfile: c.executionProfile,
      supported: true,
      reason: "",
      cliAccountId: c.providerId === "codex-acp" ? "cli-codex" : null,
    })),
  );
  vi.mocked(listProviderAccounts).mockResolvedValue({
    accounts: [
      {
        id: "managed",
        providerId: "claude-acp",
        label: "Test account",
        authMethod: "oauth",
        enabled: true,
        autoSwitch: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "disabled",
        providerId: "claude-acp",
        label: "Disabled account",
        authMethod: "oauth",
        enabled: false,
        autoSwitch: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    defaults: {},
    automaticSwitching: {},
  });
});
afterEach(cleanup);

function wrap(content: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {content}
    </QueryClientProvider>,
  );
}
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  option: string | RegExp,
) {
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: option }));
}
function showCampaign(onEvidence = vi.fn()) {
  wrap(
    <WorkflowCampaignDialog
      versions={versions}
      currentVersions={versions}
      onClose={vi.fn()}
      onEvidence={onEvidence}
    />,
  );
  return onEvidence;
}

it.each([
  [{ message: "Reservation outcome unavailable" }, false],
  [
    {
      code: "invalid_workflow_campaign",
      message: "Campaign integrity check failed",
    },
    false,
  ],
  [
    {
      code: "invalid_workflow_campaign",
      message: "Family is reserved by another evaluation",
    },
    true,
  ],
])("preserves the frozen request after %j (editable: %s)", async (failure, editable) => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const historical = {
    ...versions[0],
    id: "old",
    manifest: { ...versions[0].manifest, name: "Historical workflow" },
  };
  let rejectFreeze!: (reason: unknown) => void;
  vi.mocked(benchmarkApi.freezeWorkflowCampaign)
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFreeze = reject;
        }),
    )
    .mockResolvedValueOnce(campaign);
  wrap(
    <WorkflowCampaignDialog
      versions={[...versions, historical]}
      currentVersions={versions}
      onClose={onClose}
      onEvidence={vi.fn()}
    />,
  );
  await user.click(screen.getByText("New comparison", { selector: "summary" }));
  await choose(user, "Saved fits", / · fit$/);
  const save = screen.getByRole("button", { name: "Save comparison plan" });
  expect(save).toBeDisabled();
  expect(
    screen.queryByRole("checkbox", { name: "Historical workflow" }),
  ).not.toBeInTheDocument();
  for (const version of versions)
    await user.click(
      screen.getByRole("checkbox", { name: version.manifest.name }),
    );
  await choose(user, "claude-acp / model-1 / high · Account", "Test account");
  await choose(user, "codex-acp / model-2 / high · Account", "CLI sign-in");
  expect(save).toBeDisabled();
  await choose(user, "Persona comparator", "claude-acp / model-1 / high");
  expect(save).toBeEnabled();
  expect(
    screen.getByText(/5 strategies · 120 workflows · up to 240 model calls/),
  ).toBeVisible();
  await user.click(save);
  expect(screen.getByRole("combobox", { name: "Saved fits" })).toBeDisabled();
  expect(
    screen.getByRole("checkbox", { name: versions[0].manifest.name }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => rejectFreeze(failure));
  expect(await screen.findByText(failure.message)).toBeVisible();
  if (editable) {
    expect(screen.getByRole("button", { name: "Change inputs" })).toBeEnabled();
  } else {
    expect(
      screen.queryByRole("button", { name: "Change inputs" }),
    ).not.toBeInTheDocument();
  }
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Retry the same reservation" }),
  );
  await screen.findByRole("button", { name: "Start comparison" });
  expect(benchmarkApi.freezeWorkflowCampaign).toHaveBeenCalledTimes(2);
  const calls = vi.mocked(benchmarkApi.freezeWorkflowCampaign).mock.calls;
  expect(calls[0][0]).toEqual(calls[1][0]);
  expect(calls[0][0]).toMatchObject({
    requestKey: expect.any(String),
    modelId: "fit",
    versionIds: versions.map((v) => v.id),
    candidates: [
      { ...workers[0], accountId: "managed" },
      { ...workers[1], accountId: "cli-codex" },
    ],
    personaPriorIds: ["config-1", "config-2"],
    repetitions: 3,
    minQuality: 0.5,
    maxExecutions: 240,
  });
  expect(benchmarkApi.controlWorkflowCampaign).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "Saved fits" })).toBeEnabled();
});

it("shows read-only account failures and does not enable freezing", async () => {
  vi.mocked(listProviderAccounts).mockRejectedValue({
    message: "Account listing unavailable",
  });
  wrap(
    <WorkflowCampaignForm
      artifact={artifact}
      versions={versions}
      onFrozen={vi.fn()}
    />,
  );
  expect(await screen.findByText("Account listing unavailable")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Save comparison plan" }),
  ).toBeDisabled();
  expect(benchmarkApi.freezeWorkflowCampaign).not.toHaveBeenCalled();
  expect(benchmarkApi.controlWorkflowCampaign).not.toHaveBeenCalled();
});

it("executes only explicit start, pause, resume and cancel actions and surfaces a failed start", async () => {
  const user = userEvent.setup();
  let saved = campaign;
  vi.mocked(benchmarkApi.listWorkflowCampaigns).mockImplementation(async () => [
    saved,
  ]);
  vi.mocked(benchmarkApi.controlWorkflowCampaign)
    .mockRejectedValueOnce({ message: "Saved account is unavailable" })
    .mockImplementation(async (_, action) => {
      saved = {
        ...saved,
        state:
          action === "pause"
            ? "paused"
            : action === "cancel"
              ? "cancelled"
              : "running",
        revision: saved.revision + 1,
      };
      return saved;
    });
  showCampaign();
  await choose(user, "Saved comparison", /campaign · Ready to start/);
  expect(benchmarkApi.controlWorkflowCampaign).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Start comparison" }));
  expect(await screen.findByText("Saved account is unavailable")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Start comparison" }));
  await user.click(
    await screen.findByRole("button", { name: "Pause after current workflow" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Resume comparison" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Cancel comparison" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Cancel comparison" }),
    ).not.toBeInTheDocument(),
  );
  expect(vi.mocked(benchmarkApi.controlWorkflowCampaign).mock.calls).toEqual([
    ["campaign", "start"],
    ["campaign", "start"],
    ["campaign", "pause"],
    ["campaign", "resume"],
    ["campaign", "cancel"],
  ]);
  expect(benchmarkApi.workflowCampaignReport).not.toHaveBeenCalled();
});

it("reconciles a start whose native state changed before its reply failed", async () => {
  const user = userEvent.setup();
  let saved = campaign;
  vi.mocked(benchmarkApi.listWorkflowCampaigns).mockImplementation(async () => [
    saved,
  ]);
  vi.mocked(benchmarkApi.controlWorkflowCampaign).mockImplementation(
    async () => {
      saved = { ...campaign, state: "running" };
      throw { message: "Control reply unavailable" };
    },
  );
  showCampaign();
  await choose(user, "Saved comparison", /campaign · Ready to start/);
  await user.click(screen.getByRole("button", { name: "Start comparison" }));
  expect(await screen.findByText("Control reply unavailable")).toBeVisible();
  expect(
    await screen.findByRole("button", { name: "Pause after current workflow" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Start comparison" }),
  ).not.toBeInTheDocument();
  expect(benchmarkApi.controlWorkflowCampaign).toHaveBeenCalledTimes(1);
});

it("renders fixed workers and comparator results, missing measurements, limitations and trace evidence", async () => {
  const user = userEvent.setup();
  const report: WorkflowCampaignReport = {
    campaignId: "campaign",
    planHash: "plan-hash",
    artifactHash: "artifact-hash",
    createdAt: 3,
    protocol: campaign.plan.evaluation,
    traceHashes: ["trace-hash"],
    groups: 4,
    dispatchAllowed: false,
    limitations: ["Some cost measurements are unavailable."],
    policies: [
      "fixed:worker:config-1",
      "learned",
      "aggregate",
      "persona",
      "best_fixed",
      "oracle",
    ].map((policy) => ({
      policy,
      selectedFixedKey: policy === "best_fixed" ? "worker:config-1" : null,
      quality: 0.7,
      utility: 0.6,
      utilityInterval: { lower: 0.4, upper: 0.8 },
      meanDurationMs: 1200,
      meanCost: null,
      missingDurationCases: 0,
      missingCostCases: 8,
      learnedUtilityGain: 0.1,
      learnedGainInterval: { lower: -0.1, upper: 0.2 },
    })),
    cases: [
      {
        versionId: versions[0].id,
        group: "held-group-0",
        learnedKey: "worker:config-1",
        aggregateKey: "worker:config-2",
        usedFallback: true,
        cells: [
          {
            candidateKey: "fixed:worker:config-1",
            runId: "run",
            quality: 0.7,
            utility: 0.6,
            meanDurationMs: 1200,
            meanCost: null,
            repeats: [
              {
                attemptId: "trace-attempt",
                repetition: 0,
                scoredAt: 3,
                quality: 0.7,
                durationMs: 1200,
                cost: null,
                evidenceHash: "evidence-hash",
                evaluationsHash: "evaluations-hash",
              },
            ],
          },
        ],
      },
    ],
  };
  vi.mocked(benchmarkApi.listWorkflowCampaigns).mockResolvedValue([
    { ...campaign, state: "completed", nextCell: 1 },
  ]);
  vi.mocked(benchmarkApi.workflowCampaignReport).mockResolvedValue(report);
  const onEvidence = showCampaign();
  await choose(user, "Saved comparison", /campaign · Finished/);
  const table = await screen.findByRole("table");
  for (const label of [
    "claude-acp / model-1 / high",
    "Learned selector",
    "Aggregate selector",
    "Persona",
    "Best fixed in hindsight",
    "Per-task oracle",
  ])
    expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
  expect(within(table).getAllByText("Unknown (8 tasks)")).toHaveLength(6);
  expect(within(table).getAllByText("1.20 s")).toHaveLength(6);
  expect(
    screen.getByText("Some cost measurements are unavailable."),
  ).not.toBeVisible();
  await user.click(screen.getByText("Report limitations"));
  expect(
    screen.getByText("Some cost measurements are unavailable."),
  ).toBeVisible();
  expect(
    screen.getByText(/4 declared groups · 1 tasks used the frozen fallback/),
  ).toBeVisible();
  await user.click(screen.getByText("Workflow attempts and evidence"));
  expect(
    screen.getByRole("heading", { name: versions[0].manifest.name }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Repeat 1 · quality 0.700" }),
  );
  expect(onEvidence).toHaveBeenCalledWith("trace-attempt");
  expect(benchmarkApi.workflowCampaignReport).toHaveBeenCalledWith("campaign");
  expect(benchmarkApi.controlWorkflowCampaign).not.toHaveBeenCalled();

  vi.mocked(benchmarkApi.freezeWorkflowCampaign).mockRejectedValue({
    message: "Reservation outcome unavailable",
  });
  await user.click(screen.getByText("New comparison", { selector: "summary" }));
  await choose(user, "Saved fits", / · fit$/);
  for (const version of versions)
    await user.click(
      screen.getByRole("checkbox", { name: version.manifest.name }),
    );
  await choose(user, "claude-acp / model-1 / high · Account", "Test account");
  await choose(user, "codex-acp / model-2 / high · Account", "CLI sign-in");
  await choose(user, "Persona comparator", "claude-acp / model-1 / high");
  await user.click(
    screen.getByRole("button", { name: "Save comparison plan" }),
  );
  await screen.findByText("Reservation outcome unavailable");
  const evidence = screen.getByRole("button", {
    name: "Repeat 1 · quality 0.700",
  });
  expect(evidence).toBeDisabled();
  await user.click(evidence);
  expect(onEvidence).toHaveBeenCalledTimes(1);
});

it("keeps a completed comparison visible when the saved report cannot be read", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.listWorkflowCampaigns).mockResolvedValue([
    { ...campaign, state: "completed", stateReason: "Recorded comparison" },
  ]);
  vi.mocked(benchmarkApi.workflowCampaignReport).mockRejectedValue({
    message: "Report evidence hash mismatch",
  });
  showCampaign();
  await choose(user, "Saved comparison", /campaign · Finished/);
  expect(
    await screen.findByText("Report evidence hash mismatch"),
  ).toBeVisible();
  expect(screen.getByText("Recorded comparison")).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(benchmarkApi.controlWorkflowCampaign).not.toHaveBeenCalled();
});
