import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { getConversationBeforeForMessageFork } from "./sessionFork";

function message(
  id: string,
  created: number,
  role: Message["role"] = "assistant",
  metadata: Message["metadata"] = { userVisible: true },
): Message {
  return {
    id,
    role,
    created,
    content: [{ type: "text", text: id }],
    metadata,
  };
}

describe("getConversationBeforeForMessageFork", () => {
  it("uses the first later visible conversation message second as the cutoff", () => {
    const messages = [
      message("selected", 1_700_000_000_250),
      message("later", 1_700_000_003_100),
      message("latest", 1_700_000_005_100),
    ];

    expect(getConversationBeforeForMessageFork(messages, "selected")).toBe(
      1_700_000_003,
    );
  });

  it("keeps a long latest reply whole by cutting after now", () => {
    const messages = [
      message("prompt", 1_700_000_000_250, "user"),
      message("selected", 1_700_000_000_900),
    ];

    expect(
      getConversationBeforeForMessageFork(
        messages,
        "selected",
        1_700_000_095_400,
      ),
    ).toBe(1_700_000_096);
  });

  it("keeps same-second siblings by skipping equal-second messages", () => {
    const messages = [
      message("selected", 1_700_000_000_250),
      message("same-second", 1_700_000_000_900),
      message("later", 1_700_000_001_000),
    ];

    expect(getConversationBeforeForMessageFork(messages, "selected")).toBe(
      1_700_000_001,
    );
  });

  it("ignores hidden and system-only messages as conversation boundaries", () => {
    const messages = [
      message("selected", 1_700_000_000_250),
      message("hidden", 1_700_000_001_000, "assistant", {
        userVisible: false,
      }),
      message("system", 1_700_000_002_000, "system"),
      message("later", 1_700_000_003_000, "user"),
    ];

    expect(getConversationBeforeForMessageFork(messages, "selected")).toBe(
      1_700_000_003,
    );
  });
});
