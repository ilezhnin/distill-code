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

  describe("wave plan fences", () => {
    const PLAN_BODY = '{"steps":[{"role":"qa","subtask":"Run","access":[]}]}';
    const fence = (body: string) => `\`\`\`distill-wave\n${body}\n\`\`\``;

    function distillAssistant(
      content: Message["content"],
      wavePlanLabel = "Plan for the brigade below.",
    ) {
      return distillConductorTranscript(
        [message({ id: "a1", role: "assistant", content })],
        { wavePlanLabel },
      );
    }

    it("replaces a valid plan fence with its prose", () => {
      const distilled = distillAssistant([
        {
          type: "text",
          text: `Fanning this out.\n\n${fence(PLAN_BODY)}\n\nBack shortly.`,
        },
      ]);

      expect(distilled).toHaveLength(1);
      expect(distilled[0]?.content).toEqual([
        { type: "text", text: "Fanning this out.\n\nBack shortly." },
      ]);
      const text = JSON.stringify(distilled[0]?.content);
      expect(text).not.toContain("distill-wave");
      expect(text).not.toContain("steps");
    });

    it("substitutes the localized label when the plan carried no prose", () => {
      const distilled = distillAssistant([
        { type: "text", text: fence(PLAN_BODY) },
      ]);

      // The message is the wave's anchor: it must never drop out.
      expect(distilled).toHaveLength(1);
      expect(distilled[0]?.content).toEqual([
        { type: "text", text: "Plan for the brigade below." },
      ]);
    });

    it("keeps a non-empty label even when the caller passes a blank one", () => {
      const distilled = distillAssistant(
        [{ type: "text", text: fence(PLAN_BODY) }],
        "   ",
      );

      expect(distilled).toHaveLength(1);
      const block = distilled[0]?.content[0];
      expect(block?.type).toBe("text");
      expect(
        block?.type === "text" && block.text.trim().length,
      ).toBeGreaterThan(0);
    });

    it("keeps the raw text of an invalid fence", () => {
      const raw = fence('{"steps":[]}');
      const distilled = distillAssistant([{ type: "text", text: raw }]);

      expect(distilled[0]?.content).toEqual([{ type: "text", text: raw }]);
    });

    it("leaves a still-streaming half-written fence alone", () => {
      const partial = '```distill-wave\n{"steps":[{"role":"qa",';
      const distilled = distillAssistant([{ type: "text", text: partial }]);

      expect(distilled[0]?.content).toEqual([{ type: "text", text: partial }]);
    });

    it("leaves text without a fence untouched", () => {
      const distilled = distillAssistant([
        { type: "text", text: "No plan here, just an answer." },
      ]);

      expect(distilled[0]?.content).toEqual([
        { type: "text", text: "No plan here, just an answer." },
      ]);
    });

    it("parses per text block and keeps block order and non-text blocks", () => {
      const distilled = distillAssistant([
        { type: "text", text: "First." },
        { type: "text", text: `Second.\n\n${fence(PLAN_BODY)}` },
        {
          type: "systemNotification",
          notificationType: "error",
          text: "boom",
        },
        { type: "text", text: "Third." },
      ]);

      expect(distilled[0]?.content).toEqual([
        { type: "text", text: "First." },
        { type: "text", text: "Second." },
        {
          type: "systemNotification",
          notificationType: "error",
          text: "boom",
        },
        { type: "text", text: "Third." },
      ]);
    });
  });
});
