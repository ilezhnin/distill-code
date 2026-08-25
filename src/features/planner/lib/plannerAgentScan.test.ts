import { describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import {
  detectPlannerFenceCandidates,
  PLANNER_SCAN_TAIL,
} from "./plannerAgentScan";

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    created: 0,
    content: [{ type: "text", text: "" }],
    ...overrides,
  } as Message;
}

function withFence(id: string, body: string, extra?: Partial<Message>) {
  return message({
    id,
    content: [
      { type: "text", text: ["```distill-todo", body, "```"].join("\n") },
    ],
    ...extra,
  });
}

const never = () => false;

describe("detectPlannerFenceCandidates", () => {
  it("finds a settled assistant turn that filed work", () => {
    const found = detectPlannerFenceCandidates({
      messagesBySession: {
        "s-1": [withFence("m-1", '{"add":["Ship it"]}')],
      },
      isApplied: never,
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sessionId: "s-1", messageId: "m-1" });
    expect(found[0].request.add[0].title).toBe("Ship it");
  });

  it("ignores a turn that is still streaming", () => {
    // A half-written fence has no closing backticks and would parse as
    // nothing anyway — but a *complete* block mid-stream is followed by more
    // text, and filing it before the turn ends files a draft.
    const found = detectPlannerFenceCandidates({
      messagesBySession: {
        "s-1": [
          withFence("m-1", '{"add":["Too early"]}', {
            metadata: { completionStatus: "inProgress" },
          }),
        ],
      },
      isApplied: never,
    });

    expect(found).toEqual([]);
  });

  it("ignores the operator's own message, fence and all", () => {
    const found = detectPlannerFenceCandidates({
      messagesBySession: {
        "s-1": [withFence("m-1", '{"add":["From a human"]}', { role: "user" })],
      },
      isApplied: never,
    });

    expect(found).toEqual([]);
  });

  it("skips a message that has already been filed", () => {
    const found = detectPlannerFenceCandidates({
      messagesBySession: {
        "s-1": [withFence("m-1", '{"add":["Once"]}')],
      },
      isApplied: (id) => id === "m-1",
    });

    expect(found).toEqual([]);
  });

  it("reads every session, because the list is one list", () => {
    const found = detectPlannerFenceCandidates({
      messagesBySession: {
        "s-1": [withFence("m-1", '{"add":["A"]}')],
        "s-2": [withFence("m-2", '{"add":["B"]}')],
      },
      isApplied: never,
    });

    expect(found.map((entry) => entry.sessionId).sort()).toEqual([
      "s-1",
      "s-2",
    ]);
  });

  it("only looks at the tail of a long transcript", () => {
    const older = Array.from({ length: PLANNER_SCAN_TAIL + 5 }, (_, index) =>
      message({ id: `old-${index}` }),
    );
    const found = detectPlannerFenceCandidates({
      messagesBySession: {
        "s-1": [withFence("buried", '{"add":["Buried"]}'), ...older],
      },
      isApplied: never,
    });

    expect(found).toEqual([]);
  });
});
