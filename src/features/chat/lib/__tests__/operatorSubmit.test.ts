import { describe, expect, it } from "vitest";

import { noteOperatorSubmit, operatorJustSubmitted } from "../operatorSubmit";

describe("operatorJustSubmitted", () => {
  it("holds for a moment after a send from the chat's composer", () => {
    noteOperatorSubmit("chat-a", 10_000);

    expect(operatorJustSubmitted("chat-a", 10_000)).toBe(true);
    expect(operatorJustSubmitted("chat-a", 14_999)).toBe(true);
    expect(operatorJustSubmitted("chat-a", 15_000)).toBe(false);
  });

  it("is about the chat the message was sent from", () => {
    noteOperatorSubmit("chat-b", 10_000);

    expect(operatorJustSubmitted("chat-c", 10_000)).toBe(false);
  });

  it("does not hold for a clock that moved back", () => {
    noteOperatorSubmit("chat-d", 10_000);

    expect(operatorJustSubmitted("chat-d", 9_000)).toBe(false);
  });
});
