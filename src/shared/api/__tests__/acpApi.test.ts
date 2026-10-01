import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  listSessions: vi.fn(),
  unstableForkSession: vi.fn(),
  newSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
  extMethod: vi.fn(),
}));

function createConfigOptionsResponse() {
  return {
    configOptions: [
      {
        id: "model",
        category: "model",
        kind: {
          type: "select",
          currentValue: "claude-opus-4-8",
          options: {
            type: "ungrouped",
            values: [{ value: "claude-opus-4-8", name: "Claude Opus 4.8" }],
          },
        },
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        kind: {
          type: "select",
          currentValue: "high",
          options: {
            type: "ungrouped",
            values: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        },
      },
    ],
  };
}

vi.mock("../acpConnection", () => ({
  getClient: (...args: unknown[]) => mocks.getClient(...args),
  trackPendingPrompt: <T>(prompt: Promise<T>) => prompt,
}));

it("opts into bounded history batches while retaining the normal ACP load response", async () => {
  const response = createConfigOptionsResponse();
  const load = vi.fn().mockResolvedValue(response);
  mocks.getClient.mockResolvedValue({ loadSession: load });
  const { loadSession } = await import("../acpApi");
  await expect(loadSession("s", "/project")).resolves.toBe(response);
  expect(load).toHaveBeenCalledWith({
    sessionId: "s",
    cwd: "/project",
    mcpServers: [],
    _meta: { distill: { replayBatch: true } },
  });
});

describe("prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acknowledges transport only around the real client prompt invocation", async () => {
    const order: string[] = [];
    const clientPrompt = vi.fn(() => {
      order.push("client.prompt");
      return Promise.resolve({ stopReason: "end_turn" });
    });
    mocks.getClient.mockImplementation(async () => {
      order.push("getClient");
      return {
        prompt: clientPrompt,
        host: {
          sessionPrepareAccount: async () => {
            order.push("account.ready");
          },
        },
      };
    });
    const { prompt } = await import("../acpApi");

    await prompt("session-1", [{ type: "text", text: "hello" }], undefined, {
      onPromptDispatching: () => order.push("dispatching"),
      onPromptDispatched: () => order.push("dispatched"),
    });

    expect(order).toEqual([
      "getClient",
      "account.ready",
      "dispatching",
      "client.prompt",
      "dispatched",
    ]);
  });

  it("does not acknowledge transport when client acquisition fails", async () => {
    const onPromptDispatching = vi.fn();
    const onPromptDispatched = vi.fn();
    mocks.getClient.mockRejectedValueOnce(new Error("client unavailable"));
    const { prompt } = await import("../acpApi");

    await expect(
      prompt("session-1", [{ type: "text", text: "hello" }], undefined, {
        onPromptDispatching,
        onPromptDispatched,
      }),
    ).rejects.toThrow("client unavailable");
    expect(onPromptDispatching).not.toHaveBeenCalled();
    expect(onPromptDispatched).not.toHaveBeenCalled();
  });

  it("keeps quota waits before dispatch callbacks and prompt transport", async () => {
    const wait = {
      code: -32010,
      data: { kind: "account_quota_wait", dispatchStarted: false },
    };
    const clientPrompt = vi.fn();
    const dispatching = vi.fn();
    const dispatched = vi.fn();
    mocks.getClient.mockResolvedValue({
      prompt: clientPrompt,
      host: { sessionPrepareAccount: vi.fn().mockRejectedValue(wait) },
    });
    const { prompt } = await import("../acpApi");
    await expect(
      prompt("session-1", [], undefined, {
        onPromptDispatching: dispatching,
        onPromptDispatched: dispatched,
      }),
    ).rejects.toBe(wait);
    expect(clientPrompt).not.toHaveBeenCalled();
    expect(dispatching).not.toHaveBeenCalled();
    expect(dispatched).not.toHaveBeenCalled();
  });
});

describe("listSessionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      listSessions: mocks.listSessions,
      unstable_forkSession: mocks.unstableForkSession,
    });
  });

  it("preserves explicit active-run metadata and omits unknown state", async () => {
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: "active-session",
          title: null,
          updatedAt: null,
          cwd: "/tmp/active",
          _meta: { activeRunId: "run-1" },
        },
        {
          sessionId: "settled-session",
          title: null,
          updatedAt: null,
          cwd: "/tmp/settled",
          _meta: { activeRunId: null },
        },
        {
          sessionId: "unknown-session",
          title: null,
          updatedAt: null,
          cwd: "/tmp/unknown",
          _meta: {},
        },
      ],
      nextCursor: null,
    });

    const { listSessionsPage } = await import("../acpApi");
    const page = await listSessionsPage();

    expect(page.sessions[0]).toHaveProperty("activeRunId", "run-1");
    expect(page.sessions[1]).toHaveProperty("activeRunId", null);
    expect(page.sessions[2]).not.toHaveProperty("activeRunId");
  });
});

describe("forkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      listSessions: mocks.listSessions,
      unstable_forkSession: mocks.unstableForkSession,
    });
  });

  it("includes conversationBefore metadata for truncated forks", async () => {
    mocks.unstableForkSession.mockResolvedValueOnce({
      sessionId: "session-2",
      _meta: {},
    });

    const { forkSession } = await import("../acpApi");

    await forkSession("session-1", "/tmp/project", {
      conversationBefore: 1_700_000_123,
    });

    expect(mocks.unstableForkSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { conversationBefore: 1_700_000_123 },
    });
  });
});

it("prefers an exact fork message boundary over legacy seconds", async () => {
  vi.clearAllMocks();
  mocks.getClient.mockResolvedValue({
    unstable_forkSession: mocks.unstableForkSession,
  });
  mocks.unstableForkSession.mockResolvedValueOnce({
    sessionId: "fork",
    _meta: {},
  });
  const { forkSession } = await import("../acpApi");
  const target = { messageId: "reply-1", role: "assistant" as const };
  await forkSession("source", "/project", {
    conversationThrough: target,
    conversationBefore: 1_700_000_123,
  });
  expect(mocks.unstableForkSession).toHaveBeenCalledWith({
    sessionId: "source",
    cwd: "/project",
    mcpServers: [],
    _meta: { conversationThrough: target },
  });
});

describe("steerSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      host: { sessionSteer: mocks.extMethod },
    });
  });

  it("keeps the delivery message id when retrying with the actual run", async () => {
    mocks.extMethod
      .mockRejectedValueOnce({ data: { actualRunId: "run-2" } })
      .mockResolvedValueOnce({
        runId: "run-2",
        messageId: "steer-message",
      });

    const { steerSession } = await import("../acpApi");

    await expect(
      steerSession(
        "session-1",
        [{ type: "text", text: "make it shorter" }],
        "run-1",
      ),
    ).resolves.toEqual({ runId: "run-2", messageId: "steer-message" });
    expect(mocks.extMethod).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "make it shorter" }],
      expectedRunId: "run-2",
    });
  });
});
