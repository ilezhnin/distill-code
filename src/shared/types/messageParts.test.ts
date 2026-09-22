import { describe, expect, it } from "vitest";
import {
  findMessagePartSpan,
  messagePartSpans,
  sameMessagePart,
  visibleMessagePartSpans,
} from "./messageParts";
import type { Message, MessageContent } from "./messages";

const tool = (id: string): MessageContent => ({
  type: "toolRequest",
  id,
  name: "read",
  arguments: {},
  status: "completed",
});
const image: MessageContent = {
  type: "image",
  data: "aGk=",
  mimeType: "image/png",
};

describe("messagePartSpans", () => {
  it("counts runs of text and reasoning and pairs a tool call with its result", () => {
    const spans = messagePartSpans([
      { type: "text", text: "Mapping " },
      { type: "text", text: "the codebase." },
      tool("t1"),
      { type: "thinking", text: "hmm" },
      { type: "thinking", text: " more" },
      { type: "text", text: "Reading more." },
      {
        type: "toolResponse",
        id: "t1",
        name: "read",
        result: "",
        isError: false,
      },
      tool("t2"),
      { type: "text", text: "the answer" },
    ]);
    expect(spans).toEqual([
      { part: { kind: "text", ordinal: 0 }, indexes: [0, 1] },
      { part: { kind: "tool", toolCallId: "t1" }, indexes: [2, 6] },
      { part: { kind: "reasoning", ordinal: 0 }, indexes: [3, 4] },
      { part: { kind: "text", ordinal: 1 }, indexes: [5] },
      { part: { kind: "tool", toolCallId: "t2" }, indexes: [7] },
      { part: { kind: "text", ordinal: 2 }, indexes: [8] },
    ]);
  });

  it("ends a run at a companion block", () => {
    const spans = messagePartSpans([
      { type: "text", text: "before" },
      image,
      { type: "text", text: "after" },
    ]);
    expect(spans.map((span) => span.part)).toEqual([
      { kind: "text", ordinal: 0 },
      { kind: "text", ordinal: 1 },
    ]);
  });
});

describe("visibleMessagePartSpans", () => {
  it("skips what the user never saw and keeps indexes into the message", () => {
    const message: Message = {
      id: "m1",
      role: "user",
      created: 1,
      content: [
        {
          type: "text",
          text: "skill instructions",
          annotations: { audience: ["assistant"] },
        },
        { type: "text", text: "hello" },
        image,
        { type: "text", text: "world" },
      ],
    };
    expect(visibleMessagePartSpans(message)).toEqual([
      { part: { kind: "text", ordinal: 0 }, indexes: [1] },
      { part: { kind: "text", ordinal: 1 }, indexes: [3] },
    ]);
    expect(
      findMessagePartSpan(message, { kind: "text", ordinal: 1 })?.indexes,
    ).toEqual([3]);
    expect(findMessagePartSpan(message, { kind: "text", ordinal: 2 })).toBe(
      undefined,
    );
  });
});

describe("sameMessagePart", () => {
  it("compares by kind and ordinal, or by tool call id", () => {
    expect(
      sameMessagePart(
        { kind: "text", ordinal: 1 },
        { kind: "text", ordinal: 1 },
      ),
    ).toBe(true);
    expect(
      sameMessagePart(
        { kind: "text", ordinal: 1 },
        { kind: "reasoning", ordinal: 1 },
      ),
    ).toBe(false);
    expect(
      sameMessagePart(
        { kind: "tool", toolCallId: "t1" },
        { kind: "tool", toolCallId: "t1" },
      ),
    ).toBe(true);
    expect(
      sameMessagePart(
        { kind: "tool", toolCallId: "t1" },
        { kind: "text", ordinal: 0 },
      ),
    ).toBe(false);
  });
});
