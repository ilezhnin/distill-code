import { beforeEach, describe, expect, it } from "vitest";

import {
  LIMIT_CONTINUATION_TEXT,
  queueLimitContinuation,
  turnCutOffByLimit,
} from "@/features/chat/lib/limitContinuation";
import { useChatStore } from "@/features/chat/stores/chatStore";

const SESSION = "wave-step-1";

/** A turn that had begun and ended on its account's limit. */
function cutOff(spare?: string) {
  return {
    code: -32603,
    message: "Internal error: usage limit reached",
    data: {
      dispatchStarted: true,
      cutOffByLimit: true,
      ...(spare ? { continueOnAccount: spare } : {}),
    },
  };
}

function queuedTexts(): string[] {
  return (useChatStore.getState().queuedMessageBySession[SESSION] ?? []).map(
    (record) => record.payload.text,
  );
}

beforeEach(() => {
  useChatStore.setState({ queuedMessageBySession: {} });
});

describe("turnCutOffByLimit", () => {
  it("reads the host's field, with or without a spare account", () => {
    expect(turnCutOffByLimit(cutOff())).toBe(true);
    expect(turnCutOffByLimit(cutOff("spare"))).toBe(true);
    // A spare the host named is a cut-off even from a host that set no field.
    expect(turnCutOffByLimit({ data: { continueOnAccount: "spare" } })).toBe(
      true,
    );
  });

  it("is not any other failure", () => {
    for (const other of [
      null,
      undefined,
      "usage limit reached",
      new Error("usage limit reached"),
      { data: null },
      { data: { dispatchStarted: true } },
      { data: { cutOffByLimit: "true" } },
    ]) {
      expect(turnCutOffByLimit(other)).toBe(false);
    }
  });
});

describe("queueLimitContinuation", () => {
  it("queues the continuation whether or not a spare account is ready", () => {
    expect(queueLimitContinuation(SESSION, cutOff())).toBe(true);
    expect(queuedTexts()).toEqual([LIMIT_CONTINUATION_TEXT]);
    const [record] =
      useChatStore.getState().queuedMessageBySession[SESSION] ?? [];
    // The step keeps its own role: the message is the app's, not a new voice.
    expect(record.payload.persona).toEqual({ kind: "inherit" });
  });

  it("queues nothing for a turn that failed on anything else", () => {
    expect(
      queueLimitContinuation(SESSION, { data: { dispatchStarted: true } }),
    ).toBe(false);
    expect(queuedTexts()).toEqual([]);
  });

  it("leaves a queue that already holds a message, which continues the chat itself", () => {
    expect(queueLimitContinuation(SESSION, cutOff())).toBe(true);
    expect(queueLimitContinuation(SESSION, cutOff("spare"))).toBe(true);
    expect(queuedTexts()).toEqual([LIMIT_CONTINUATION_TEXT]);
  });
});
