import { describe, expect, it } from "vitest";

import type { MessageContent, ToolKind } from "@/shared/types/messages";

import {
  isMutatingToolKind,
  turnHasMutatingToolCall,
} from "./conductorSelfExecution";

function toolRequest(toolKind?: ToolKind): MessageContent {
  return {
    type: "toolRequest",
    id: "t1",
    name: "shell",
    arguments: {},
    status: "completed",
    ...(toolKind ? { toolKind } : {}),
  };
}

describe("isMutatingToolKind", () => {
  it("keeps looking at the world quiet", () => {
    for (const kind of [
      "read",
      "search",
      "think",
      "fetch",
      "switch_mode",
    ] as const) {
      expect(isMutatingToolKind(kind)).toBe(false);
    }
  });

  it("flags everything that can change state", () => {
    for (const kind of [
      "edit",
      "delete",
      "move",
      "execute",
      "other",
    ] as const) {
      expect(isMutatingToolKind(kind)).toBe(true);
    }
  });

  it("treats an unreported kind as mutating — the pre-tiering behaviour", () => {
    expect(isMutatingToolKind(undefined)).toBe(true);
  });
});

describe("turnHasMutatingToolCall", () => {
  it("flags a turn that ran a state-changing tool", () => {
    expect(
      turnHasMutatingToolCall([
        { type: "text", text: "on it" },
        toolRequest("execute"),
      ]),
    ).toBe(true);
  });

  it("stays quiet on read-only exploration — the cry-wolf fix", () => {
    expect(
      turnHasMutatingToolCall([
        toolRequest("read"),
        toolRequest("search"),
        { type: "text", text: "the answer, from what I read" },
      ]),
    ).toBe(false);
  });

  it("flags a mixed turn: one mutation among any number of reads", () => {
    expect(
      turnHasMutatingToolCall([
        toolRequest("read"),
        toolRequest("edit"),
        toolRequest("search"),
      ]),
    ).toBe(true);
  });

  it("still flags a tool call whose harness reported no kind", () => {
    expect(turnHasMutatingToolCall([toolRequest()])).toBe(true);
  });

  it("leaves a plan-or-answer turn alone", () => {
    expect(
      turnHasMutatingToolCall([
        { type: "text", text: '```distill-wave\n{"steps":[]}\n```' },
        { type: "thinking", text: "hmm" },
      ]),
    ).toBe(false);
  });

  it("is safe on an empty or missing turn", () => {
    expect(turnHasMutatingToolCall([])).toBe(false);
    expect(turnHasMutatingToolCall(undefined)).toBe(false);
  });
});
