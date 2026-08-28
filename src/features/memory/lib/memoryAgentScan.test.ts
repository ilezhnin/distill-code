import { describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import {
  detectMemoryFenceCandidates,
  MEMORY_SCAN_TAIL,
} from "./memoryAgentScan";

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  } as unknown as Message;
}

const FENCE = [
  "```distill-memory",
  '{"remember":["the branch is main"]}',
  "```",
].join("\n");

function filler(count: number): Message[] {
  return Array.from({ length: count }, (_, index) =>
    assistant(`filler-${index}`, "nothing to see"),
  );
}

describe("detectMemoryFenceCandidates", () => {
  it("reads the tail on an ordinary change", () => {
    const messages = [assistant("old", FENCE), ...filler(MEMORY_SCAN_TAIL)];
    expect(
      detectMemoryFenceCandidates({
        messagesBySession: { s1: messages },
        isApplied: () => false,
      }),
    ).toEqual([]);
  });

  it("reads the whole transcript the first time it sees a session", () => {
    // A fence written before the app was last closed sits wherever it sat.
    // With a tail-only scan the agent asked to remember something and the app
    // quietly never did.
    const messages = [assistant("old", FENCE), ...filler(MEMORY_SCAN_TAIL)];
    const found = detectMemoryFenceCandidates({
      messagesBySession: { s1: messages },
      isApplied: () => false,
      isFirstScan: () => true,
    });
    expect(found.map((candidate) => candidate.messageId)).toEqual(["old"]);
  });

  it("still skips what has already been applied", () => {
    const messages = [assistant("old", FENCE)];
    expect(
      detectMemoryFenceCandidates({
        messagesBySession: { s1: messages },
        isApplied: (id) => id === "old",
        isFirstScan: () => true,
      }),
    ).toEqual([]);
  });
});
