import { describe, expect, it } from "vitest";
import type { Message, MessageContent } from "@/shared/types/messages";
import { settleAbandonedToolCalls } from "../messageCompletion";

function toolRequest(
  id: string,
  status: "pending" | "in_progress" | "completed" | "failed" | "stopped",
): MessageContent {
  return {
    type: "toolRequest",
    id,
    name: `Edit ${id}`,
    arguments: {},
    status,
    startedAt: 1,
  };
}

function assistant(content: MessageContent[]): Message {
  return {
    id: "reply-1",
    role: "assistant",
    created: 1,
    content,
    metadata: { userVisible: true, agentVisible: true },
  };
}

describe("settleAbandonedToolCalls", () => {
  it("stops the calls a finished run left waiting or running", () => {
    const settled = settleAbandonedToolCalls(
      assistant([
        toolRequest("waiting", "pending"),
        toolRequest("running", "in_progress"),
        toolRequest("done", "completed"),
        toolRequest("broken", "failed"),
      ]),
    );

    expect(
      settled.content.map((block) =>
        block.type === "toolRequest" ? block.status : null,
      ),
    ).toEqual(["stopped", "stopped", "completed", "failed"]);
  });

  it("leaves a call alone once its result is in the message", () => {
    const message = assistant([
      toolRequest("answered", "in_progress"),
      {
        type: "toolResponse",
        id: "answered",
        name: "Edit answered",
        result: "ok",
        isError: false,
      },
    ]);

    expect(settleAbandonedToolCalls(message)).toBe(message);
  });

  it("returns the same message when nothing was left open", () => {
    const message = assistant([
      { type: "text", text: "done" },
      toolRequest("done", "completed"),
    ]);

    expect(settleAbandonedToolCalls(message)).toBe(message);
  });
});
