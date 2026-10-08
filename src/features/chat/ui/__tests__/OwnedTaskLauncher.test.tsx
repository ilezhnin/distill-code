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
  OwnedTaskRequest,
  PreparedOwnedTask,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import type { PromotionState } from "@/features/benchmarks/lib/benchmarkGovernance";
import {
  MAX_OWNED_TASK_PROMPT_BYTES,
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
}));
vi.mock("@/features/benchmarks/api/benchmarkGovernance", () => ({
  benchmarkGovernanceApi: { listPromotions: io.list },
}));
vi.mock("@/features/benchmarks/lib/ownedTaskExecution", () => ({
  ownedTaskExecution: {
    choices: io.choices,
    prepare: io.prepare,
    getMode: io.getMode,
    setMode: io.setMode,
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
  useChatSessionStore.setState({ sessions: [], activeSessionId: null });
  io.list.mockResolvedValue([certificate]);
  io.choices.mockResolvedValue(choices);
  io.prepare.mockImplementation(async (request: OwnedTaskRequest) =>
    prepared(request),
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(cleanup);
async function openReady(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New bounded task" }));
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
  const sibling = screen.getAllByRole("button", {
    name: "New bounded task",
  })[1];
  await user.click(
    screen.getAllByRole("button", { name: "New bounded task" })[0],
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
  expect(sibling).toBeDisabled();
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
