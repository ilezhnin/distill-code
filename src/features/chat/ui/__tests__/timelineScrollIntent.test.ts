import { describe, expect, it } from "vitest";

import { shouldUserMessageResumeTimelineFollow } from "../timelineScrollIntent";

describe("shouldUserMessageResumeTimelineFollow", () => {
  it("takes a reader in history to the message they just sent", () => {
    expect(
      shouldUserMessageResumeTimelineFollow({
        origin: "operator_direct",
        operatorJustSubmitted: true,
      }),
    ).toBe(true);
    expect(
      shouldUserMessageResumeTimelineFollow({
        origin: undefined,
        operatorJustSubmitted: true,
      }),
    ).toBe(true);
  });

  it("leaves them there for a message they did not just send", () => {
    // A queued message going out long after it was typed.
    expect(
      shouldUserMessageResumeTimelineFollow({
        origin: "operator_direct",
        operatorJustSubmitted: false,
      }),
    ).toBe(false);
  });

  it("leaves them there for a message another session delivered", () => {
    // An agent's report landing right after the operator's own send.
    expect(
      shouldUserMessageResumeTimelineFollow({
        origin: "distillctl_cross_session",
        operatorJustSubmitted: true,
      }),
    ).toBe(false);
  });
});
