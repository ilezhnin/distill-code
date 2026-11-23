import { describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import { groupBrigadeNodesByHostMessage } from "./brigadeAnchors";
import type { SessionNode } from "./types";

function reply(id: string, agentMessageIds?: string[]): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text: "A plan." }],
    metadata: {
      completionStatus: "completed",
      ...(agentMessageIds ? { agentMessageIds } : {}),
    },
  };
}

function child(sessionId: string, anchorMessageId: string): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${sessionId}`,
    harnessId: "goose",
    displayName: sessionId,
    status: "completed",
    anchorMessageId,
  };
}

describe("groupBrigadeNodesByHostMessage", () => {
  it("keeps a wave on the reply that planned it when the anchor is an id its agent gave it", () => {
    // A wave planned while replies were named by their agent is anchored
    // under that name; the reply reads under the host's id now.
    const messages = [
      reply("host-reply-1", ["msg_first", "msg_last"]),
      reply("host-reply-2"),
    ];
    const grouped = groupBrigadeNodesByHostMessage(
      [
        child("old-wave-child", "msg_last"),
        child("new-wave-child", "host-reply-2"),
      ],
      messages,
    );

    expect(grouped.get("host-reply-1")?.map((node) => node.sessionId)).toEqual([
      "old-wave-child",
    ]);
    expect(grouped.get("host-reply-2")?.map((node) => node.sessionId)).toEqual([
      "new-wave-child",
    ]);
  });
});
