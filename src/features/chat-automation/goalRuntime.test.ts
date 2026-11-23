import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChat } from "@/features/chat/hooks/useChat";
import { useMessageQueue } from "@/features/chat/hooks/useMessageQueue";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { submitComposerMessage } from "@/features/chat/lib/submitComposerMessage";
import { buildSkillSendPayload } from "@/features/chat/lib/skillSendPayload";
import { dispatchPrompt } from "@/features/chat/lib/sendCore";
import { steerPromptInSession } from "@/features/chat/lib/steerCore";
import { clearAccountQuotaWait } from "@/features/chat/lib/accountQuotaWait";
import { resolveSkillSlashCommand } from "@/features/skills/lib/skillChatPrompt";
import { createUserMessage, getTextContent } from "@/shared/types/messages";
import { acpSendMessage, acpSteerMessage } from "@/shared/api/acp";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import {
  emptyWaveEngineState,
  setWaveEngineState,
} from "@/features/conductor/waveStore";
import { createWaveState } from "@/features/conductor/waveEngine";
import {
  recordSessionTokens,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";
import {
  getChatGoal,
  goalCounters,
  hydrateChatGoals,
  selectChatGoal,
  useChatGoalStore,
} from "./goalStore";
import {
  assertGoalDispatch,
  startChatAutomation,
  tickChatGoal,
} from "./goalRuntime";
import {
  automationCommand,
  goalPrompt,
  goalReply,
  parseGoalCommand,
} from "./commands";

vi.mock("@/features/chat/lib/chatExecutorDispatch", async (load) => ({
  ...(await load<typeof import("@/features/chat/lib/chatExecutorDispatch")>()),
  prepareChatExecutorDispatch: vi.fn(async () => undefined),
}));
vi.mock("@/shared/api/acp", async (load) => ({
  ...(await load<typeof import("@/shared/api/acp")>()),
  acpSendMessage: vi.fn(),
  acpSteerMessage: vi.fn(),
  acpCancelSession: vi.fn(async () => undefined),
  acpPrepareSessionAccount: vi.fn(async () => undefined),
}));
vi.mock("@/shared/api/acpApi", async (load) => ({
  ...(await load<typeof import("@/shared/api/acpApi")>()),
  archiveSession: vi.fn(async () => undefined),
}));

const id = "fixture-chat";
const session = {
  id,
  title: "Review",
  createdAt: "now",
  updatedAt: "now",
  messageCount: 1,
  executionTarget: {
    harnessId: "codex-acp",
    modelProviderId: "codex-acp",
    modelId: "fixture",
    modelName: "Fixture",
  },
};
const queue = (sid = id) =>
  useChatStore.getState().queuedMessageBySession[sid] ?? [];
const chat = () => useChatStore.getState();
const goal = () => getChatGoal(id);
const command = (text: string) =>
  dispatchPrompt(id, `/goal${text ? ` ${text}` : ""}`, {});
const fence = (status: string, note = "progress") =>
  `\`\`\`flock-goal-state\n${JSON.stringify({ status, note })}\n\`\`\``;
const notices = () =>
  chat().messagesBySession[id]?.flatMap((m) =>
    m.content.flatMap((c) => (c.type === "systemNotification" ? [c.text] : [])),
  ) ?? [];

function respond(text = "working", reason = "end_turn") {
  vi.mocked(acpSendMessage).mockImplementationOnce(
    async (sid, _prompt, options) => {
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
      chat().addMessage(sid, { ...createUserMessage(text), role: "assistant" });
      options?.onPromptSettled?.(reason);
    },
  );
}
async function runQueued() {
  const [head] = queue();
  expect(head).toBeDefined();
  return dispatchPrompt(id, head.payload.text, {
    ...head.payload.sendOptions,
    onPromptDispatched: () => {
      chat().dismissQueuedMessage(id, head.recordId);
    },
  });
}
let dispose: (() => void) | undefined;
beforeEach(async () => {
  vi.clearAllMocks();
  await hydrateChatGoals();
  useChatGoalStore.setState({ goals: {} });
  useChatSessionStore.setState({
    sessions: [session],
    hasHydratedSessions: true,
  });
  useChatStore.setState({
    hasHydratedMessageQueues: true,
    sessionStateById: {},
    messagesBySession: {},
    queuedMessageBySession: {},
  });
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  useMemoryStore.setState({ waveExecutorSessionIds: [] });
  setWaveEngineState(emptyWaveEngineState());
  resetUsageLedgerForTests();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  clearAccountQuotaWait(id);
  vi.useRealTimers();
});

it("recognizes only a leading command, reserves both skill names, and validates limits", () => {
  expect(automationCommand("say /goal status")).toBeNull();
  expect(automationCommand("/goalkeeper x")).toBeNull();
  expect(automationCommand("/GOAL\nwork")).toEqual({
    name: "goal",
    args: "work",
  });
  for (const name of ["goal", "loop", "sample"]) {
    expect(Boolean(resolveSkillSlashCommand(`/${name}`, [{ name }]))).toBe(
      name === "sample",
    );
  }
  const skill = {
    id: "fixture-skill",
    name: "sample",
    description: "",
    instructions: "Work carefully.",
    fileLocation: "sample.md",
  };
  const nested = buildSkillSendPayload(
    "/sample /goal nested",
    [],
    resolveSkillSlashCommand("/sample /goal nested", [skill]),
  );
  expect(automationCommand(nested.messageText)).toBeNull();
  expect(nested.messageText).toContain("/goal nested");
  expect(parseGoalCommand("do work")).toMatchObject({ maxTurns: 30 });
  expect(parseGoalCommand("do work --budget 90 --max-turns 200")).toMatchObject(
    { maxTurns: 200, budget: 90 },
  );
  for (const args of [
    "do --max-turns 201",
    "do --budget -1",
    "do --max-turns",
    "do --budget 1.5",
    "--max-turns 2",
  ]) {
    expect(parseGoalCommand(args).action).toBe("invalid");
  }
});

it("drains a composer command in FIFO order without sending or steering it to ACP", async () => {
  chat().setChatState(id, "streaming");
  respond();
  const hook = renderHook(() => {
    const { sendMessage, chatState } = useChat(id);
    return useMessageQueue(id, chatState, sendMessage);
  });
  async function submit(text: string) {
    await act(async () => {
      await submitComposerMessage({
        text,
        attachments: [],
        skills: [],
        resolveSkillSlashCommand: () => null,
        onSend: hook.result.current.enqueue,
      });
    });
  }
  await submit("First input");
  await submit("/goal Second input");
  expect(goal()).toBeUndefined();
  expect(queue().map((r) => r.payload.text)).toEqual([
    "First input",
    "/goal Second input",
  ]);
  expect(await steerPromptInSession(id, "/goal Second input")).toBe(false);
  expect(acpSteerMessage).not.toHaveBeenCalled();
  act(() => chat().setChatState(id, "idle"));
  await waitFor(() => expect(goal()?.objective).toBe("Second input"));
  expect(vi.mocked(acpSendMessage).mock.calls.map((call) => call[1])).toEqual([
    "First input",
  ]);
  hook.unmount();
});

it("accepts every control locally and shows replacement, status and empty notices", async () => {
  dispose = startChatAutomation();
  const control = async (args: string) => {
    const before = notices().length;
    await command(args);
    expect(notices().length - before, args).toBe(1);
  };
  await control("first");
  await control("second");
  expect(notices().at(-1)).toMatch(/Replaced.*second/);
  await control("pause");
  expect(goal()?.status).toBe("paused");
  await control("resume");
  expect(goal()?.status).toBe("active");
  for (const status of ["", "status"]) {
    await control(status);
    expect(notices().at(-1)).toContain("Goal active: second");
  }
  await control("clear");
  await control("");
  expect(notices().at(-1)).toContain("no goal");
  expect(goal()).toBeUndefined();
  expect(acpSendMessage).not.toHaveBeenCalled();
});

it("repeats the objective and terminal fence across turns, reads only the final fence", async () => {
  dispose = startChatAutomation();
  await command("/fix the fixture");
  useChatSessionStore.getState().patchSession(id, { title: "New chat" });
  const prompt = goalPrompt("/fix the fixture");
  expect(prompt).toContain("/fix the fixture");
  expect(prompt).toContain("flock-goal-state");
  expect(prompt.startsWith("/")).toBe(false);
  for (const text of [
    "no state",
    `${fence("reached")}\nmore`,
    fence("continue"),
  ]) {
    expect(queue()[0].payload.text).toBe(prompt);
    respond(text);
    await runQueued();
    expect(goal()?.status).toBe("active");
  }
  respond(fence("reached", "fixed"));
  await runQueued();
  expect(useChatSessionStore.getState().getSession(id)?.title).toBe(
    "/fix the fixture",
  );
  for (const [, text, options] of vi.mocked(acpSendMessage).mock.calls) {
    expect(text).toBe("/fix the fixture");
    expect(options?.assistantPrompt).toContain("flock-goal-state");
  }
  expect(goal()).toMatchObject({ status: "reached", turns: 4, note: "fixed" });
  expect(notices()).toHaveLength(2);
  expect(queue()).toHaveLength(0);
  for (const message of chat().messagesBySession[id].filter(
    (m) => m.role === "user",
  )) {
    expect(getTextContent(message)).toBe(prompt);
    expect(message.metadata).toMatchObject({
      origin: "distillctl_cross_session",
      distillSenderLabel: "Flock goal",
    });
  }
  expect(goalReply(fence("invented"))).toBeNull();
});

it("lets the operator take the queue during preparation and reads that turn's state", async () => {
  dispose = startChatAutomation();
  await command("review");
  const stale = queue()[0];
  chat().enqueueTransportReadyMessage(id, {
    text: "Use this fixture",
    persona: { kind: "inherit" },
  });
  expect(() =>
    assertGoalDispatch(
      id,
      stale.payload.sendOptions?.acpPromptMetadata?.flockGoalId,
    ),
  ).toThrow();
  expect(queue().map((r) => r.payload.text)).toEqual(["Use this fixture"]);
  respond(fence("blocked", "need the sample"));
  await runQueued();
  expect(goal()).toMatchObject({
    status: "paused",
    note: "need the sample",
    turns: 0,
  });
  expect(queue()).toHaveLength(0);
});

it("waits for a pending direct dispatch even before its user turn starts", async () => {
  const { acquireSessionDispatchTarget } = await import(
    "@/features/chat/lib/sessionTargetCoordinator"
  );
  const lease = acquireSessionDispatchTarget(id);
  if (lease.status !== "acquired")
    throw new Error("Expected the direct sender's lease");
  dispose = startChatAutomation();
  await command("review");
  expect(queue()).toEqual([]);
  lease.release();
  await waitFor(() => expect(queue()).toHaveLength(1));
});

it("pauses at the turn cap and resumes with a fresh allowance, preserving totals", async () => {
  dispose = startChatAutomation();
  await command("review --max-turns 1");
  respond();
  await runQueued();
  expect(goal()).toMatchObject({ status: "paused", turns: 1 });
  expect(notices()).toHaveLength(2);
  expect(queue()).toHaveLength(0);
  useChatGoalStore.getState().resume(id);
  await Promise.resolve();
  expect(queue()).toHaveLength(1);
  respond();
  await runQueued();
  expect(selectChatGoal(id)(useChatGoalStore.getState())).toMatchObject({
    status: "paused",
    turns: 2,
  });
});

it("measures the active interval against the existing usage ledger", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  recordSessionTokens(id, { mode: "add", totalTokens: 100 });
  dispose = startChatAutomation();
  await command("review --budget 12");
  vi.setSystemTime(now + 2000);
  vi.mocked(acpSendMessage).mockImplementationOnce(
    async (_id, _prompt, options) => {
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
      recordSessionTokens(id, { mode: "add", totalTokens: 12 });
    },
  );
  await runQueued();
  expect(goal()?.note).toContain("12 tokens");
  vi.setSystemTime(now + 8000);
  recordSessionTokens(id, { mode: "add", totalTokens: 5 });
  const paused = goal();
  if (!paused) throw new Error("Expected the paused goal");
  expect(goalCounters(id, paused)).toEqual({
    turns: 1,
    elapsedMs: 2000,
    tokens: 12,
  });
});

it.each([
  "refusal",
  "provider error",
  "allowance",
  "rate limit",
])("classifies %s at the transport boundary", async (mode) => {
  dispose = startChatAutomation();
  await command("review");
  if (mode === "refusal") {
    respond("declined", "refusal");
    await runQueued();
  } else {
    const data =
      mode === "rate limit"
        ? { kind: "provider_rate_limit_wait", promptNotAccepted: true }
        : mode === "allowance"
          ? { kind: "account_quota_wait", promptNotAccepted: true }
          : {};
    const error = Object.assign(new Error(mode), { data });
    vi.mocked(acpSendMessage).mockImplementationOnce(
      async (_sid, _text, options) => {
        options?.onPromptDispatching?.();
        throw error;
      },
    );
    await expect(runQueued()).rejects.toBe(error);
  }
  expect(goal()?.status).toBe(mode === "rate limit" ? "active" : "paused");
  if (mode === "rate limit") {
    expect(goal()?.turns).toBe(0);
    expect(queue()).toHaveLength(1);
    expect(chat().getSessionRuntime(id).accountQuotaWaitUntil).not.toBeNull();
  } else expect(goal()?.note.toLowerCase()).toContain(mode);
});

it("Stop during an automated turn pauses the goal before ACP can settle it", async () => {
  dispose = startChatAutomation();
  await command("review");
  let finish!: () => void;
  vi.mocked(acpSendMessage).mockImplementationOnce(
    async (_id, _text, options) => {
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  const sent = runQueued();
  await waitFor(() => expect(finish).toBeDefined());
  const hook = renderHook(() => useChat(id));
  await act(async () => {
    await hook.result.current.stopGeneration();
    finish();
    await sent;
  });
  expect(goal()).toMatchObject({
    status: "paused",
    note: "Stopped by the operator.",
  });
  expect(queue()).toHaveLength(0);
  hook.unmount();
});

it("refuses executor and roadmap goals and wakes only after both live wave and hold clear", async () => {
  const waves = emptyWaveEngineState();
  useMemoryStore.setState({ waveExecutorSessionIds: [id] });
  await command("work");
  expect(notices().at(-1)).toContain("Wave executors");
  expect(goal()).toBeUndefined();
  useMemoryStore.setState({ waveExecutorSessionIds: [] });
  setWaveEngineState({
    ...waves,
    roadmaps: {
      [id]: {
        conductorSessionId: id,
        goal: "roadmap",
        status: "in-progress",
        stages: [],
        updatedAt: 0,
        sourceMessageId: "m",
        sourceCreatedAt: 0,
        continueTurns: 0,
      },
    },
  });
  await command("work");
  expect(notices().at(-1)).toContain("roadmap");
  expect(goal()).toBeUndefined();
  const live = createWaveState({
    waveId: "wave",
    conductorSessionId: id,
    planMessageId: "p",
    createdAt: 1,
    steps: [],
  });
  setWaveEngineState({ ...waves, waves: [live], heldConductors: [id] });
  dispose = startChatAutomation();
  await command("work");
  expect(queue()).toHaveLength(0);
  setWaveEngineState({ ...waves, waves: [live] });
  await Promise.resolve();
  expect(queue()).toHaveLength(0);
  setWaveEngineState({ ...waves, heldConductors: [id] });
  await Promise.resolve();
  expect(queue()).toHaveLength(0);
  setWaveEngineState(waves);
  await Promise.resolve();
  expect(queue()).toHaveLength(1);
});

it.each([
  "reached",
  "blocked",
])("reports the child's %s transition once to its parent", async (status) => {
  useConductorGraphStore.setState({
    nodesById: {
      [id]: {
        sessionId: id,
        projectId: "sample-project",
        rootConductorId: "parent",
        runId: "child-run",
        parentSessionId: "parent",
        managedBy: "agent-cli",
        role: "worker",
        displayName: "worker",
        harnessId: "codex-acp",
        status: "completed",
      },
    },
  });
  dispose = startChatAutomation();
  await command("work");
  respond(fence("continue"));
  await runQueued();
  const { publishTerminalGroupDigests } = await import(
    "@/features/conductor/digestPublisher"
  );
  const { parseStructuredReport } = await import(
    "@/features/conductor/orchestratorReport"
  );
  useConductorGraphStore
    .getState()
    .attachReport(
      parseStructuredReport("child-run", "completed", "intermediate"),
    );
  publishTerminalGroupDigests(() => []);
  expect(queue("parent")).toHaveLength(0);
  expect(
    useConductorGraphStore.getState().getReport("child-run")?.publishedToParent,
  ).toBeFalsy();
  respond(fence(status, "fixture summary"));
  await runQueued();
  tickChatGoal(id);
  tickChatGoal(id);
  expect(
    useConductorGraphStore.getState().getReport("child-run")?.publishedToParent,
  ).toBe(true);
  useChatGoalStore.getState().clear(id);
  publishTerminalGroupDigests(() => []);
  expect(queue("parent").map((r) => r.payload.text)).toEqual([
    expect.stringContaining("fixture summary"),
  ]);
});

it.each([
  "archive",
  "delete",
])("drops the goal on %s and preserves another chat's goal", async (action) => {
  await command("work");
  useChatGoalStore.getState().start("other", "keep", 30);
  if (action === "archive")
    await useChatSessionStore.getState().archiveSession(id);
  else useChatSessionStore.getState().removeSession(id);
  expect(goal()).toBeUndefined();
  expect(getChatGoal("other")?.objective).toBe("keep");
});
