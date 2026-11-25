import { stopOrchestratorSession } from "@/features/conductor/orchestratorControls";
import { i18n } from "@/shared/i18n/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChat } from "@/features/chat/hooks/useChat";
import { useMessageQueue } from "@/features/chat/hooks/useMessageQueue";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { dispatchPrompt } from "@/features/chat/lib/sendCore";
import { steerPromptInSession } from "@/features/chat/lib/steerCore";
import { submitComposerMessage } from "@/features/chat/lib/submitComposerMessage";
import { clearAccountQuotaWait } from "@/features/chat/lib/accountQuotaWait";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { createWaveState } from "@/features/conductor/waveEngine";
import {
  emptyWaveEngineState,
  setWaveEngineState,
} from "@/features/conductor/waveStore";
import { parseStructuredReport } from "@/features/conductor/orchestratorReport";
import { publishTerminalGroupDigests } from "@/features/conductor/digestPublisher";
import {
  recordSessionTokens,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";
import { listSkills, type SkillInfo } from "@/features/skills/api/skills";
import { createUserMessage } from "@/shared/types/messages";
import { acpSendMessage, acpSteerMessage } from "@/shared/api/acp";
import { startChatAutomation } from "./goalRuntime";
import { useChatGoalStore } from "./goalStore";
import { DAY, MIN_DELAY, parseLoopCommand } from "./loopCommands";
import {
  getChatLoops,
  hydrateChatLoops,
  loopCounters,
  selectChatLoops,
  useChatLoopStore,
} from "./loopStore";
import { assertLoopDispatch } from "./loopRuntime";

vi.mock("@/features/chat/lib/chatExecutorDispatch", async (load) => ({
  ...(await load<typeof import("@/features/chat/lib/chatExecutorDispatch")>()),
  prepareChatExecutorDispatch: vi.fn(async () => undefined),
}));
vi.mock("@/shared/api/acp", async (load) => ({
  ...(await load<typeof import("@/shared/api/acp")>()),
  acpSendMessage: vi.fn(),
  acpSteerMessage: vi.fn(),
  acpCancelSession: vi.fn(async () => true),
  acpPrepareSessionAccount: vi.fn(async () => undefined),
}));
vi.mock("@/shared/api/acpApi", async (load) => ({
  ...(await load<typeof import("@/shared/api/acpApi")>()),
  archiveSession: vi.fn(async () => undefined),
}));
vi.mock("@/features/skills/api/skills", async (load) => ({
  ...(await load<typeof import("@/features/skills/api/skills")>()),
  listSkills: vi.fn(),
}));

const id = "loop-chat";
const session = {
  id,
  title: "Review",
  createdAt: "now",
  updatedAt: "now",
  messageCount: 2,
  executionTarget: {
    harnessId: "codex-acp",
    modelProviderId: "codex-acp",
    modelId: "fixture",
    modelName: "Fixture",
  },
};
const chat = () => useChatStore.getState();
const queue = (sid = id) => chat().queuedMessageBySession[sid] ?? [];
const list = () => getChatLoops(id);
const loop = () => list()[0];
// The operator's command, as the composer sends it.
const typed = { commandOrigin: "composer" } as const;
const command = (args = "") => dispatchPrompt(id, `/loop ${args}`, typed);
const advance = (delay = 0) => vi.advanceTimersByTimeAsync(delay);
const notices = () =>
  chat().messagesBySession[id]?.flatMap((m) =>
    m.content.flatMap((c) => (c.type === "systemNotification" ? [c.text] : [])),
  ) ?? [];
function fence(value: unknown) {
  return `\`\`\`flock-loop-state\n${JSON.stringify(value)}\n\`\`\``;
}
let dispose: () => void;

function sendHead() {
  const [head] = queue();
  expect(head).toBeDefined();
  return dispatchPrompt(id, head.payload.text, {
    ...head.payload.sendOptions,
    providerId: session.executionTarget.harnessId,
    onPromptDispatched: () => chat().dismissQueuedMessage(id, head.recordId),
  });
}

async function answer(reply = "OK", tokens = 0, stopReason = "end_turn") {
  vi.mocked(acpSendMessage).mockImplementationOnce(async (_id, _text, opts) => {
    opts?.onPromptDispatching?.();
    opts?.onPromptDispatched?.();
    if (tokens) recordSessionTokens(id, { mode: "add", totalTokens: tokens });
    chat().addMessage(id, { ...createUserMessage(reply), role: "assistant" });
    opts?.onPromptSettled?.(stopReason);
  });
  await sendHead();
  await advance();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  vi.clearAllMocks();
  await hydrateChatLoops();
  useChatLoopStore.setState({ loops: {} });
  useChatGoalStore.setState({ goals: {} });
  useChatSessionStore.setState({
    sessions: [session],
    hasHydratedSessions: true,
  });
  useChatStore.setState({
    hasHydratedMessageQueues: true,
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
  });
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  useMemoryStore.setState({ waveExecutorSessionIds: [] });
  setWaveEngineState(emptyWaveEngineState());
  resetUsageLedgerForTests();
  dispose = startChatAutomation();
});
afterEach(() => {
  dispose();
  clearAccountQuotaWait(id);
  vi.useRealTimers();
});

function registerChild() {
  useConductorGraphStore.setState({
    nodesById: {
      [id]: {
        sessionId: id,
        projectId: "p",
        rootConductorId: "parent",
        runId: "run",
        parentSessionId: "parent",
        managedBy: "agent-cli",
        role: "worker",
        displayName: "Worker",
        harnessId: "codex-acp",
        status: "completed",
      },
    },
  });
}

describe("local loop commands", () => {
  it("parses leading and trailing intervals, validates controls and caps each chat at five", async () => {
    for (const [unit, ms] of [
      ["s", 1000],
      ["m", MIN_DELAY],
      ["h", 60 * MIN_DELAY],
      ["d", DAY],
    ] as const)
      expect(parseLoopCommand(`2${unit} Review`)).toMatchObject({
        intervalMs: Math.max(MIN_DELAY, 2 * ms),
        prompt: "Review",
      });
    for (const [value, ms] of [
      ["60 seconds", MIN_DELAY],
      ["3 minutes", 3 * MIN_DELAY],
      ["1 hour", 60 * MIN_DELAY],
      ["2 days", 2 * DAY],
    ] as const)
      expect(parseLoopCommand(`Review every ${value}`)).toMatchObject({
        intervalMs: ms,
        prompt: "Review",
      });
    for (const args of [
      "stop",
      "stop 0",
      "list 3",
      "resume abc",
      "5m",
      "99999999999999999d Review",
    ])
      expect(parseLoopCommand(args).action).toBe("invalid");
    await command("2s Review");
    expect(notices().at(-1)).toContain("raised to 60");
    for (let i = 2; i <= 6; i++) await command(`Review ${i}`);
    expect(list()).toHaveLength(5);
    expect(notices().at(-1)).toContain("already has 5");
    for (const args of ["", "list"]) {
      await command(args);
      expect(notices().at(-1)).toContain("Loop 5");
    }
    await command("pause 2");
    expect(list().map((item) => item.status)).toEqual([
      "active",
      "paused",
      "active",
      "active",
      "active",
    ]);
    await command("pause");
    expect(list().every((item) => item.status === "paused")).toBe(true);
    await command("resume 3");
    expect(list()[2].status).toBe("active");
    await command("resume");
    expect(list().every((item) => item.status === "active")).toBe(true);
    await command("stop 1");
    expect(list().map((l) => l.number)).toEqual([2, 3, 4, 5]);
    await command("stop all");
    expect(list()).toEqual([]);
    expect(acpSendMessage).not.toHaveBeenCalled();
  });

  it("consumes a queued composer command, never steers it, and expands its skill using the target provider", async () => {
    chat().setChatState(id, "streaming");
    vi.mocked(listSkills).mockResolvedValueOnce([
      {
        id: "s",
        name: "review",
        instructions: "Check the fixture.",
        fileLocation: "review.md",
        description: "",
      } as SkillInfo,
    ]);
    const hook = renderHook(() => {
      const { sendMessage, chatState } = useChat(id);
      return useMessageQueue(id, chatState, sendMessage);
    });
    try {
      await act(async () => {
        await submitComposerMessage({
          text: "/loop 5m /review",
          attachments: [],
          skills: [],
          resolveSkillSlashCommand: () => null,
          onSend: hook.result.current.enqueue,
        });
      });
      expect(
        await steerPromptInSession(id, "/loop 5m /review", undefined, typed),
      ).toBe(false);
      expect(acpSteerMessage).not.toHaveBeenCalled();
      expect(list()).toEqual([]);
      await act(async () => {
        chat().setChatState(id, "idle");
        await advance();
      });
      expect(loop().prompt).toBe("/review");
      expect(acpSendMessage).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
    await answer();
    expect(acpSendMessage).toHaveBeenCalledTimes(1);
    expect(listSkills).toHaveBeenCalledWith([], { providerId: "codex-acp" });
    expect(vi.mocked(acpSendMessage).mock.calls[0][1]).toBe("/review");
    expect(
      vi.mocked(acpSendMessage).mock.calls[0][2]?.assistantPrompt,
    ).toContain("Use the review skill");
    expect(
      vi.mocked(acpSendMessage).mock.calls[0][2]?.assistantPrompt,
    ).toContain("Check the fixture.");
    expect(
      chat().messagesBySession[id].find((m) => m.role === "user")?.metadata
        ?.distillSenderLabel,
    ).toBe("Flock loop");
  });
});

it("coalesces deadlines mid-turn and waits behind the operator queue, then returns to the original cadence", async () => {
  await command("1m Sample");
  expect(queue()).toHaveLength(1);
  let finish!: () => void;
  vi.mocked(acpSendMessage).mockImplementationOnce(async (_id, _text, opts) => {
    opts?.onPromptDispatching?.();
    opts?.onPromptDispatched?.();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const sent = sendHead();
  await advance();
  chat().enqueueTransportReadyMessage(id, {
    text: "Operator first",
    persona: { kind: "inherit" },
  });
  await advance(2.5 * MIN_DELAY);
  expect(queue().map((r) => r.payload.text)).toEqual(["Operator first"]);
  expect(acpSendMessage).toHaveBeenCalledTimes(1);
  finish();
  await sent;
  await advance();
  expect(queue()).toHaveLength(1);
  await answer();
  expect(queue()).toHaveLength(1);
  await answer();
  expect(queue()).toEqual([]);
  expect(loop().runs).toBe(2);
  expect(loop().nextRunAt).toBe(loop().createdAt + 3 * MIN_DELAY);
  await advance(MIN_DELAY / 2 - 1);
  expect(queue()).toEqual([]);
  await advance(1);
  expect(queue()).toHaveLength(1);
});

it("withdraws a tick when operator input arrives during preparation, then schedules the due tick before a goal", async () => {
  await dispatchPrompt(id, "/goal Review", typed);
  expect(
    queue()[0].payload.sendOptions?.acpPromptMetadata?.flockGoalId,
  ).toBeTruthy();
  await command("1m Sample");
  await advance();
  const stale = queue()[0];
  expect(stale.payload.sendOptions?.acpPromptMetadata?.flockLoopId).toBe(
    loop().id,
  );
  chat().enqueueTransportReadyMessage(id, {
    text: "Operator",
    persona: { kind: "inherit" },
  });
  expect(() =>
    assertLoopDispatch(
      id,
      loop().id,
      stale.payload.sendOptions?.userMessageMetadata?.distillDeliveryId,
    ),
  ).toThrow();
  expect(queue().map((r) => r.payload.text)).toEqual(["Operator"]);
  await answer();
  expect(queue()[0].payload.sendOptions?.acpPromptMetadata?.flockLoopId).toBe(
    loop().id,
  );
  await answer();
  expect(
    queue()[0].payload.sendOptions?.acpPromptMetadata?.flockGoalId,
  ).toBeTruthy();
  expect(useChatGoalStore.getState().goals[id].turns).toBe(0);
});

it.each([
  [fence({ next: "5s" }), MIN_DELAY],
  [fence({ next: "42h" }), DAY],
  [fence({ next: "12m" }), 12 * MIN_DELAY],
  ["No fence", 10 * MIN_DELAY],
  [`${fence({ done: true, note: "ignore" })}\nmore`, 10 * MIN_DELAY],
] as const)("paces from the final reply %s", async (reply, delay) => {
  await command("Review");
  await answer(reply, 7);
  expect(loopCounters(id, loop())).toEqual({
    runs: 1,
    tokens: 7,
    nextRunAt: Date.now() + delay,
    expiresAt: loop().createdAt + 7 * DAY,
  });
  recordSessionTokens(id, { mode: "add", totalTokens: 123 });
  await advance(delay - 1);
  expect(queue()).toEqual([]);
  await advance(1);
  expect(loopCounters(id, loop()).tokens).toBe(7);
  await answer(fence({ done: true, note: "All clear" }));
  expect(list()).toEqual([]);
  expect(notices().at(-1)).toContain("All clear");
});

it("counts consecutive failed ticks only and pauses with the third reason", async () => {
  await command("1m Sample");
  for (const reason of [
    "refusal",
    "refusal",
    "end_turn",
    "refusal",
    "refusal",
  ]) {
    await answer("response", 2, reason);
    expect(loop().status).toBe("active");
    await advance(MIN_DELAY);
  }
  await answer("declined", 2, "refusal");
  expect(loop()).toMatchObject({
    status: "paused",
    failures: 3,
    runs: 6,
    tokens: 12,
    nextRunAt: null,
  });
  expect(loop().note).toContain("refusal");
  await advance(3 * MIN_DELAY);
  expect(queue()).toEqual([]);
  useChatLoopStore.getState().resume(id, loop().id);
  await advance();
  expect(loop().failures).toBe(0);
  expect(queue()).toHaveLength(1);
});

it("parks a zero-activity provider limit without charging a run or starting a sibling tick", async () => {
  await command("1m Sample");
  const first = queue()[0];
  const error = Object.assign(new Error("Try later"), {
    data: { kind: "provider_rate_limit_wait", promptNotAccepted: true },
  });
  vi.mocked(acpSendMessage).mockImplementationOnce(async (_id, _text, opts) => {
    opts?.onPromptDispatching?.();
    throw error;
  });
  await expect(sendHead()).rejects.toBe(error);
  await advance();
  expect(loop()).toMatchObject({ runs: 0, failures: 0, status: "active" });
  expect(queue()).toEqual([first]);
  expect(chat().getSessionRuntime(id).accountQuotaWaitUntil).not.toBeNull();
  clearAccountQuotaWait(id);
  await answer();
  expect(loop().runs).toBe(1);
});

it("settles ticks addressed to a legacy model-less shell as failures", async () => {
  useConductorGraphStore.setState({
    nodesById: {
      [id]: {
        sessionId: id,
        projectId: "p",
        rootConductorId: id,
        parentSessionId: null,
        runId: null,
        managedBy: "ui",
        role: "orchestrator",
        displayName: "Shell",
        harnessId: "codex-acp",
        status: "completed",
      },
    },
  });
  await command("1m Review");
  await sendHead();
  await advance();
  expect(loop()).toMatchObject({ runs: 1, failures: 1, pending: undefined });
  expect(queue()).toEqual([]);
  expect(acpSendMessage).not.toHaveBeenCalled();
});

it("counts a failed queued preparation once per deadline", async () => {
  await command("1m Review");
  for (let i = 1; i <= 3; i++) {
    const head = queue()[0];
    chat().deferTransportReadyMessage(id, head.recordId, {
      error: "Session unavailable",
    });
    await advance();
    expect(queue()[0]).toMatchObject({
      kind: "deferred",
      recordId: head.recordId,
    });
    expect(loop().failures).toBe(i);
    if (i < 3) await advance(MIN_DELAY);
  }
  expect(loop()).toMatchObject({ status: "paused", runs: 3 });
  expect(loop().note).toContain("Session unavailable");
  chat().enqueueTransportReadyMessage(id, {
    text: "Operator",
    persona: { kind: "inherit" },
  });
  await advance();
  expect(queue().map((record) => record.payload.text)).toEqual(["Operator"]);
});

it("Stop during a tick pauses only its owning loop", async () => {
  await command("1m Sample");
  await command("2m Other");
  let finish!: () => void;
  vi.mocked(acpSendMessage).mockImplementationOnce(async (_id, _text, opts) => {
    opts?.onPromptDispatching?.();
    opts?.onPromptDispatched?.();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const sent = sendHead();
  await advance();
  const hook = renderHook(() => useChat(id));
  try {
    await act(async () => {
      await hook.result.current.stopGeneration();
      finish();
      await sent;
    });
  } finally {
    hook.unmount();
  }
  expect(list().map((l) => l.status)).toEqual(["paused", "active"]);
  expect(loop().note).toContain("operator");
  expect(loop().pending).toBeUndefined();
});

it("withholds a due tick through a conductor hold and a live wave, then releases it once", async () => {
  useMemoryStore.setState({ waveExecutorSessionIds: [id] });
  await command("1m Refused");
  expect(list()).toEqual([]);
  expect(notices().at(-1)).toContain("Wave executors");
  useMemoryStore.setState({ waveExecutorSessionIds: [] });
  const empty = emptyWaveEngineState();
  const wave = createWaveState({
    waveId: "w",
    conductorSessionId: id,
    planMessageId: "p",
    createdAt: 1,
    steps: [],
  });
  setWaveEngineState({ ...empty, heldConductors: [id] });
  await command("1m Sample");
  await advance(2 * MIN_DELAY);
  expect(queue()).toEqual([]);
  setWaveEngineState({ ...empty, heldConductors: [id], waves: [wave] });
  await advance();
  expect(queue()).toEqual([]);
  setWaveEngineState({ ...empty, waves: [wave] });
  await advance();
  expect(queue()).toEqual([]);
  setWaveEngineState(empty);
  await advance();
  expect(queue()).toHaveLength(1);
  await answer();
  expect(queue()).toEqual([]);
});

it("rechecks the hold at the last reversible boundary of an already prepared tick", async () => {
  await command("1m Inspect");
  let release!: () => void;
  vi.mocked(acpSendMessage).mockImplementationOnce(async (_id, _text, opts) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    opts?.onPromptDispatching?.();
    opts?.onPromptDispatched?.();
  });
  const attempt = sendHead();
  await advance();
  setWaveEngineState({ ...emptyWaveEngineState(), heldConductors: [id] });
  release();
  await expect(attempt).rejects.toThrow("no longer accept");
  expect(loop()).toMatchObject({ runs: 0, failures: 0 });
  expect(chat().messagesBySession[id].filter((m) => m.role === "user")).toEqual(
    [],
  );
  await advance(MIN_DELAY);
  expect(queue()).toEqual([]);
  setWaveEngineState(emptyWaveEngineState());
  await advance();
  expect(queue()).toHaveLength(1);
});

it("expires active and paused loops at seven days even while the conductor is held", async () => {
  setWaveEngineState({ ...emptyWaveEngineState(), heldConductors: [id] });
  await command("1d Sample");
  await command("Other");
  await command("pause 2");
  await advance(7 * DAY - 1);
  expect(list()).toHaveLength(2);
  await advance(1);
  expect(list()).toEqual([]);
  expect(
    notices().filter((text) => text.includes("Expired seven days")),
  ).toHaveLength(2);
  expect(acpSendMessage).not.toHaveBeenCalled();
});

it("reports child pauses and endings once and keeps intermediate ticks out of the parent", async () => {
  registerChild();
  await command("1m Review");
  await answer();
  useConductorGraphStore
    .getState()
    .attachReport(parseStructuredReport("run", "completed", "intermediate"));
  publishTerminalGroupDigests(() => []);
  expect(queue("parent")).toEqual([]);
  const store = useChatLoopStore.getState();
  store.pause(id, loop().id);
  store.pause(id, loop().id);
  expect(queue("parent")).toHaveLength(1);
  expect(queue("parent")[0].payload.text).toContain("paused");
  store.resume(id, loop().id);
  await advance();
  await answer(fence({ done: true, note: "Checked" }));
  publishTerminalGroupDigests(() => []);
  expect(queue("parent").map((r) => r.payload.text)).toEqual([
    expect.stringContaining("paused"),
    expect.stringContaining("Checked"),
  ]);
});

it.each([
  "archive",
  "delete",
])("drops only the %s target's loops", async (action) => {
  await command("1m Sample");
  const store = useChatLoopStore.getState();
  store.start("other", "Keep");
  if (action === "archive")
    await useChatSessionStore.getState().archiveSession(id);
  else useChatSessionStore.getState().removeSession(id);
  expect(selectChatLoops(id)(useChatLoopStore.getState())).toEqual([]);
  expect(queue()).toEqual([]);
  expect(selectChatLoops("other")(useChatLoopStore.getState())[0].prompt).toBe(
    "Keep",
  );
});

it.each([
  false,
  true,
])("external Stop pauses only the running tick before cancellation settles (resume = %s)", async (resume) => {
  registerChild();
  await command("1m Sample");
  await command("2m Other");
  let finish!: () => void;
  vi.mocked(acpSendMessage).mockImplementationOnce(async (_id, _text, opts) => {
    opts?.onPromptDispatching?.();
    opts?.onPromptDispatched?.();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    opts?.onPromptSettled?.("cancelled");
  });
  const sent = sendHead();
  await advance();
  await stopOrchestratorSession(id);
  const statusAtStop = loop().status;
  if (resume) await command("resume 1");
  finish();
  await sent;
  expect(loop()).toMatchObject({
    status: resume ? "active" : "paused",
    failures: 0,
  });
  expect(statusAtStop).toBe("paused");
  expect(loop().nextRunAt).toBe(resume ? Date.now() : null);
  expect(list()[1].status).toBe("active");
});

it("posts one notice per loop command including bulk and repeated controls", async () => {
  for (const args of [
    "1m Review",
    "2m Check",
    "pause",
    "pause",
    "resume",
    "list",
    "stop all",
  ]) {
    const before = notices().length;
    await command(args);
    expect(notices().length - before, args).toBe(1);
  }
});

it.each([
  ["goal", "Objetivo de Flock"],
  ["loop", "Bucle de Flock"],
])("localizes the %s sender for the child turn and the parent report", async (kind, label) => {
  registerChild();
  try {
    await i18n.changeLanguage("es");
    await dispatchPrompt(id, `/${kind} Review`, typed);
    await advance();
    expect(
      queue()[0].payload.sendOptions?.userMessageMetadata?.distillSenderLabel,
    ).toBe(label);
    await dispatchPrompt(id, `/${kind} pause`, typed);
    expect(
      queue("parent")[0].payload.sendOptions?.userMessageMetadata
        ?.distillSenderLabel,
    ).toBe(label);
  } finally {
    await i18n.changeLanguage("en");
  }
});
