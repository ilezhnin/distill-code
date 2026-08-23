import { describe, expect, it } from "vitest";

import type { MessageContent } from "@/shared/types/messages";

import { turnHasToolCall } from "./conductorSelfExecution";

const TOOL_REQUEST: MessageContent = {
  type: "toolRequest",
  id: "t1",
  name: "shell",
  arguments: {},
  status: "completed",
};

describe("turnHasToolCall", () => {
  it("flags a turn that ran a tool", () => {
    expect(
      turnHasToolCall([{ type: "text", text: "on it" }, TOOL_REQUEST]),
    ).toBe(true);
  });

  it("leaves a plan-or-answer turn alone", () => {
    expect(
      turnHasToolCall([
        { type: "text", text: '```distill-wave\n{"steps":[]}\n```' },
        { type: "thinking", text: "hmm" },
      ]),
    ).toBe(false);
  });

  it("is safe on an empty or missing turn", () => {
    expect(turnHasToolCall([])).toBe(false);
    expect(turnHasToolCall(undefined)).toBe(false);
  });
});
