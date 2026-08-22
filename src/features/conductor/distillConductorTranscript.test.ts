import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { distillConductorTranscript } from "./distillConductorTranscript";

function message(
  partial: Partial<Message> & Pick<Message, "id" | "role">,
): Message {
  return {
    created: 1,
    content: [],
    ...partial,
  };
}

describe("distillConductorTranscript", () => {
  it("keeps user text and assistant answers", () => {
    const distilled = distillConductorTranscript([
      message({
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "Summarize the repo" }],
      }),
      message({
        id: "a1",
        role: "assistant",
        content: [
          { type: "thinking", text: "I should inspect files" },
          {
            type: "toolRequest",
            id: "tool-1",
            name: "spawn_agent",
            arguments: {},
            status: "completed",
          },
          { type: "text", text: "The repo has two packages." },
        ],
      }),
    ]);

    expect(distilled).toHaveLength(2);
    expect(distilled[1]?.content).toEqual([
      { type: "text", text: "The repo has two packages." },
    ]);
  });

  it("drops finished assistant turns that only contained technical chatter", () => {
    const distilled = distillConductorTranscript([
      message({
        id: "a1",
        role: "assistant",
        content: [{ type: "thinking", text: "waiting" }],
      }),
    ]);

    expect(distilled).toEqual([]);
  });
});
