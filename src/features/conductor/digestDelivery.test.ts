import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionDispatchContentionError,
  SessionDispatchMissingError,
} from "@/features/chat/lib/sessionDispatchAcquisition";
import { useChatStore } from "@/features/chat/stores/chatStore";

const sendPromptToExistingSessionInBackground = vi.hoisted(() => vi.fn());
const distillctlCrossSessionSendOptions = vi.hoisted(() =>
  vi.fn(() => ({
    userMessageMetadata: { origin: "distillctl_cross_session" as const },
  })),
);

vi.mock("@/features/distillctl/commands/runtime/sessionSend", () => ({
  sendPromptToExistingSessionInBackground,
  distillctlCrossSessionSendOptions,
}));

const { classifyDigestDispatchError, deliverEnvelope } = await import(
  "./digestDelivery"
);

const SESSION = "conductor-1";

function queueFor(sessionId: string) {
  return useChatStore.getState().queuedMessageBySession[sessionId] ?? [];
}

function setRuntime(state: "idle" | "running"): void {
  useChatStore.setState({
    sessionStateById:
      state === "idle"
        ? {}
        : {
            [SESSION]: {
              ...useChatStore.getState().getSessionRuntime(SESSION),
              chatState: "streaming",
            },
          },
  });
}

describe("classifyDigestDispatchError", () => {
  it("fails visibly on anything unexpected, keeping the message", () => {
    expect(classifyDigestDispatchError(new Error("boom"))).toEqual({
      status: "failed",
      detail: "boom",
    });
    expect(classifyDigestDispatchError("weird")).toEqual({
      status: "failed",
      detail: "weird",
    });
  });
});

describe("deliverEnvelope", () => {
  beforeEach(() => {
    useChatStore.setState({
      queuedMessageBySession: {},
      sessionStateById: {},
      messagesBySession: {},
    });
    sendPromptToExistingSessionInBackground.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues behind a parent that already has a queue", async () => {
    setRuntime("idle");
    await deliverEnvelope(SESSION, "first");
    useChatStore.setState((state) => ({
      queuedMessageBySession: {
        ...state.queuedMessageBySession,
        [SESSION]: [
          {
            kind: "transport-ready",
            recordId: "r1",
            payload: { text: "already here", persona: { kind: "inherit" } },
          },
        ],
      },
    }));
    sendPromptToExistingSessionInBackground.mockReset();
    const result = await deliverEnvelope(SESSION, "second");
    expect(result).toEqual({ status: "queued" });
    expect(sendPromptToExistingSessionInBackground).not.toHaveBeenCalled();
    expect(queueFor(SESSION).map((record) => record.payload.text)).toEqual([
      "already here",
      "second",
    ]);
  });

  it("falls back to the queue when the dispatch loses the lease", async () => {
    sendPromptToExistingSessionInBackground.mockRejectedValue(
      new SessionDispatchContentionError({} as never),
    );
    const result = await deliverEnvelope(SESSION, "the digest");
    expect(result).toEqual({ status: "queued" });
    expect(queueFor(SESSION)).toHaveLength(1);
  });

  it("reports a hard failure and queues nothing", async () => {
    sendPromptToExistingSessionInBackground.mockRejectedValue(
      new SessionDispatchMissingError(SESSION),
    );
    const result = await deliverEnvelope(SESSION, "the digest");
    expect(result.status).toBe("failed");
    expect(queueFor(SESSION)).toHaveLength(0);
  });
});
