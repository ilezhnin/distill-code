import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";
import {
  collectWavePlanSteps,
  distillConductorTranscript,
  NO_WAVE_PLAN_STEPS,
} from "./distillConductorTranscript";

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
    // Thinking is still stripped. The tool card is not: this turn tripped the
    // Q6 badge, and on that turn the tool call is the evidence for it.
    expect(distilled[1]?.content).toEqual([
      {
        type: "systemNotification",
        notificationType: "warning",
        text: "The conductor ran a tool itself — it should only plan or answer.",
      },
      {
        type: "toolRequest",
        id: "tool-1",
        name: "spawn_agent",
        arguments: {},
        status: "completed",
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

  describe("object identity (the projection cache depends on it)", () => {
    // `buildTranscriptItems` caches its per-message work in `WeakMap`s keyed on
    // the `Message` object. A distiller that cloned every assistant message made
    // every message a cache miss on every streamed token; at 2000 messages that
    // measured +9–10 ms of re-projection per token.
    const PLAN_FENCE =
      '```distill-wave\n{"steps":[{"role":"qa","subtask":"Run","access":[]}]}\n```';

    it("returns the very same objects when nothing was changed", () => {
      const messages = [
        message({
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "Go" }],
        }),
        message({
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        }),
      ];
      const distilled = distillConductorTranscript(messages);

      expect(distilled[0]).toBe(messages[0]);
      expect(distilled[1]).toBe(messages[1]);
      // The array identity matters as much: every consumer memoizes on it.
      expect(distilled).toBe(messages);
    });

    it("keeps identity across repeated calls, as a streamed token would", () => {
      const messages = [
        message({
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        }),
      ];
      expect(distillConductorTranscript(messages)[0]).toBe(
        distillConductorTranscript(messages)[0],
      );
    });

    it("clones only the messages distillation actually touched", () => {
      const untouched = message({
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "Untouched." }],
      });
      const filtered = message({
        id: "a2",
        role: "assistant",
        content: [
          { type: "thinking", text: "hidden" },
          { type: "text", text: "Kept." },
        ],
      });
      const planned = message({
        id: "a3",
        role: "assistant",
        content: [{ type: "text", text: PLAN_FENCE }],
      });
      const messages = [untouched, filtered, planned];
      const distilled = distillConductorTranscript(messages);

      expect(distilled).not.toBe(messages);
      expect(distilled[0]).toBe(untouched);
      expect(distilled[1]).not.toBe(filtered);
      expect(distilled[2]).not.toBe(planned);
    });

    it("re-renders the plan when the wave plan label changes", () => {
      const planned = message({
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: PLAN_FENCE }],
      });
      const first = distillConductorTranscript([planned], {
        wavePlanLabel: "One",
      });
      const second = distillConductorTranscript([planned], {
        wavePlanLabel: "Two",
      });
      expect(first[0]).not.toBe(second[0]);
      const block = second[0]?.content[0];
      expect(block?.type === "text" && block.text).toContain("Two");
    });
  });

  describe("collectWavePlanSteps", () => {
    it("returns the shared empty map for a transcript with no plan", () => {
      expect(
        collectWavePlanSteps([
          message({
            id: "a1",
            role: "assistant",
            content: [{ type: "text", text: "Just an answer." }],
          }),
        ]),
      ).toBe(NO_WAVE_PLAN_STEPS);
    });

    it("keys the plan's steps by the message that carried the fence", () => {
      const plan = message({
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: '```distill-wave\n{"steps":[{"role":"qa","subtask":"Run","access":[]},{"role":"researcher","subtask":"Read","access":"all"}]}\n```',
          },
        ],
      });
      const plans = collectWavePlanSteps([plan]);

      expect(plans.get("a1")?.map((step) => step.access)).toEqual([[], "all"]);
      // Identity is stable per message, so the map can be compared cheaply by
      // the caller that holds it in a React context.
      expect(collectWavePlanSteps([plan]).get("a1")).toBe(plans.get("a1"));
    });

    it("ignores an invalid fence", () => {
      expect(
        collectWavePlanSteps([
          message({
            id: "a1",
            role: "assistant",
            content: [
              { type: "text", text: '```distill-wave\n{"steps":[]}\n```' },
            ],
          }),
        ]),
      ).toBe(NO_WAVE_PLAN_STEPS);
    });
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
      // The prose survives, and the plan is rendered where its fence was: the
      // step list is the operator's only path from "wrong answer" to "step 1".
      expect(distilled[0]?.content).toEqual([
        {
          type: "text",
          text: "Fanning this out.\n\nBack shortly.\n\n1. **QA** · sees nothing — Run",
        },
      ]);
      const text = JSON.stringify(distilled[0]?.content);
      expect(text).not.toContain("distill-wave");
      expect(text).not.toContain('"access"');
    });

    it("substitutes the localized label when the plan carried no prose", () => {
      const distilled = distillAssistant([
        { type: "text", text: fence(PLAN_BODY) },
      ]);

      // The message is the wave's anchor: it must never drop out.
      expect(distilled).toHaveLength(1);
      expect(distilled[0]?.content).toEqual([
        {
          type: "text",
          text: "Plan for the brigade below.\n\n1. **QA** · sees nothing — Run",
        },
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
        {
          type: "text",
          text: "Second.\n\n1. **QA** · sees nothing — Run",
        },
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
        {
          type: "text",
          text: "Here is the plan.\n\n1. **QA** · sees nothing — Run",
        },
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

      // The badge leads, and the tool call it is about stays underneath it:
      // a warning about a leak with the evidence stripped is worse than either.
      expect(distilled[0]?.content[0]).toEqual({
        type: "systemNotification",
        notificationType: "warning",
        text: "The conductor ran a tool itself — it should only plan or answer.",
      });
      expect(
        distilled[0]?.content.some((block) => block.type === "toolRequest"),
      ).toBe(true);
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
      expect(distilled[0].content).toHaveLength(2);
      expect(distilled[0].content[1]?.type).toBe("toolRequest");
    });

    it("still strips tool blocks from a turn that only planned or answered", () => {
      // Only the leaking turn keeps its tool cards; a `toolResponse` with no
      // request in the same turn is ordinary harness noise and stays out.
      const distilled = distillConductorTranscript([
        message({
          id: "a1",
          role: "assistant",
          content: [
            { type: "text", text: "Here is the answer." },
            {
              type: "toolResponse",
              id: "t1",
              name: "shell",
              result: "ok",
              isError: false,
            },
          ],
        }),
      ]);
      expect(distilled[0]?.content).toEqual([
        { type: "text", text: "Here is the answer." },
      ]);
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
