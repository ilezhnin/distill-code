import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getClient,
  invalidateClientConnection,
  setNotificationHandler,
} from "@/shared/api/acpConnection";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  getUsageLedger,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";
import handler, {
  acceptHistorySnapshot,
  beginHistorySnapshot,
  clearMessageTracking,
} from "../acpNotificationHandler";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "ws://invented-host/acp"),
}));
vi.mock("../acpWorkspaceObservation", () => ({
  clearWorkspaceToolCallObservations: vi.fn(),
  observeWorkspaceToolCall: vi.fn(),
}));

// The transport and SDK are real. Only the native host is replaced: usage
// must cross production WebSocket adaptation and Client.extNotification.
class FakeHostSocket extends EventTarget {
  static current: FakeHostSocket;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  constructor() {
    super();
    FakeHostSocket.current = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(data: string) {
    const message = JSON.parse(data) as { id: string; method: string };
    if (message.method !== "initialize") {
      throw new Error("unexpected host request");
    }
    this.receive({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
  }
  receive(frame: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }
  close() {
    this.readyState = FakeHostSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const standardUpdate = vi.fn(handler.handleSessionNotification);
const messageUsage = vi.fn(handler.handleMessageUsageNotification);

function notification(sessionId: string, update: object) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  };
}

function delta(sessionId: string, eventId = 1, meta = {}) {
  return notification(sessionId, {
    sessionUpdate: "message_usage",
    usage: {
      inputTokens: 40,
      outputTokens: 9,
      cacheReadTokens: 300,
      cacheWriteTokens: 7,
      elapsedMs: 120,
    },
    _meta: {
      ...meta,
      xaiTurnUsage: { costUsdTicks: 5, costComplete: false },
      distill: { eventId, runId: `invented-run-${eventId}` },
    },
  });
}

async function deliver(...events: unknown[]) {
  const next = standardUpdate.mock.calls.length + 1;
  FakeHostSocket.current.receive([
    ...events,
    notification("delivery-marker", { sessionUpdate: "session_info_update" }),
  ]);
  await vi.waitFor(() => expect(standardUpdate).toHaveBeenCalledTimes(next));
}

beforeEach(async () => {
  vi.stubGlobal("WebSocket", FakeHostSocket);
  vi.spyOn(console, "error").mockImplementation(() => {});
  standardUpdate.mockClear();
  messageUsage.mockClear();
  resetUsageLedgerForTests();
  clearMessageTracking();
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    loadingSessionIds: new Set(),
  });
  useChatSessionStore.setState({ sessions: [] });
  setNotificationHandler({
    ...handler,
    handleSessionNotification: standardUpdate,
    handleMessageUsageNotification: messageUsage,
  });
  await getClient();
});

afterEach(async () => {
  await invalidateClientConnection();
  setNotificationHandler(handler);
  vi.unstubAllGlobals();
});

it("delivers per-turn deltas through the real SDK without inventing context or raw xAI cost", async () => {
  await deliver(delta("live-usage", 1), delta("live-usage", 2));
  expect(messageUsage).toHaveBeenCalledTimes(2);
  expect(getUsageLedger().sessions["live-usage"]).toMatchObject({
    inputTokens: 80,
    outputTokens: 18,
    cacheTokens: 614,
    totalTokens: 712,
    turns: 2,
    workedMs: 240,
    costUsd: null,
  });
  expect(
    useChatStore.getState().sessionStateById["live-usage"]?.tokenState,
  ).toBeUndefined();
  expect(messageUsage.mock.calls[0][0].update._meta).toMatchObject({
    distill: { eventId: 1, runId: "invented-run-1" },
    xaiTurnUsage: { costUsdTicks: 5, costComplete: false },
  });
  expect(console.error).not.toHaveBeenCalled();
});

it("keeps standard context and cumulative cost on the SDK session-update path", async () => {
  const update = {
    sessionUpdate: "usage_update",
    used: 50,
    size: 2000,
    cost: { amount: 0.25, currency: "USD" },
    _meta: {
      distill: { accumulatedInputTokens: 30, accumulatedOutputTokens: 10 },
    },
  };
  // Use single frames too: adaptation must not depend on replay batching.
  FakeHostSocket.current.receive(notification("cumulative-usage", update));
  await vi.waitFor(() => expect(standardUpdate).toHaveBeenCalledTimes(1));
  FakeHostSocket.current.receive(notification("cumulative-usage", update));
  await vi.waitFor(() => expect(standardUpdate).toHaveBeenCalledTimes(2));
  expect(messageUsage).not.toHaveBeenCalled();
  expect(getUsageLedger().sessions["cumulative-usage"]).toMatchObject({
    inputTokens: 30,
    outputTokens: 10,
    costUsd: 0.25,
  });
  expect(
    useChatStore.getState().sessionStateById["cumulative-usage"]?.tokenState,
  ).toMatchObject({
    accumulatedTotal: 50,
    accumulatedCost: 0.25,
  });
  expect(console.error).not.toHaveBeenCalled();
});

it("does not add replayed deltas, but accounts for live arrivals during a history snapshot once", async () => {
  const sessionId = "history-usage";
  await deliver(delta(sessionId, 1));
  useChatStore.getState().setSessionLoading(sessionId, true);
  await deliver(delta(sessionId, 1));
  expect(getUsageLedger().sessions[sessionId].turns).toBe(1);

  beginHistorySnapshot(sessionId);
  await deliver(delta(sessionId, 11));
  expect(getUsageLedger().sessions[sessionId].turns).toBe(2);
  await acceptHistorySnapshot(sessionId, {
    events: [],
    olderCursor: null,
    highWaterEventId: 10,
  });
  useChatStore.getState().setSessionLoading(sessionId, false);
  await deliver(delta(sessionId, 10));
  expect(getUsageLedger().sessions[sessionId].turns).toBe(2);
  await deliver(delta(sessionId, 12));
  expect(getUsageLedger().sessions[sessionId]).toMatchObject({
    turns: 3,
    inputTokens: 120,
    workedMs: 360,
  });
  expect(console.error).not.toHaveBeenCalled();
});

it.each([
  "update",
  "notification",
] as const)("preserves %s benchmark ownership before hydration and excludes duplicate live accounting", async (location) => {
  const sessionId = `benchmark-usage-${location}`;
  const owner = { kind: "benchmark", id: "invented-attempt" };
  const event = delta(
    sessionId,
    1,
    location === "update" ? { executionOwner: owner } : {},
  );
  const params =
    location === "notification"
      ? { ...event.params, _meta: { executionOwner: owner } }
      : event.params;
  await deliver({ ...event, params });
  expect(messageUsage).toHaveBeenCalledOnce();
  expect(getUsageLedger().sessions[sessionId]).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
});

it("rejects malformed deltas while retaining the SDK rejection of unknown and invalid standard updates", async () => {
  const invalid = [
    { sessionUpdate: "message_usage", usage: {} },
    { sessionUpdate: "message_usage", usage: { inputTokens: -1 } },
    { sessionUpdate: "message_usage", usage: { inputTokens: "10" } },
    { sessionUpdate: "message_usage", usage: { unrecognized: 10 } },
    { sessionUpdate: "usage_update", used: 10 },
    { sessionUpdate: "invented_unknown_update", usage: { inputTokens: 10 } },
  ];
  await deliver(
    ...invalid.map((update) => notification("invalid-usage", update)),
  );
  expect(messageUsage).not.toHaveBeenCalled();
  expect(getUsageLedger().sessions["invalid-usage"]).toBeUndefined();
  expect(console.error).toHaveBeenCalledTimes(invalid.length);
});
