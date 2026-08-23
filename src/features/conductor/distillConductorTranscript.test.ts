import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";
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
  beforeAll(async () => {
    await i18n.loadNamespaces("chat");
  });

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
    // The tool card is still stripped; what survives it is the Q6 badge, which
    // is the only trace the operator gets that the conductor executed.
    expect(distilled[1]?.content).toEqual([
      {
        type: "systemNotification",
        notificationType: "warning",
        text: "The conductor ran a tool itself — it should only plan or answer.",
      },
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

  describe("verdict fences", () => {
    function distillAssistant(text: string) {
      return distillConductorTranscript([
        message({
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text }],
        }),
      ]);
    }

    it("replaces an accept verdict with the prose that is the answer", () => {
      const distilled = distillAssistant(
        'Three callers, all in src/.\n\n```distill-verdict\n{"verdict":"accept"}\n```',
      );
      expect(distilled[0]?.content).toEqual([
        { type: "text", text: "Three callers, all in src/." },
      ]);
    });

    it("keeps the message visible when the verdict was its whole body", () => {
      const distilled = distillAssistant(
        '```distill-verdict\n{"verdict":"needs-operator","note":"key please"}\n```',
      );
      const [block] = distilled[0]?.content ?? [];
      expect(block).toBeDefined();
      expect(block.type === "text" && block.text.length > 0).toBe(true);
      expect(block.type === "text" && block.text).not.toContain(
        "distill-verdict",
      );
    });

    it("leaves an unreadable verdict raw, next to the notice explaining it", () => {
      const raw = '```distill-verdict\n{"verdict":"maybe"}\n```';
      expect(distillAssistant(raw)[0]?.content).toEqual([
        { type: "text", text: raw },
      ]);
    });

    it("leaves a plain wave plan to the plan-fence path", () => {
      const distilled = distillAssistant(
        'Here is the plan.\n\n```distill-wave\n{"steps":[{"role":"qa","subtask":"Run","access":[]}]}\n```',
      );
      expect(distilled[0]?.content).toEqual([
        { type: "text", text: "Here is the plan." },
      ]);
    });
  });

  describe("the conductor self-execution badge (Q6)", () => {
    it("marks a conductor turn that ran a tool itself", () => {
      const distilled = distillConductorTranscript([
        message({
          id: "a1",
          role: "assistant",
          content: [
            { type: "text", text: "I'll just check that myself." },
            {
              type: "toolRequest",
              id: "t1",
              name: "shell",
              arguments: {},
              status: "completed",
            },
          ],
        }),
      ]);

      // The tool card itself stays out of a conductor transcript, but the fact
      // that there was one must not vanish with it: this is the only layer that
      // still sees it.
      expect(distilled[0]?.content[0]).toEqual({
        type: "systemNotification",
        notificationType: "warning",
        text: "The conductor ran a tool itself — it should only plan or answer.",
      });
      expect(
        distilled[0]?.content.some((block) => block.type === "toolRequest"),
      ).toBe(false);
    });

    it("keeps a tool-only turn visible instead of dropping it", () => {
      const distilled = distillConductorTranscript([
        message({
          id: "a1",
          role: "assistant",
          content: [
            {
              type: "toolRequest",
              id: "t1",
              name: "shell",
              arguments: {},
              status: "completed",
            },
          ],
        }),
      ]);
      expect(distilled).toHaveLength(1);
      expect(distilled[0].content).toHaveLength(1);
    });

    it("says nothing about a turn that only planned or answered", () => {
      const distilled = distillConductorTranscript([
        message({
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "Here is the plan." }],
        }),
      ]);
      expect(
        distilled[0]?.content.some(
          (block) => block.type === "systemNotification",
        ),
      ).toBe(false);
    });
  });
});
