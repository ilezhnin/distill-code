/**
 * The cheap halves of a transcript scan.
 *
 * Both helpers exist for speed, so what has to be pinned is that they give the
 * same answers the expensive versions gave: `messageMentions` agrees with
 * `getTextContent(...).includes(...)`, and a set built from a list of ids
 * answers for exactly that list.
 */
import { describe, expect, it } from "vitest";

import { getTextContent, type Message } from "@/shared/types/messages";

import { messageIdSet, messageMentions } from "./transcriptScan";

function message(content: Message["content"]): Message {
  return { id: "m", role: "assistant", created: 1, content };
}

function text(...parts: string[]): Message {
  return message(parts.map((part) => ({ type: "text", text: part }) as const));
}

describe("messageMentions", () => {
  it("finds a needle in the only text part", () => {
    expect(
      messageMentions(text("see ```distill-memory"), "distill-memory"),
    ).toBe(true);
  });

  it("finds a needle in a later part", () => {
    const subject = text("Noted.", "```distill-recall");
    expect(messageMentions(subject, "distill-recall")).toBe(true);
  });

  it("says no when no part mentions it", () => {
    expect(
      messageMentions(text("Noted.", "Working on it."), "distill-todo"),
    ).toBe(false);
  });

  it("says no for an empty message", () => {
    expect(messageMentions(message([]), "distill-memory")).toBe(false);
  });

  it("ignores content that is not text", () => {
    const subject = message([
      { type: "image", data: "distill-memory", mimeType: "image/png" },
    ]);
    expect(messageMentions(subject, "distill-memory")).toBe(false);
  });

  it("gives the answer the joined text gives, part boundaries included", () => {
    // The join is a newline, so a tag split across two parts is not a tag —
    // for the joined string and for this walk alike. Pinned because the two
    // are used interchangeably: the walk decides whether the join happens.
    const cases: Message[] = [
      text("```distill-memory"),
      text("Noted.", "```distill-memory"),
      text("```distill-", "memory"),
      text("nothing here"),
      message([]),
    ];
    for (const subject of cases) {
      expect(messageMentions(subject, "distill-memory")).toBe(
        getTextContent(subject).includes("distill-memory"),
      );
    }
  });
});

describe("messageIdSet", () => {
  it("answers for the ids the list holds", () => {
    const set = messageIdSet(["m-1", "m-2"]);
    expect(set.has("m-1")).toBe(true);
    expect(set.has("m-3")).toBe(false);
  });

  it("reuses the set built for the same list", () => {
    const ids = ["m-1"];
    expect(messageIdSet(ids)).toBe(messageIdSet(ids));
  });

  it("builds a new set for a new list, so a commit is never stale", () => {
    const before = messageIdSet(["m-1"]);
    const after = messageIdSet(["m-1", "m-2"]);
    expect(after).not.toBe(before);
    expect(after.has("m-2")).toBe(true);
  });

  it("answers for an empty list", () => {
    expect(messageIdSet([]).has("m-1")).toBe(false);
  });
});
