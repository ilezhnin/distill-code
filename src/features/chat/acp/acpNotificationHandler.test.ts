import { beforeEach, describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { clearReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import {
  clearMessageTracking,
  handleSessionNotification,
} from "./acpNotificationHandler";
import {
  getUsageLedger,
  resetUsageLedgerForTests,
} from "@/features/stats/lib/usageLedger";

describe("acpNotificationHandler", () => {
  beforeEach(() => {
    resetUsageLedgerForTests();
    clearMessageTracking();
    clearReplayBuffer("acp-session-1");
    clearReplayBuffer("acp-session-2");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
      loadingSessionIds: new Set<string>(),
      scrollTargetMessageBySession: {},
    });
  });

  it("applies usage updates to the ACP session id", async () => {
    const notification = {
      sessionId: "acp-session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 512,
        size: 8192,
      },
    } as SessionNotification;

    await handleSessionNotification(notification);

    const runtime = useChatStore.getState().getSessionRuntime("acp-session-1");
    expect(runtime.tokenState.accumulatedTotal).toBe(512);
    expect(runtime.tokenState.contextLimit).toBe(8192);
    expect(runtime.hasUsageSnapshot).toBe(true);
  });

  it("records goose accumulated tokens in the usage ledger", async () => {
    const notification = {
      sessionId: "acp-session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 512,
        size: 8192,
        accumulatedInputTokens: 400,
        accumulatedOutputTokens: 80,
        cost: { amount: 0.25 },
      },
    } as never;

    await handleSessionNotification(notification);

    const session = getUsageLedger().sessions["acp-session-1"];
    expect(session?.inputTokens).toBe(400);
    expect(session?.outputTokens).toBe(80);
    expect(session?.totalTokens).toBe(480);
    expect(session?.costUsd).toBe(0.25);
  });
});
