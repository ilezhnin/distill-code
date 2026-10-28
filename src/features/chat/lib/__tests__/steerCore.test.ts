import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { MAX_PROMPT_ATTACHMENT_BYTES } from "../attachmentPayloadBudget";

const mockAcpSteerMessage = vi.fn();

vi.mock("@/shared/api/acp", () => ({
  acpSteerMessage: (...args: unknown[]) => mockAcpSteerMessage(...args),
}));

vi.mock("@/shared/i18n", () => ({
  i18n: {
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  },
}));

import { steerPromptInSession } from "../steerCore";

function oversizedImageDraft() {
  return {
    id: "image-1",
    kind: "image" as const,
    name: "huge.jpeg",
    mimeType: "image/jpeg",
    base64: "x".repeat(MAX_PROMPT_ATTACHMENT_BYTES + 1),
    previewUrl: "blob:huge",
  };
}

describe("steerPromptInSession payload budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      activeSessionId: null,
      isConnected: true,
    });
  });

  it("rejects an over-budget steer before committing anything", async () => {
    // Discriminating test for the steer-side budget guard: non-composer
    // callers (flockctl, queued steers) reach steerPromptInSession directly,
    // where an oversized ACP message would silently kill the shared
    // WebSocket and every open chat with it (BOT-1463). Pre-guard code
    // commits the user message and calls acpSteerMessage; guarded code
    // must do neither.
    const accepted = await steerPromptInSession("session-1", "look at this", [
      oversizedImageDraft(),
    ]);

    expect(accepted).toBe(false);
    expect(mockAcpSteerMessage).not.toHaveBeenCalled();

    // The failure is visible, not silent: a system error notification is
    // the only message added — no user message lands in the transcript.
    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).not.toBe("user");
    expect(messages[0].content[0]).toMatchObject({
      text: expect.stringContaining("errors.attachmentsTooLarge"),
    });
  });
});

// A steer's user-message append is provisional until the backend acknowledges
// it, so the ChatSendOptions commit callback — the anchor `flock_chat` send
// telemetry rides on — must fire exactly at the durable commit: never at the
// append, never for a rolled-back steer, and still for a steer whose delivery
// was established even though the acknowledgement errored.
describe("steerPromptInSession commit callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      activeSessionId: null,
      isConnected: true,
    });
  });

  it("does not fire for a steer that is rolled back", async () => {
    const onUserMessageCommitted = vi.fn();
    mockAcpSteerMessage.mockRejectedValue({
      code: -32602,
      message: "Invalid input",
    });

    const accepted = await steerPromptInSession(
      "session-1",
      "make it shorter",
      undefined,
      { onUserMessageCommitted },
    );

    expect(accepted).toBe(false);
    expect(onUserMessageCommitted).not.toHaveBeenCalled();
    // The rollback removed the provisional user message; only the error
    // notification remains.
    const messages =
      useChatStore.getState().messagesBySession["session-1"] ?? [];
    expect(messages.some((message) => message.role === "user")).toBe(false);
  });

  it("fires when delivery was established despite an acknowledgement error", async () => {
    const onUserMessageCommitted = vi.fn();
    mockAcpSteerMessage.mockImplementation(async () => {
      // The backend delivered the steer (the notification handler flips the
      // message's delivery metadata) before the acknowledgement was lost, so
      // the user message stays committed.
      const store = useChatStore.getState();
      const userMessage = store.messagesBySession["session-1"]?.find(
        (message) => message.role === "user",
      );
      if (!userMessage) throw new Error("provisional user message missing");
      store.updateMessage("session-1", userMessage.id, (message) => ({
        ...message,
        metadata: { ...message.metadata, delivery: "steer" },
      }));
      throw new Error("acknowledgement lost");
    });

    const accepted = await steerPromptInSession(
      "session-1",
      "make it shorter",
      undefined,
      { onUserMessageCommitted },
    );

    expect(accepted).toBe(true);
    expect(onUserMessageCommitted).toHaveBeenCalledTimes(1);
  });
});

describe("steering delivery ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      activeSessionId: null,
      isConnected: true,
    });
  });
  it("keeps uncertain input in a durable review hold instead of resending", async () => {
    mockAcpSteerMessage.mockRejectedValue(new Error("connection lost"));
    const receipt = vi.fn();
    expect(
      await steerPromptInSession("s", "inspect this", undefined, undefined, {
        onDelivery: receipt,
      }),
    ).toBe(true);
    expect(receipt).toHaveBeenCalledWith("steer_unconfirmed");
    expect(
      useChatStore.getState().messagesBySession.s[0].metadata?.delivery,
    ).toBe("steer_unconfirmed");
    expect(useChatStore.getState().queuedMessageBySession.s).toHaveLength(1);
    expect(useChatStore.getState().queuedMessageBySession.s[0]).toMatchObject({
      kind: "deferred",
      state: { type: "steering-review", status: "held" },
      payload: { text: "inspect this" },
    });
  });
  it("holds uncertain queued input before later messages until the user reviews it", async () => {
    const store = useChatStore.getState();
    const sendOptions = {
      userMessageMetadata: {
        origin: "distillctl_cross_session" as const,
        distillDeliveryId: "event-1",
      },
      acpPromptMetadata: { distillDeliveryId: "event-1" },
    };
    store.enqueueTransportReadyMessage("s", {
      text: "first",
      persona: { kind: "inherit" },
      sendOptions,
    });
    store.enqueueTransportReadyMessage("s", {
      text: "later",
      persona: { kind: "inherit" },
    });
    const originalId =
      useChatStore.getState().queuedMessageBySession.s[0].recordId;
    mockAcpSteerMessage.mockRejectedValue(new Error("connection lost"));
    expect(
      await steerPromptInSession("s", "first", undefined, sendOptions),
    ).toBe(true);
    store.dismissQueuedMessage("s", originalId);
    const queue = useChatStore.getState().queuedMessageBySession.s;
    expect(queue.map((entry) => entry.payload.text)).toEqual([
      "first",
      "later",
    ]);
    expect(queue[0].kind).toBe("deferred");
    store.setQueuedMessageEditing("s", queue[0].recordId, true);
    store.updateQueuedMessage("s", queue[0].recordId, queue[0].payload);
    const reviewed = useChatStore.getState().queuedMessageBySession.s[0];
    expect(reviewed).toMatchObject({
      kind: "transport-ready",
      releasedFromDeferred: true,
    });
    expect(
      reviewed.payload.sendOptions?.userMessageMetadata?.delivery,
    ).toBeUndefined();
    expect(
      reviewed.payload.sendOptions?.userMessageMetadata?.distillDeliveryId,
    ).toBeUndefined();
    expect(
      reviewed.payload.sendOptions?.acpPromptMetadata?.distillDeliveryId,
    ).toBeUndefined();
  });

  it("queues unsupported direct input with its attachments and provenance", async () => {
    mockAcpSteerMessage.mockResolvedValue({
      runId: "unused",
      messageId: "unused",
      delivery: "queued",
    });
    const sendOptions = {
      userMessageMetadata: {
        origin: "distillctl_cross_session" as const,
        distillSenderLabel: "flock-monitor",
        distillDeliveryId: "event-1",
      },
    };
    expect(
      await steerPromptInSession("s", "event", undefined, sendOptions, {
        queueIfUnavailable: true,
      }),
    ).toBe(true);
    expect(useChatStore.getState().messagesBySession.s).toHaveLength(0);
    expect(useChatStore.getState().queuedMessageBySession.s).toHaveLength(1);
    expect(
      useChatStore.getState().queuedMessageBySession.s[0].payload,
    ).toMatchObject({ text: "event", sendOptions });
  });
  it("leaves an already queued input in place when native steering is unavailable", async () => {
    mockAcpSteerMessage.mockResolvedValue({
      runId: "unused",
      messageId: "unused",
      delivery: "queued",
    });
    expect(await steerPromptInSession("s", "first queued message")).toBe(false);
    expect(useChatStore.getState().queuedMessageBySession.s ?? []).toHaveLength(
      0,
    );
  });
  it("uses an explicit provider receipt without waiting forever for an echo", async () => {
    mockAcpSteerMessage.mockResolvedValue({
      runId: "active",
      messageId: "native",
      delivery: "steer",
    });
    expect(await steerPromptInSession("s", "event")).toBe(true);
    expect(
      useChatStore.getState().messagesBySession.s[0].metadata?.delivery,
    ).toBe("steer");
    expect(
      useChatStore.getState().getSessionRuntime("s")
        .pendingInterventionBoundary,
    ).toBeNull();
  });
});
