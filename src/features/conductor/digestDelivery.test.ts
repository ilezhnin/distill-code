import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import { QueuedSessionNotReadyError } from "@/features/chat/lib/queuedMessageReadiness";
import {
  SessionDispatchContentionError,
  SessionDispatchCreationIncompleteError,
  SessionDispatchMissingError,
  SessionDispatchUnresolvedError,
} from "@/features/chat/lib/sessionDispatchAcquisition";
import { useChatStore } from "@/features/chat/stores/chatStore";

const sendPromptToExistingSessionInBackground = vi.hoisted(() => vi.fn());
const berdctlCrossSessionSendOptions = vi.hoisted(() =>
  vi.fn(() => ({
    userMessageMetadata: { origin: "berdctl_cross_session" as const },
  })),
);

vi.mock("@/features/berdctl/commands/runtime/sessionSend", () => ({
  sendPromptToExistingSessionInBackground,
  berdctlCrossSessionSendOptions,
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
  it("queues a busy parent rather than dropping the digest", () => {
    expect(
      classifyDigestDispatchError(
        new SessionDispatchContentionError({} as never),
      ),
    ).toEqual({ status: "queued" });
  });

  it("queues while the target session is still being created", () => {
    expect(
      classifyDigestDispatchError(
        new SessionDispatchCreationIncompleteError("pending"),
      ),
    ).toEqual({ status: "queued" });
  });

  it("fails visibly when the target session failed to be created", () => {
    const result = classifyDigestDispatchError(
      new SessionDispatchCreationIncompleteError("failed"),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toBeTruthy();
  });

  it("fails visibly when the session is gone", () => {
    const result = classifyDigestDispatchError(
      new SessionDispatchMissingError(SESSION),
    );
    expect(result.status).toBe("failed");
    expect(result.detail).toContain(SESSION);
  });

  it("fails visibly when the session has no model", () => {
    expect(
      classifyDigestDispatchError(new SessionDispatchUnresolvedError()).status,
    ).toBe("failed");
  });

  it("queues any other pre-commit rejection", () => {
    expect(
      classifyDigestDispatchError(new QueuedSessionNotReadyError()),
    ).toEqual({ status: "queued" });
    expect(
      classifyDigestDispatchError(new PreCommitSendRejectedError("nope")),
    ).toEqual({ status: "queued" });
  });

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

  it("dispatches into an idle parent through the cross-session seam", async () => {
    sendPromptToExistingSessionInBackground.mockResolvedValue(undefined);
    const result = await deliverEnvelope(SESSION, "the digest");
    expect(result).toEqual({ status: "dispatched" });
    expect(sendPromptToExistingSessionInBackground).toHaveBeenCalledWith(
      SESSION,
      "the digest",
      undefined,
      { returnOnDispatch: true },
    );
    expect(queueFor(SESSION)).toHaveLength(0);
  });

  it("queues a busy parent without touching the send path", async () => {
    setRuntime("running");
    const result = await deliverEnvelope(SESSION, "the digest");
    expect(result).toEqual({ status: "queued" });
    expect(sendPromptToExistingSessionInBackground).not.toHaveBeenCalled();
    const [record] = queueFor(SESSION);
    expect(record.payload.text).toBe("the digest");
    // The queued send carries the cross-session origin, exactly like a direct
    // dispatch would; the parent must not see a digest as its own composer.
    expect(record.payload.sendOptions?.userMessageMetadata?.origin).toBe(
      "berdctl_cross_session",
    );
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

  it("never throws, whatever the seam does", async () => {
    sendPromptToExistingSessionInBackground.mockRejectedValue("not an error");
    await expect(deliverEnvelope(SESSION, "the digest")).resolves.toEqual({
      status: "failed",
      detail: "not an error",
    });
  });
});
