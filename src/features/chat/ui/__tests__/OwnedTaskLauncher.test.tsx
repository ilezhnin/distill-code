import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  OwnedTaskMode,
  OwnedTaskModeRequestV2,
  OwnedTaskModeV2,
  OwnedTaskPrepareIntent,
  OwnedTaskRequestV2,
  NativeTaskConsent,
  OwnedTaskRequest,
  PreparedOwnedTask,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import type { PromotionState } from "@/features/benchmarks/lib/benchmarkGovernance";
import {
  MAX_OWNED_TASK_PROMPT_BYTES,
  MAX_NATIVE_TASK_PROMPT_BYTES,
  pendingOwnedTaskIntent,
  retainOwnedTaskIntent,
} from "../../lib/ownedTaskIntent";
import { PreCommitSendRejectedError } from "../../lib/preCommitSendRejection";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { OwnedTaskLauncher } from "../OwnedTaskLauncher";

const io = vi.hoisted(() => ({
  list: vi.fn(),
  choices: vi.fn(),
  prepare: vi.fn(),
  info: vi.fn(),
  send: vi.fn(),
  getMode: vi.fn(),
  setMode: vi.fn(),
  inspectMode: vi.fn(),
  nativeChoices: vi.fn(),
  personas: vi.fn(),
}));
vi.mock("@/features/benchmarks/api/benchmarkGovernance", () => ({
  benchmarkGovernanceApi: { listPromotions: io.list },
}));
vi.mock("@/shared/api/agents", () => ({ listPersonas: io.personas }));
vi.mock("@/features/benchmarks/lib/ownedTaskExecution", async (original) => ({
  ...(await original<
    typeof import("@/features/benchmarks/lib/ownedTaskExecution")
  >()),
  ownedTaskExecution: {
    choices: io.choices,
    prepare: io.prepare,
    getMode: io.getMode,
    setMode: io.setMode,
    inspectMode: io.inspectMode,
    nativeChoices: io.nativeChoices,
  },
}));
vi.mock("@/shared/api/acp", async (original) => ({
  ...(await original<typeof import("@/shared/api/acp")>()),
  acpGetSessionInfo: io.info,
}));
vi.mock("@/features/chat/lib/sendCore", () => ({ dispatchPrompt: io.send }));

const configuration = {
  id: "fixture-worker",
  providerId: "claude-acp",
  accountId: "fixture-account",
  modelId: "fixture-model",
  modelName: null,
  effort: "high",
  fastMode: false,
  billingMode: "simulated",
  executionProfile: "native_text",
  inventoryRevision: "fixture-runtime",
};
const certificate: PromotionState = {
  certificate: {
    id: "fixture-promotion",
    createdAt: 1,
    modelId: "fixture-fit",
    modelSnapshotHash: "fixture-snapshot",
    campaignId: "fixture-campaign",
    campaignPlanHash: "fixture-plan",
    reportHash: "fixture-report",
    ruleHash: "fixture-rule",
    artifactHash: "fixture-certificate",
    priorKeys: ["worker-alpha"],
    minPredictionQuality: 0.8,
    contract: {
      workClassId: "debug",
      roleId: "fixture-role",
      rolePrompt: "Use the frozen fictional role.",
      permissions: { context: "clean", network: false, tools: [] },
      executionProfile: "native_text",
      limits: { maxTurns: 1, timeoutSeconds: 10, maxArtifactBytes: 1024 },
      entryPresent: true,
    },
    qualifications: [],
    assessment: {
      rule: {
        recipe: "independent-group-sign-holm-v1",
        alpha: 0.01,
        minimumGroupUtilityGain: 0.1,
        minimumObservedQuality: 0.8,
      },
      groups: 8,
      observedQuality: 0.9,
      passed: true,
      comparisons: [],
      reasons: [],
      limitations: [],
    },
  },
  revokedAt: null,
  revocationReason: null,
};
const choices = [
  {
    candidateKey: "worker-alpha",
    configuration,
    available: true,
    reason: null,
  },
  {
    candidateKey: "worker-beta",
    configuration: {
      ...configuration,
      id: "fixture-worker-b",
      modelId: "fixture-model-b",
    },
    available: true,
    reason: null,
  },
];
const rolePath = "E:/Fictional Agents/helper.persona.md";
const nativeModes = new Map<string, OwnedTaskModeV2>();
function nativeConsent(request: OwnedTaskModeRequestV2): NativeTaskConsent {
  return {
    surface: request.surface,
    executionProfile: request.executionProfile,
    repository: request.repository,
    repositoryArchiveHash: request.repository ? "fictional-archive" : null,
    limits: request.limits,
    permissions: {
      context: "clean",
      tools: request.repository ? ["filesystem", "terminal"] : [],
      network: Boolean(request.repository),
    },
    roles: request.roles.map((role) => ({
      sourceId: `source:${role.sourcePath}`,
      sourcePath: role.sourcePath,
      sourceHash: "fictional-source-hash",
      roleId: "helper",
      rolePrompt: "Native fictional instructions.",
      workClassId: role.workClassId,
      prior: [],
      priorReason: "Fictional native default prior",
      unknownReasons: [],
      defaultEffort: null,
      defaultFastMode: null,
    })),
    providerIds: request.providerIds,
    complete: true,
    unknownReasons: [],
    artifactHash: `fictional-consent:${request.surface}`,
  };
}
function preparedV2(request: OwnedTaskRequestV2): PreparedOwnedTask {
  const mode = nativeModes.get(request.mode.contextId);
  if (!mode) throw new Error("Fictional native mode missing");
  const result = prepared({
    requestKey: request.requestKey,
    surface: request.surface,
    contextId: request.contextId,
    promotionId: "",
    acknowledgedCertificateHash: mode.consent.artifactHash,
    prompt: request.prompt,
    hardCandidateKey: request.hardCandidateKey,
    repository: mode.request.repository,
    entry: request.entry,
    waveMode: null,
  });
  result.binding.decision = {
    ...result.binding.decision,
    source: request.hardCandidateKey ? "pin" : "prior",
    reason: request.hardCandidateKey
      ? "Exact native pin retained"
      : "Native prior selected; no matching policy",
  };
  result.binding.contextV2 = {
    schemaVersion: 2,
    intent: request,
    consentHash: mode.consent.artifactHash,
    role: mode.consent.roles[0],
    envelopeHash: "fictional-envelope",
    complete: mode.consent.complete,
    unknownReasons: mode.consent.unknownReasons,
    selectedPolicyId: null,
    selectedPolicyHash: null,
    policyDiscovery: "No compatible active certificate",
    priorReason: "Fictional native default prior",
    inventoryHash: "fictional-native-inventory",
  };
  return result;
}
function prepared(request: OwnedTaskRequest): PreparedOwnedTask {
  return {
    binding: {
      id: "fixture-binding",
      request,
      createdAt: 1,
      certificateHash: "fixture-certificate",
      contextHash: "fixture-context",
      artifactHash: "fixture-binding-hash",
      task: {
        ...certificate.certificate.contract,
        prompt: request.prompt,
        fixtures: [],
        facets: {},
        entry: null,
      },
      decision: {} as PreparedOwnedTask["binding"]["decision"],
    },
    session: {
      owned: {
        sessionId: "fixture-session",
        ownerId: "task:fixture-binding",
        policyHash: "fixture-policy",
        selection: {
          modelId: configuration.modelId,
          reasoningEffort: "high",
          fastMode: false,
        },
        substitutions: [],
      },
      observed: configuration,
      contextHash: "fixture-context",
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  nativeModes.clear();
  useChatSessionStore.setState({ sessions: [], activeSessionId: null });
  io.list.mockResolvedValue([certificate]);
  io.choices.mockResolvedValue(choices);
  io.prepare.mockImplementation(async (request: OwnedTaskPrepareIntent) =>
    "schemaVersion" in request ? preparedV2(request) : prepared(request),
  );
  io.info.mockResolvedValue({
    sessionId: "fixture-session",
    title: "Fictional owned task",
    messageCount: 0,
    userSetName: false,
    providerId: configuration.providerId,
    modelId: configuration.modelId,
    executionOwner: { kind: "task", id: "task:fixture-binding" },
  });
  io.send.mockImplementation(async (_id, _text, options) => {
    options.onPromptDispatched();
  });
  io.getMode.mockResolvedValue(null);
  io.inspectMode.mockImplementation(async (request: OwnedTaskModeRequestV2) =>
    nativeConsent(request),
  );
  io.nativeChoices.mockResolvedValue(choices);
  io.personas.mockResolvedValue([
    {
      id: rolePath,
      displayName: "Fictional helper",
      provider: "claude-acp",
      systemPrompt: "Renderer body is not authority",
      isBuiltin: false,
      writable: true,
    },
  ]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(cleanup);
async function openReady(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New bounded task" }));
  await user.selectOptions(
    screen.getByLabelText("Contract selection"),
    "legacy",
  );
  await screen.findByRole("option", { name: /fixture-model · effort high/ });
  await user.click(
    screen.getByRole("checkbox", { name: /I choose this exact role/ }),
  );
}
const start = () => screen.getByRole("button", { name: "Start new task chat" });
const recovery = () =>
  within(screen.getByRole("dialog")).getByRole("button", {
    name: "Recover saved request",
  });

it.each([
  {
    label: "ASCII",
    accepted: "a".repeat(MAX_OWNED_TASK_PROMPT_BYTES),
    extra: "a",
  },
  {
    label: "multibyte",
    accepted: "🌱".repeat(MAX_OWNED_TASK_PROMPT_BYTES / 4),
    extra: "é",
  },
])("blocks oversized $label instructions before saving and admits the exact UTF-8 boundary after editing", async ({
  accepted,
  extra,
}) => {
  const oversized = accepted + extra;
  const user = userEvent.setup();
  render(<OwnedTaskLauncher draft={oversized} isConductor={false} />);
  await openReady(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "the native limit is 262144",
  );
  expect(start()).toBeDisabled();
  fireEvent.click(start());
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(io.prepare).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Task instructions")).toBeEnabled();
  expect(screen.getByLabelText("Task instructions")).toHaveValue(oversized);
  fireEvent.change(screen.getByLabelText("Task instructions"), {
    target: { value: accepted },
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(start()).toBeEnabled();
  await user.click(start());
  await waitFor(() => expect(io.prepare).toHaveBeenCalledOnce());
  expect(io.prepare.mock.calls[0][0].prompt).toBe(accepted);
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
});

it("recovers a legacy oversized saved prompt through explicit editing without retrying or losing its text and exact pin", async () => {
  const oversized = `${"🌱".repeat(MAX_OWNED_TASK_PROMPT_BYTES / 4)}é`;
  const saved = {
    kind: "chat",
    request: {
      requestKey: "legacy-fixture-request",
      surface: "chat",
      contextId: "legacy-fixture-context",
      promotionId: certificate.certificate.id,
      acknowledgedCertificateHash: certificate.certificate.artifactHash,
      prompt: oversized,
      hardCandidateKey: "worker-alpha",
      repository: null,
      entry: null,
      waveMode: null,
    },
  };
  const raw = JSON.stringify(saved);
  localStorage.setItem("distill.pendingOwnedTaskIntent.v1", raw);
  const user = userEvent.setup();
  render(
    <OwnedTaskLauncher draft="Unrelated new draft." isConductor={false} />,
  );
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  await screen.findByRole("option", { name: /fixture-model · effort high/ });
  expect(recovery()).toBeDisabled();
  fireEvent.click(recovery());
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(localStorage.getItem("distill.pendingOwnedTaskIntent.v1")).toBe(raw);
  expect(io.prepare).not.toHaveBeenCalled();
  expect(
    screen.queryByText(/saved task intent is invalid/),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Edit saved instructions" }),
  );
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(screen.getByLabelText("Task instructions")).toBeEnabled();
  expect(screen.getByLabelText("Task instructions")).toHaveValue(oversized);
  expect(screen.getByLabelText("Worker for the new task")).toHaveValue(
    "worker-alpha",
  );
  expect(start()).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Task instructions"), {
    target: { value: "A shorter fictional task." },
  });
  await user.click(screen.getByRole("checkbox"));
  await user.click(start());
  await waitFor(() => expect(io.prepare).toHaveBeenCalledOnce());
  expect(io.prepare.mock.calls[0][0]).toMatchObject({
    prompt: "A shorter fictional task.",
    hardCandidateKey: "worker-alpha",
  });
  expect(io.prepare.mock.calls[0][0].requestKey).not.toBe(
    saved.request.requestKey,
  );
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
});

it("keeps a valid intent immutable when generic invalid_task_authority is returned and recovers the same key", async () => {
  io.prepare.mockRejectedValueOnce(
    new Error("invalid_task_authority: acknowledgement unresolved"),
  );
  const user = userEvent.setup();
  render(
    <OwnedTaskLauncher draft="A valid fictional prompt." isConductor={false} />,
  );
  await openReady(user);
  await user.click(start());
  await screen.findByText(/invalid_task_authority/);
  const saved = pendingOwnedTaskIntent();
  expect(saved).not.toBeNull();
  expect(
    screen.queryByRole("button", { name: "Edit saved instructions" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Edit rejected task" }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Task instructions")).toBeDisabled();
  await user.click(recovery());
  await waitFor(() => expect(io.prepare).toHaveBeenCalledTimes(2));
  expect(io.prepare.mock.calls.map(([request]) => request)).toEqual([
    saved?.request,
    saved?.request,
  ]);
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
});

it.each([
  "prepare",
  "attach",
])("retains the exact accepted intent after lost %s ACK and recovers it after remount", async (phase) => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  const mounted = render(
    <OwnedTaskLauncher
      draft="Return a fictional result."
      isConductor={false}
      onStarted={onStarted}
    />,
  );
  if (phase === "prepare")
    io.prepare.mockRejectedValueOnce(
      new Error("Prepare acknowledgement unavailable"),
    );
  else
    io.info.mockRejectedValueOnce(
      new Error("Attach acknowledgement unavailable"),
    );
  await openReady(user);
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-alpha",
  );
  await user.click(start());
  await screen.findByRole("alert");
  const frozen = pendingOwnedTaskIntent();
  expect(frozen?.kind).toBe("chat");
  expect(io.send).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Task instructions")).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Close" }),
  ).not.toBeInTheDocument();
  mounted.unmount();
  render(
    <OwnedTaskLauncher
      draft="A newer unrelated draft."
      isConductor={false}
      onStarted={onStarted}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  expect(screen.getByLabelText("Task instructions")).toHaveValue(
    "Return a fictional result.",
  );
  expect(screen.getByLabelText("Worker for the new task")).toHaveValue(
    "worker-alpha",
  );
  await user.click(recovery());
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.prepare.mock.calls[1][0]).toEqual(io.prepare.mock.calls[0][0]);
  expect(io.send).toHaveBeenCalledWith(
    "fixture-session",
    "Return a fictional result.",
    expect.objectContaining({
      executorRequestKey:
        frozen?.kind === "chat" ? frozen.request.requestKey : undefined,
    }),
  );
  expect(onStarted).toHaveBeenCalledWith("fixture-session");
});

it("retains unknown dispatch with one exact key, permits explicit inspection and releases only on processing acknowledgement", async () => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  io.send.mockRejectedValueOnce(
    new Error("Native processing receipt is unknown"),
  );
  render(
    <OwnedTaskLauncher
      draft="Keep this task exact."
      isConductor={false}
      onStarted={onStarted}
    />,
  );
  await openReady(user);
  await user.click(start());
  await screen.findByText("Native processing receipt is unknown");
  const frozen = pendingOwnedTaskIntent();
  expect(
    screen.queryByRole("button", { name: "Edit rejected task" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Inspect attached task chat" }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(pendingOwnedTaskIntent()).toEqual(frozen);
  expect(onStarted).toHaveBeenCalledWith("fixture-session");
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  let acknowledge!: () => void;
  io.send.mockImplementationOnce(
    (_id, _text, options) =>
      new Promise<void>((resolve) => {
        acknowledge = () => {
          options.onPromptDispatched();
          resolve();
        };
      }),
  );
  await user.click(recovery());
  await waitFor(() => expect(io.send).toHaveBeenCalledTimes(2));
  expect(pendingOwnedTaskIntent()).toEqual(frozen);
  await act(async () => {
    acknowledge();
  });
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.prepare.mock.calls[1][0]).toEqual(io.prepare.mock.calls[0][0]);
});

it("blocks duplicate click, keyboard, close and sibling launcher admission while native preparation is unresolved", async () => {
  const user = userEvent.setup();
  let accept!: (value: PreparedOwnedTask) => void;
  io.prepare.mockImplementationOnce(
    () =>
      new Promise<PreparedOwnedTask>((resolve) => {
        accept = resolve;
      }),
  );
  render(
    <>
      <OwnedTaskLauncher
        draft="One fictional task."
        isConductor
        sessionId="conductor"
      />
      <OwnedTaskLauncher draft="Other fictional task." isConductor={false} />
    </>,
  );
  await user.click(
    screen.getAllByRole("button", { name: "New bounded task" })[0],
  );
  await user.selectOptions(
    screen.getByLabelText("Contract selection"),
    "legacy",
  );
  await screen.findByRole("option", { name: /fixture-model · effort high/ });
  await user.click(screen.getByRole("checkbox"));
  const action = start();
  act(() => {
    fireEvent.click(action);
    fireEvent.click(action);
  });
  await waitFor(() => expect(io.prepare).toHaveBeenCalledOnce());
  await user.keyboard("{Enter}{Escape}");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Use this contract for wave steps" }),
  ).toBeDisabled();
  const currentSibling = screen
    .getAllByRole("button", { name: "Recover saved request", hidden: true })
    .filter((button) => !button.closest('[role="dialog"]'))[1];
  expect(currentSibling).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Close" }),
  ).not.toBeInTheDocument();
  const request = io.prepare.mock.calls[0][0];
  await act(async () => {
    accept(prepared(request));
  });
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.prepare).toHaveBeenCalledOnce();
});

it("refuses a stale certificate and changed native pin availability without creating or substituting a task", async () => {
  const user = userEvent.setup();
  render(
    <OwnedTaskLauncher draft="Pinned fictional task." isConductor={false} />,
  );
  await openReady(user);
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-alpha",
  );
  io.choices.mockResolvedValue([
    { ...choices[0], available: false, reason: "Frozen effort unavailable" },
    choices[1],
  ]);
  await user.click(start());
  await screen.findByText(/No replacement was selected/);
  expect(io.prepare).not.toHaveBeenCalled();
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(screen.getByLabelText("Worker for the new task")).toHaveValue(
    "worker-alpha",
  );
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-beta",
  );
  io.list.mockResolvedValue([
    {
      ...certificate,
      certificate: {
        ...certificate.certificate,
        artifactHash: "changed-certificate",
      },
    },
  ]);
  await user.click(start());
  await screen.findByText(/certificate changed or was revoked/);
  expect(io.prepare).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByLabelText("Task instructions")).toHaveValue(
    "Pinned fictional task.",
  );
});

it("forwards automatic policy as null and preserves an exact worker pin", async () => {
  const user = userEvent.setup();
  const mounted = render(
    <OwnedTaskLauncher draft="Automatic fictional task." isConductor={false} />,
  );
  await openReady(user);
  await user.click(start());
  await waitFor(() => expect(io.prepare).toHaveBeenCalledOnce());
  expect(io.prepare.mock.calls[0][0].hardCandidateKey).toBeNull();
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  mounted.unmount();
  render(
    <OwnedTaskLauncher draft="Pinned fictional task." isConductor={false} />,
  );
  await openReady(user);
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-beta",
  );
  await user.click(start());
  await waitFor(() => expect(io.prepare).toHaveBeenCalledTimes(2));
  expect(io.prepare.mock.calls[1][0].hardCandidateKey).toBe("worker-beta");
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
});

it("keeps a definitely rejected task editable only through an explicit action that preserves text and pin", async () => {
  const user = userEvent.setup();
  io.send.mockRejectedValueOnce(
    new PreCommitSendRejectedError("Authority refused before processing"),
  );
  render(
    <OwnedTaskLauncher
      draft="Preserve rejected instructions."
      isConductor={false}
    />,
  );
  await openReady(user);
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-alpha",
  );
  await user.click(start());
  await screen.findByRole("button", { name: "Edit rejected task" });
  expect(pendingOwnedTaskIntent()).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Edit rejected task" }));
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(screen.getByLabelText("Task instructions")).toHaveValue(
    "Preserve rejected instructions.",
  );
  expect(screen.getByLabelText("Worker for the new task")).toHaveValue(
    "worker-alpha",
  );
  expect(start()).toBeDisabled();
});

it("recovers a mode's lost acknowledgement for its frozen conductor after remount and rejects a mismatched confirmation", async () => {
  const user = userEvent.setup();
  let mode: OwnedTaskMode | null = null;
  io.getMode.mockImplementation(async () => mode);
  io.setMode.mockImplementationOnce(async (request) => {
    mode = { request, createdAt: 1, artifactHash: "mode-hash" };
    throw new Error("Mode acknowledgement unavailable");
  });
  const mounted = render(
    <OwnedTaskLauncher
      draft="Fictional wave."
      isConductor
      sessionId="conductor-a"
    />,
  );
  await openReady(user);
  await user.click(
    screen.getByRole("button", { name: "Use this contract for wave steps" }),
  );
  await screen.findByText("Mode acknowledgement unavailable");
  const frozen = pendingOwnedTaskIntent();
  expect(frozen?.kind).toBe("mode");
  mounted.unmount();
  render(
    <OwnedTaskLauncher
      draft="Unrelated newer wave."
      isConductor
      sessionId="conductor-b"
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  expect(screen.getByText(/conductor-a/, { selector: "code" })).toBeVisible();
  await user.click(recovery());
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.setMode).toHaveBeenCalledOnce();
  expect(io.getMode.mock.calls.slice(-2)).toEqual([
    ["conductor-a"],
    ["conductor-a"],
  ]);
  cleanup();
  if (!frozen) throw new Error("Mode request was not retained");
  retainOwnedTaskIntent(frozen);
  io.getMode.mockResolvedValue({
    request: {
      ...(frozen?.kind === "mode" ? frozen.request : {}),
      contextId: "unrelated-context",
    },
    artifactHash: "unrelated-mode",
    createdAt: 1,
  });
  io.setMode.mockResolvedValue({
    request: {
      ...(frozen?.kind === "mode" ? frozen.request : {}),
      contextId: "unrelated-context",
    },
    artifactHash: "unrelated-mode",
    createdAt: 1,
  });
  render(<OwnedTaskLauncher isConductor sessionId="conductor-b" />);
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  await user.click(recovery());
  await screen.findByText(/mode acknowledgement is unresolved/);
  expect(pendingOwnedTaskIntent()).toEqual(frozen);
});

it("fails closed on corrupt durable intent without erasing it or crashing the launcher", async () => {
  localStorage.setItem(
    "distill.pendingOwnedTaskIntent.v1",
    '{"kind":"chat","request":{"contextId":"fixture"}}',
  );
  const user = userEvent.setup();
  render(<OwnedTaskLauncher draft="Unrelated new task." isConductor={false} />);
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  expect(await screen.findByText(/saved task intent is invalid/)).toBeVisible();
  expect(start()).toBeDisabled();
  expect(io.prepare).not.toHaveBeenCalled();
  expect(localStorage.getItem("distill.pendingOwnedTaskIntent.v1")).toContain(
    '"contextId":"fixture"',
  );
});

function useNativeModes() {
  io.getMode.mockImplementation(
    async (contextId: string) => nativeModes.get(contextId) ?? null,
  );
  io.setMode.mockImplementation(async (request: OwnedTaskModeRequestV2) => {
    const mode: OwnedTaskModeV2 = {
      schemaVersion: 2,
      request,
      consent: nativeConsent(request),
      createdAt: 1,
      artifactHash: `mode:${request.contextId}`,
    };
    nativeModes.set(request.contextId, mode);
    return mode;
  });
}
async function inspectNative(
  user: ReturnType<typeof userEvent.setup>,
  wave = false,
) {
  await user.click(screen.getByRole("button", { name: "New bounded task" }));
  await screen.findByRole("option", { name: /Fictional helper/ });
  if (wave)
    await user.selectOptions(
      screen.getByLabelText("Apply this contract to"),
      "wave",
    );
  await user.selectOptions(screen.getByLabelText("Role source 1"), rolePath);
  await user.selectOptions(screen.getByLabelText("Work class 1"), "debug");
  await user.click(screen.getByRole("checkbox", { name: "claude-acp" }));
  await user.click(
    screen.getByRole("button", { name: "Inspect native contract" }),
  );
  await screen.findByText("fictional-source-hash", { exact: false });
  expect(
    screen.getByRole("button", {
      name: wave
        ? "Use this contract for wave steps"
        : "Save acknowledged contract",
    }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("checkbox", { name: /I choose this exact role/ }),
  );
}
async function saveNative(user: ReturnType<typeof userEvent.setup>) {
  await inspectNative(user);
  await user.click(
    screen.getByRole("button", { name: "Save acknowledged contract" }),
  );
  await screen.findByRole("option", { name: /fixture-model · effort high/ });
}

it("defaults to native consent without a certificate and releases the frozen task only on processing ACK", async () => {
  const user = userEvent.setup();
  useNativeModes();
  let acknowledge!: () => void;
  io.send.mockImplementationOnce(
    (_id, _text, options) =>
      new Promise<void>((resolve) => {
        acknowledge = () => {
          options.onPromptDispatched();
          resolve();
        };
      }),
  );
  const onStarted = vi.fn();
  render(
    <OwnedTaskLauncher
      draft="Native fictional task."
      isConductor={false}
      onStarted={onStarted}
    />,
  );
  await saveNative(user);
  expect(io.list).not.toHaveBeenCalled();
  expect(io.choices).not.toHaveBeenCalled();
  expect(io.inspectMode.mock.calls[0][0]).toMatchObject({
    schemaVersion: 2,
    surface: "chat",
    roles: [{ sourcePath: rolePath, workClassId: "debug" }],
    providerIds: ["claude-acp"],
    limits: { maxTurns: 1 },
  });
  expect(io.inspectMode.mock.calls[0][0]).not.toHaveProperty("permissions");
  expect(io.inspectMode.mock.calls[0][0]).not.toHaveProperty("rolePrompt");
  await user.click(start());
  await screen.findByText(
    "Native selection: prior · claude-acp · fixture-model",
  );
  expect(
    screen.getByText("Native prior selected; no matching policy"),
  ).toBeVisible();
  expect(screen.getByText("No compatible active certificate")).toBeVisible();
  expect(pendingOwnedTaskIntent()?.kind).toBe("chat");
  expect(screen.getByLabelText("Task instructions")).toBeDisabled();
  const request = io.prepare.mock.calls[0][0];
  expect(request).toMatchObject({
    schemaVersion: 2,
    roleSourceId: `source:${rolePath}`,
    workClassId: "debug",
    hardCandidateKey: null,
    entry: null,
  });
  expect(request).not.toHaveProperty("promotionId");
  expect(request).not.toHaveProperty("permissions");
  expect(request).not.toHaveProperty("rolePrompt");
  await act(async () => {
    acknowledge();
  });
  await screen.findByText(/Native processing acknowledged this exact task/);
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(start()).toBeDisabled();
  expect(onStarted).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Inspect attached task chat" }),
  );
  expect(onStarted).toHaveBeenCalledWith("fixture-session");
});

it.each([
  "prepare",
  "attach",
])("recovers native v2 after lost %s acknowledgement with the exact mode, key and pin", async (phase) => {
  const user = userEvent.setup();
  useNativeModes();
  if (phase === "prepare")
    io.prepare.mockRejectedValueOnce(new Error("Native prepare reply lost"));
  else io.info.mockRejectedValueOnce(new Error("Native attach reply lost"));
  const view = render(
    <OwnedTaskLauncher draft="Preserve native task." isConductor={false} />,
  );
  await saveNative(user);
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-beta",
  );
  await user.click(start());
  await screen.findByRole("alert");
  const frozen = pendingOwnedTaskIntent();
  expect(frozen?.request).toMatchObject({
    schemaVersion: 2,
    hardCandidateKey: "worker-beta",
  });
  expect(screen.getByLabelText("Contract selection")).toBeDisabled();
  expect(io.send).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeVisible();
  view.unmount();
  render(<OwnedTaskLauncher draft="Unrelated draft." isConductor={false} />);
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  expect(screen.getByLabelText("Task instructions")).toHaveValue(
    "Preserve native task.",
  );
  expect(screen.getByLabelText("Worker for the new task")).toHaveValue(
    "worker-beta",
  );
  await user.click(recovery());
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.prepare.mock.calls.map(([request]) => request)).toEqual([
    frozen?.request,
    frozen?.request,
  ]);
  expect(io.setMode).toHaveBeenCalledOnce();
  expect(io.send).toHaveBeenCalledOnce();
});

it.each([
  "chat",
  "wave",
])("recovers a lost native %s consent response without altering its original context", async (surface) => {
  const user = userEvent.setup();
  useNativeModes();
  io.setMode.mockImplementationOnce(async (request: OwnedTaskModeRequestV2) => {
    nativeModes.set(request.contextId, {
      schemaVersion: 2,
      request,
      consent: nativeConsent(request),
      createdAt: 1,
      artifactHash: "native-saved-mode",
    });
    throw new Error("Native consent response lost");
  });
  const view = render(
    <OwnedTaskLauncher
      draft="Native mode task."
      isConductor
      sessionId="fictional-conductor-a"
    />,
  );
  await inspectNative(user, surface === "wave");
  await user.click(
    screen.getByRole("button", {
      name:
        surface === "wave"
          ? "Use this contract for wave steps"
          : "Save acknowledged contract",
    }),
  );
  await screen.findByText("Native consent response lost");
  const frozen = pendingOwnedTaskIntent();
  expect(frozen?.kind).toBe("mode");
  expect(frozen?.request).toMatchObject({
    surface,
    acknowledgedContractHash: `fictional-consent:${surface}`,
  });
  view.unmount();
  render(<OwnedTaskLauncher isConductor sessionId="fictional-conductor-b" />);
  await user.click(
    screen.getByRole("button", { name: "Recover saved request" }),
  );
  await user.click(recovery());
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.setMode).toHaveBeenCalledOnce();
  expect(io.prepare).not.toHaveBeenCalled();
  expect(io.getMode).toHaveBeenCalledWith(frozen?.request.contextId);
});

it("discloses incomplete native learned authority and requires new acknowledgement after a contract input changes", async () => {
  const user = userEvent.setup();
  useNativeModes();
  io.inspectMode.mockImplementationOnce(
    async (request: OwnedTaskModeRequestV2) => ({
      ...nativeConsent(request),
      complete: false,
      unknownReasons: ["Unsupported role preference mapping"],
    }),
  );
  render(<OwnedTaskLauncher draft="Fictional task." isConductor={false} />);
  await inspectNative(user);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Unsupported role preference mapping",
  );
  expect(
    screen.getByRole("button", { name: "Save acknowledged contract" }),
  ).toBeEnabled();
  await user.clear(
    screen.getByLabelText("Native root execution budget (seconds)"),
  );
  await user.type(
    screen.getByLabelText("Native root execution budget (seconds)"),
    "17",
  );
  expect(
    screen.queryByRole("button", { name: "Save acknowledged contract" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Inspect native contract" }),
  );
  await screen.findByRole("button", { name: "Save acknowledged contract" });
  expect(
    screen.getByRole("checkbox", { name: /I choose this exact role/ }),
  ).not.toBeChecked();
  expect(io.setMode).not.toHaveBeenCalled();
});

it("refuses a newly unavailable native exact pin without substitution and keeps text editable", async () => {
  const user = userEvent.setup();
  useNativeModes();
  render(<OwnedTaskLauncher draft="Native pinned task." isConductor={false} />);
  await saveNative(user);
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-alpha",
  );
  io.nativeChoices.mockResolvedValue([
    { ...choices[0], available: false, reason: "Exact effort unavailable" },
    choices[1],
  ]);
  await user.click(start());
  await screen.findByText(/No replacement was selected/);
  expect(io.prepare).not.toHaveBeenCalled();
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(screen.getByLabelText("Worker for the new task")).toHaveValue(
    "worker-alpha",
  );
  expect(screen.getByLabelText("Task instructions")).toBeEnabled();
});

it("admits native UTF-8 prompt boundary and preserves an unknown native refusal without an edit escape", async () => {
  const user = userEvent.setup();
  useNativeModes();
  io.prepare.mockRejectedValueOnce(
    new Error("Native authority response unresolved"),
  );
  const exact = "🌱".repeat(MAX_NATIVE_TASK_PROMPT_BYTES / 4);
  render(<OwnedTaskLauncher draft={`${exact}é`} isConductor={false} />);
  await saveNative(user);
  expect(screen.getByRole("alert")).toHaveTextContent("native limit is 131072");
  expect(start()).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Task instructions"), {
    target: { value: exact },
  });
  await user.click(start());
  await screen.findByText("Native authority response unresolved");
  const frozen = pendingOwnedTaskIntent();
  expect(frozen?.kind === "chat" ? frozen.request.prompt : null).toBe(exact);
  expect(
    screen.queryByRole("button", { name: "Edit rejected task" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Edit saved instructions" }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Task instructions")).toBeDisabled();
});

it.each([
  "pin",
  "learned",
] as const)("displays the actual native %s route and its authority instead of claiming a renderer selection", async (source) => {
  const user = userEvent.setup();
  useNativeModes();
  io.prepare.mockImplementationOnce(async (request: OwnedTaskRequestV2) => {
    const result = preparedV2(request);
    result.binding.decision.source = source;
    result.binding.decision.reason =
      source === "pin"
        ? "Exact native pin retained"
        : "Unique compatible policy admitted";
    if (result.binding.contextV2 && source === "learned") {
      result.binding.contextV2.selectedPolicyId = "fictional-active-policy";
      result.binding.contextV2.selectedPolicyHash = "fictional-policy-hash";
      result.binding.contextV2.policyDiscovery = "Unique exact policy found";
    }
    return result;
  });
  render(
    <OwnedTaskLauncher draft="Fictional routed task." isConductor={false} />,
  );
  await saveNative(user);
  if (source === "pin")
    await user.selectOptions(
      screen.getByLabelText("Worker for the new task"),
      "worker-alpha",
    );
  await user.click(start());
  await screen.findByText(
    `Native selection: ${source} · claude-acp · fixture-model`,
  );
  expect(io.prepare.mock.calls[0][0].hardCandidateKey).toBe(
    source === "pin" ? "worker-alpha" : null,
  );
  if (source === "learned") {
    expect(screen.getByText("Unique compatible policy admitted")).toBeVisible();
    expect(
      screen.getByText(/fictional-active-policy · fictional-policy-hash/),
    ).toBeVisible();
  }
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
});

it("retains a mismatched native consent confirmation and permits no prepare or input edits", async () => {
  const user = userEvent.setup();
  useNativeModes();
  io.setMode.mockImplementationOnce(async (request: OwnedTaskModeRequestV2) => {
    const unrelated = { ...request, contextId: "unrelated-native-context" };
    const mode: OwnedTaskModeV2 = {
      schemaVersion: 2,
      request: unrelated,
      consent: nativeConsent(unrelated),
      createdAt: 1,
      artifactHash: "unrelated-mode",
    };
    nativeModes.set(request.contextId, mode);
    return mode;
  });
  render(<OwnedTaskLauncher draft="Fictional task." isConductor={false} />);
  await inspectNative(user);
  await user.click(
    screen.getByRole("button", { name: "Save acknowledged contract" }),
  );
  await screen.findByText(/mode acknowledgement is unresolved/);
  expect(pendingOwnedTaskIntent()?.kind).toBe("mode");
  expect(screen.getByLabelText("Contract selection")).toBeDisabled();
  expect(io.prepare).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Review a different contract" }),
  ).not.toBeInTheDocument();
});

it.each([
  "save",
  "prepare",
])("requires explicit reinspection after a proven native pre-write %s refusal", async (phase) => {
  const user = userEvent.setup();
  useNativeModes();
  const refusal = {
    code: "owned_task_intent_refused",
    message: "The fictional role changed before native admission",
  };
  render(
    <OwnedTaskLauncher
      draft="Preserve refused instructions."
      isConductor={false}
    />,
  );
  if (phase === "save") {
    io.setMode.mockRejectedValueOnce(refusal);
    await inspectNative(user);
    await user.click(
      screen.getByRole("button", { name: "Save acknowledged contract" }),
    );
  } else {
    await saveNative(user);
    await user.selectOptions(
      screen.getByLabelText("Worker for the new task"),
      "worker-beta",
    );
    io.prepare.mockRejectedValueOnce(refusal);
    await user.click(start());
  }
  await screen.findByText(refusal.message);
  const frozen = pendingOwnedTaskIntent();
  expect(frozen?.kind).toBe(phase === "save" ? "mode" : "chat");
  expect(screen.getByLabelText("Task instructions")).toBeDisabled();
  expect(io.send).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", {
      name: phase === "save" ? "Review refused contract" : "Edit rejected task",
    }),
  );
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(screen.getByLabelText("Task instructions")).toHaveValue(
    "Preserve refused instructions.",
  );
  expect(screen.getByLabelText("Role source 1")).toHaveValue(rolePath);
  expect(start()).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Inspect native contract" }),
  );
  const save = await screen.findByRole("button", {
    name: "Save acknowledged contract",
  });
  expect(save).toBeDisabled();
  expect(
    screen.getByRole("checkbox", { name: /I choose this exact role/ }),
  ).not.toBeChecked();
  await user.click(
    screen.getByRole("checkbox", { name: /I choose this exact role/ }),
  );
  await user.click(save);
  await waitFor(() => expect(start()).toBeEnabled());
  if (phase === "prepare") {
    expect(screen.getByLabelText("Worker for the new task")).toHaveValue(
      "worker-beta",
    );
  }
  await user.click(start());
  await screen.findByText(/Native processing acknowledged this exact task/);
  const next = io.prepare.mock.calls.at(-1)?.[0];
  expect(next.contextId).not.toBe(frozen?.request.contextId);
  if (frozen?.kind === "chat") {
    expect(next.requestKey).not.toBe(frozen.request.requestKey);
    expect(next.hardCandidateKey).toBe(frozen.request.hardCandidateKey);
  }
  expect(next.prompt).toBe("Preserve refused instructions.");
  expect(io.send).toHaveBeenCalledOnce();
});

it("permits an explicit new task only after the native record proves setup expired before any prompt", async () => {
  const user = userEvent.setup();
  useNativeModes();
  render(
    <OwnedTaskLauncher draft="Fictional expired setup." isConductor={false} />,
  );
  await saveNative(user);
  io.prepare.mockRejectedValueOnce({
    code: "owned_task_preparation_refused",
    message: "Native setup exhausted its fictional root budget",
  });
  await user.click(start());
  await screen.findByText("Native setup exhausted its fictional root budget");
  const frozen = pendingOwnedTaskIntent();
  expect(frozen?.kind).toBe("chat");
  expect(io.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Edit rejected task" }));
  expect(pendingOwnedTaskIntent()).toBeNull();
  expect(screen.getByLabelText("Task instructions")).toHaveValue(
    "Fictional expired setup.",
  );
});

it("discloses protected repository permissions and sends only exact source refs for native inspection", async () => {
  const user = userEvent.setup();
  useNativeModes();
  render(
    <OwnedTaskLauncher
      draft="Fictional repository task."
      isConductor={false}
    />,
  );
  await user.click(screen.getByRole("button", { name: "New bounded task" }));
  await screen.findByRole("option", { name: /Fictional helper/ });
  await user.selectOptions(
    screen.getByLabelText("Supported native profile"),
    "protected_repository",
  );
  await user.selectOptions(screen.getByLabelText("Role source 1"), rolePath);
  await user.click(screen.getByRole("checkbox", { name: "codex-acp" }));
  expect(
    screen.getByRole("button", { name: "Inspect native contract" }),
  ).toBeDisabled();
  await user.type(
    screen.getByLabelText("Source repository path"),
    "E:/Fictional Repository",
  );
  await user.type(screen.getByLabelText("Commit hash"), "fictional-commit");
  await user.type(screen.getByLabelText("Tree hash"), "fictional-tree");
  await user.click(
    screen.getByRole("button", { name: "Inspect native contract" }),
  );
  expect(
    await screen.findByText(
      "Tools: filesystem, terminal. Public network: allowed. Fresh context.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText("Verified repository archive: fictional-archive"),
  ).toBeVisible();
  expect(io.inspectMode.mock.calls[0][0]).toMatchObject({
    repository: {
      path: "E:/Fictional Repository",
      commit: "fictional-commit",
      tree: "fictional-tree",
    },
    providerIds: ["codex-acp"],
  });
  expect(io.setMode).not.toHaveBeenCalled();
  expect(io.prepare).not.toHaveBeenCalled();
});

it("allows explicitly acknowledged native prior or pin when role preference interpretation prevents learned admission", async () => {
  const user = userEvent.setup();
  useNativeModes();
  const incomplete = (request: OwnedTaskModeRequestV2): NativeTaskConsent => ({
    ...nativeConsent(request),
    complete: false,
    unknownReasons: ["Unsupported native preference alias"],
  });
  io.inspectMode.mockImplementation(async (request: OwnedTaskModeRequestV2) =>
    incomplete(request),
  );
  io.setMode.mockImplementation(async (request: OwnedTaskModeRequestV2) => {
    const mode: OwnedTaskModeV2 = {
      schemaVersion: 2,
      request,
      consent: incomplete(request),
      createdAt: 1,
      artifactHash: "incomplete-native-mode",
    };
    nativeModes.set(request.contextId, mode);
    return mode;
  });
  render(
    <OwnedTaskLauncher
      draft="Fictional incomplete preference task."
      isConductor={false}
    />,
  );
  await saveNative(user);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Learned routing is unavailable",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Unsupported native preference alias",
  );
  await user.selectOptions(
    screen.getByLabelText("Worker for the new task"),
    "worker-alpha",
  );
  await user.click(start());
  await screen.findByText("Native selection: pin · claude-acp · fixture-model");
  expect(screen.getByText(/No compatible learned policy/)).toBeVisible();
  expect(
    screen.queryByText(/Native selection: learned/),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
});

it("keeps native wave disable recovery visible when the unchanged disable command loses its response", async () => {
  const user = userEvent.setup();
  useNativeModes();
  render(
    <OwnedTaskLauncher
      draft="Fictional wave task."
      isConductor
      sessionId="fictional-wave-conductor"
    />,
  );
  await inspectNative(user, true);
  await user.click(
    screen.getByRole("button", { name: "Use this contract for wave steps" }),
  );
  await screen.findByText(
    "Native consent saved for this conductor's matching wave roles.",
  );
  io.setMode.mockImplementationOnce(
    async (request: OwnedTaskMode["request"]) => {
      expect(request.promotionId).toBeNull();
      nativeModes.delete(request.contextId);
      throw new Error("Fictional disable reply lost");
    },
  );
  await user.click(
    screen.getByRole("button", { name: "Disable owned wave execution" }),
  );
  expect(
    await screen.findByText(/saved task or mode change is unresolved/),
  ).toBeVisible();
  const frozen = pendingOwnedTaskIntent();
  expect(frozen).toMatchObject({
    kind: "mode",
    request: {
      contextId: "fictional-wave-conductor",
      promotionId: null,
      acknowledgedCertificateHash: "",
      repository: null,
    },
  });
  await waitFor(() => expect(recovery()).toBeEnabled());
  await user.click(recovery());
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.setMode).toHaveBeenCalledTimes(2);
  expect(io.prepare).not.toHaveBeenCalled();
});

it("requires fresh native consent and a new context before another explicitly requested task after processing ACK", async () => {
  const user = userEvent.setup();
  useNativeModes();
  render(
    <OwnedTaskLauncher draft="Fictional separate task." isConductor={false} />,
  );
  await saveNative(user);
  await user.click(start());
  await screen.findByText(/Native processing acknowledged this exact task/);
  const first = io.prepare.mock.calls[0][0];
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "New bounded task",
    }),
  );
  expect(start()).toBeDisabled();
  expect(io.prepare).toHaveBeenCalledOnce();
  await user.click(
    screen.getByRole("button", { name: "Inspect native contract" }),
  );
  const save = await screen.findByRole("button", {
    name: "Save acknowledged contract",
  });
  expect(save).toBeDisabled();
  await user.click(
    screen.getByRole("checkbox", { name: /I choose this exact role/ }),
  );
  await user.click(save);
  await waitFor(() => expect(start()).toBeEnabled());
  await user.click(start());
  await waitFor(() => expect(pendingOwnedTaskIntent()).toBeNull());
  expect(io.prepare).toHaveBeenCalledTimes(2);
  const second = io.prepare.mock.calls[1][0];
  expect(second.contextId).not.toBe(first.contextId);
  expect(second.requestKey).not.toBe(first.requestKey);
});
