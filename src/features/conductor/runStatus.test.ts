import { describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import { lastFailureReason } from "./runStatus";

function reply(
  id: string,
  metadata: Message["metadata"],
  text = "partial",
): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    metadata,
  };
}

describe("lastFailureReason", () => {
  it("reads the host's reason off the last reply, and only off a reply", () => {
    const failed = reply("cut", {
      completionStatus: "error",
      failureReason: " The agent's bridge exited before this turn finished ",
    });
    const user: Message = {
      id: "steer",
      role: "user",
      created: 2,
      content: [{ type: "text", text: "status?" }],
    };
    expect(lastFailureReason([failed, user])).toBe(
      "The agent's bridge exited before this turn finished",
    );
  });

  it("answers null for a reply that finished, or failed without a recorded reason", () => {
    expect(
      lastFailureReason([reply("done", { completionStatus: "completed" })]),
    ).toBeNull();
    expect(
      lastFailureReason([
        reply("cut", { completionStatus: "error", failureReason: "  " }),
      ]),
    ).toBeNull();
    expect(lastFailureReason([])).toBeNull();
    expect(lastFailureReason(undefined)).toBeNull();
  });

  it("does not reach past a later reply that finished", () => {
    const earlier = reply("cut", {
      completionStatus: "error",
      failureReason: "bridge exited",
    });
    const later = reply("done", { completionStatus: "completed" });
    expect(lastFailureReason([earlier, later])).toBeNull();
  });
});
