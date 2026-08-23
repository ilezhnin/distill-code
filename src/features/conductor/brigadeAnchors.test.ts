import { describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import {
  brigadeNodesForMessage,
  groupBrigadeNodesByHostMessage,
} from "./brigadeAnchors";
import type { SessionNode } from "./types";

function message(id: string, role: Message["role"]): Message {
  return {
    id,
    role,
    created: 0,
    content: [{ type: "text", text: id }],
  };
}

/** u1 → a1 (first answer), u2 → a2 (latest answer, so the fallback host). */
const TRANSCRIPT: Message[] = [
  message("u1", "user"),
  message("a1", "assistant"),
  message("u2", "user"),
  message("a2", "assistant"),
];

function node(
  sessionId: string,
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status: "running",
    ...overrides,
  };
}

function idsFor(
  grouped: ReturnType<typeof groupBrigadeNodesByHostMessage>,
  messageId: string,
): string[] {
  return brigadeNodesForMessage(grouped, messageId).map(
    (item) => item.sessionId,
  );
}

describe("groupBrigadeNodesByHostMessage", () => {
  it("keeps children anchored to an older message on that older message", () => {
    const grouped = groupBrigadeNodesByHostMessage(
      [node("w1", { anchorMessageId: "a1" })],
      TRANSCRIPT,
    );

    expect(idsFor(grouped, "a1")).toEqual(["w1"]);
    expect(idsFor(grouped, "a2")).toEqual([]);
  });

  it("lands children without an anchor on the latest host and nowhere else", () => {
    const grouped = groupBrigadeNodesByHostMessage(
      [node("w1"), node("w2")],
      TRANSCRIPT,
    );

    expect(idsFor(grouped, "a2")).toEqual(["w1", "w2"]);
    expect(idsFor(grouped, "a1")).toEqual([]);
    expect(idsFor(grouped, "u1")).toEqual([]);
    expect(idsFor(grouped, "u2")).toEqual([]);
    expect([...grouped.keys()]).toEqual(["a2"]);
  });

  it("returns nothing for a message that owns no children", () => {
    const grouped = groupBrigadeNodesByHostMessage(
      [node("w1", { anchorMessageId: "a1" })],
      TRANSCRIPT,
    );

    expect(brigadeNodesForMessage(grouped, "u1")).toEqual([]);
    expect(brigadeNodesForMessage(grouped, "missing")).toEqual([]);
  });

  it("keeps two waves anchored to two different messages apart", () => {
    const grouped = groupBrigadeNodesByHostMessage(
      [
        node("w1", { anchorMessageId: "a1", waveId: "wave-1", stepIndex: 0 }),
        node("w2", { anchorMessageId: "a1", waveId: "wave-1", stepIndex: 1 }),
        node("w3", { anchorMessageId: "a2", waveId: "wave-2", stepIndex: 0 }),
      ],
      TRANSCRIPT,
    );

    expect(idsFor(grouped, "a1")).toEqual(["w1", "w2"]);
    expect(idsFor(grouped, "a2")).toEqual(["w3"]);
  });

  it("mixes an anchored wave and unanchored legacy children without bleeding", () => {
    const grouped = groupBrigadeNodesByHostMessage(
      [node("w1", { anchorMessageId: "a1" }), node("legacy")],
      TRANSCRIPT,
    );

    expect(idsFor(grouped, "a1")).toEqual(["w1"]);
    expect(idsFor(grouped, "a2")).toEqual(["legacy"]);
  });

  it("falls back when the anchor message is not part of this transcript", () => {
    const grouped = groupBrigadeNodesByHostMessage(
      [node("w1", { anchorMessageId: "dropped-message" })],
      TRANSCRIPT,
    );

    expect(idsFor(grouped, "a2")).toEqual(["w1"]);
  });

  it("drops unanchored children when the transcript has no host at all", () => {
    const grouped = groupBrigadeNodesByHostMessage([node("w1")], []);

    expect(grouped.size).toBe(0);
  });

  it("returns an empty grouping without children", () => {
    expect(groupBrigadeNodesByHostMessage([], TRANSCRIPT).size).toBe(0);
  });

  it("anchors to a user message when no answer followed it yet", () => {
    const grouped = groupBrigadeNodesByHostMessage(
      [node("w1")],
      [message("u1", "user")],
    );

    expect(idsFor(grouped, "u1")).toEqual(["w1"]);
  });
});
