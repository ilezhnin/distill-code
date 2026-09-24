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
  it("leaves a reply replayed under a derived id alone", () => {
    // History recorded before the host named replies replays each one under
    // `<prompt id>:reply`. Its plan was admitted when it streamed, under an id
    // no reload reproduces, so it must not become a second wave.
    const candidates = detectWavePlanCandidates({
      conductorSessionIds: ["conductor-1"],
      messagesBySession: {
        "conductor-1": [
          user("u1", "Do a few things"),
          assistant("u1:reply", `On it.\n\n${PLAN}`, "completed"),
        ],
      },
      isProcessed: neverProcessed,
    });
    expect(candidates).toEqual([]);
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
