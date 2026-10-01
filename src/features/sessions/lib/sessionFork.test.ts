import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { getMessageForkTarget } from "./sessionFork";

function message(id: string, role: Message["role"] = "assistant"): Message {
  return {
    id,
    role,
    created: 1_700_000_000_250,
    content: [{ type: "text", text: id }],
  };
}

describe("getMessageForkTarget", () => {
  it("separates a prompt and replies with identical timestamps", () => {
    const messages = [
      message("prompt", "user"),
      message("reply"),
      message("later"),
    ];
    expect(getMessageForkTarget(messages, "prompt")).toEqual({
      messageId: "prompt",
      role: "user",
    });
    expect(getMessageForkTarget(messages, "reply")).toEqual({
      messageId: "reply",
      role: "assistant",
    });
  });

  it("rejects missing, hidden, and system messages", () => {
    const hidden = { ...message("hidden"), metadata: { userVisible: false } };
    const messages = [hidden, message("system", "system")];
    for (const id of ["missing", "hidden", "system"]) {
      expect(getMessageForkTarget(messages, id)).toBeNull();
    }
  });
});
