import { beforeEach, describe, expect, it } from "vitest";
import {
  SPARE_ACCOUNT_CONTINUATION_TEXT,
  queueSpareAccountContinuation,
  spareAccountToContinueOn,
} from "@/features/chat/lib/spareAccountContinuation";
import { useChatStore } from "@/features/chat/stores/chatStore";

const SESSION = "chat-1";

function cutOff(continueOnAccount?: unknown) {
  return {
    code: -32603,
    message: "Internal error: Claude AI usage limit reached",
    data: {
      dispatchStarted: true,
      promptNotAccepted: false,
      accountId: "spent",
      ...(continueOnAccount === undefined ? {} : { continueOnAccount }),
    },
  };
}

function queueTexts() {
  return (useChatStore.getState().queuedMessageBySession[SESSION] ?? []).map(
    (record) => record.payload.text,
  );
}

describe("spare account continuation", () => {
  beforeEach(() => {
    useChatStore.setState({ queuedMessageBySession: {} });
  });

  it("reads the spare account only from a cut-off turn's error", () => {
    expect(spareAccountToContinueOn(cutOff("spare"))).toBe("spare");
    expect(spareAccountToContinueOn(cutOff())).toBeNull();
    expect(spareAccountToContinueOn(cutOff(""))).toBeNull();
    expect(spareAccountToContinueOn(cutOff(42))).toBeNull();
    expect(spareAccountToContinueOn(new Error("boom"))).toBeNull();
    expect(spareAccountToContinueOn(null)).toBeNull();
  });

  it("queues one visible continuation that the operator can edit or remove", () => {
    expect(queueSpareAccountContinuation(SESSION, cutOff("spare"))).toBe(true);
    const [record] =
      useChatStore.getState().queuedMessageBySession[SESSION] ?? [];
    expect(record.kind).toBe("transport-ready");
    expect(record.payload.text).toBe(SPARE_ACCOUNT_CONTINUATION_TEXT);
    expect(record.payload.persona).toEqual({ kind: "inherit" });
    expect(
      useChatStore.getState().updateQueuedMessage(SESSION, record.recordId, {
        ...record.payload,
        text: "Go on, but skip the tests",
      }),
    ).toBe(true);
    expect(queueTexts()).toEqual(["Go on, but skip the tests"]);
  });

  it("queues nothing when no spare account is ready", () => {
    expect(queueSpareAccountContinuation(SESSION, cutOff())).toBe(false);
    expect(queueTexts()).toEqual([]);
  });

  it("leaves a chat that already holds queued messages unchanged", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        [SESSION]: [
          {
            kind: "transport-ready",
            recordId: "r1",
            payload: {
              text: "the operator's next step",
              persona: { kind: "inherit" },
            },
          },
        ],
      },
    });
    expect(queueSpareAccountContinuation(SESSION, cutOff("spare"))).toBe(false);
    expect(queueTexts()).toEqual(["the operator's next step"]);
  });
});
