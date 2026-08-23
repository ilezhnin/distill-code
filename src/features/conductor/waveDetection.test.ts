import { describe, expect, it } from "vitest";

import type { Message, MessageCompletionStatus } from "@/shared/types/messages";

import { detectWavePlanCandidates } from "./waveDetection";

function assistant(
  id: string,
  text: string,
  completionStatus?: MessageCompletionStatus,
): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    ...(completionStatus ? { metadata: { completionStatus } } : {}),
  };
}

function user(id: string, text: string): Message {
  return {
    id,
    role: "user",
    created: 1,
    content: [{ type: "text", text }],
  };
}

const PLAN =
  '```distill-wave\n{"steps":[{"role":"scout","subtask":"Look","access":[]}]}\n```';

const neverProcessed = () => false;

describe("detectWavePlanCandidates", () => {
  it("finds a plan in a conductor's assistant message", () => {
    const candidates = detectWavePlanCandidates({
      conductorSessionIds: ["conductor-1"],
      messagesBySession: {
        "conductor-1": [
          user("u1", "Do a few things"),
          assistant("a1", `On it.\n\n${PLAN}`),
        ],
      },
      isProcessed: neverProcessed,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      conductorSessionId: "conductor-1",
      planMessageId: "a1",
    });
    expect(candidates[0].parse.kind).toBe("plan");
  });

  it("returns invalid fences so the operator sees the reason", () => {
    const candidates = detectWavePlanCandidates({
      conductorSessionIds: ["conductor-1"],
      messagesBySession: {
        "conductor-1": [assistant("a1", "```distill-wave\n{oops}\n```")],
      },
      isProcessed: neverProcessed,
    });
    expect(candidates[0].parse).toMatchObject({
      kind: "invalid",
      reason: "malformed-json",
    });
  });

  it("ignores messages with no fence, user turns, and other sessions", () => {
    const candidates = detectWavePlanCandidates({
      conductorSessionIds: ["conductor-1"],
      messagesBySession: {
        "conductor-1": [
          assistant("a1", "Just answering directly."),
          user("u1", PLAN),
        ],
        "plain-1": [assistant("a2", PLAN)],
      },
      isProcessed: neverProcessed,
    });
    expect(candidates).toEqual([]);
  });

  it("ignores a plan that is still streaming", () => {
    const candidates = detectWavePlanCandidates({
      conductorSessionIds: ["conductor-1"],
      messagesBySession: {
        "conductor-1": [
          assistant("a1", '```distill-wave\n{"steps"', "inProgress"),
        ],
      },
      isProcessed: neverProcessed,
    });
    expect(candidates).toEqual([]);
  });

  it("skips messages the tombstone has already seen", () => {
    const candidates = detectWavePlanCandidates({
      conductorSessionIds: ["conductor-1"],
      messagesBySession: {
        "conductor-1": [assistant("a1", PLAN), assistant("a2", PLAN)],
      },
      isProcessed: (planMessageId) => planMessageId === "a1",
    });
    expect(candidates.map((candidate) => candidate.planMessageId)).toEqual([
      "a2",
    ]);
  });
});

describe("markScanned", () => {
  it("reports settled messages that carry no plan so callers can skip them", () => {
    const scanned: string[] = [];
    const candidates = detectWavePlanCandidates({
      conductorSessionIds: ["conductor-1"],
      messagesBySession: {
        "conductor-1": [
          assistant("prose-1", "Just an ordinary answer."),
          assistant(
            "mentions-tag",
            "I could write a distill-wave block here but I will not.",
          ),
          assistant("plan-1", `Plan:\n\n${PLAN}`),
        ],
      },
      isProcessed: () => false,
      markScanned: (messageId) => scanned.push(messageId),
    });

    expect(candidates.map((candidate) => candidate.planMessageId)).toEqual([
      "plan-1",
    ]);
    expect(scanned).toEqual(["prose-1", "mentions-tag"]);
  });

  it("is optional", () => {
    expect(() =>
      detectWavePlanCandidates({
        conductorSessionIds: ["conductor-1"],
        messagesBySession: {
          "conductor-1": [assistant("prose-1", "Ordinary answer.")],
        },
        isProcessed: () => false,
      }),
    ).not.toThrow();
  });
});
