import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCallAdapter } from "../ToolCallAdapter";

// `JSON.stringify` consults `toJSON`, so this counts how many times the tool's
// payload was actually serialised for display.
function countingPayload(text: string) {
  const serialize = vi.fn(() => text);
  return { payload: { serialize, value: { toJSON: serialize } } };
}

describe("ToolCallAdapter payload formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not serialise the payload while the card is closed", () => {
    const { payload } = countingPayload("a".repeat(2000));

    render(
      <ToolCallAdapter
        name="Write"
        arguments={{ content: payload.value }}
        status="completed"
        agentWorkLayout
        open={false}
      />,
    );

    expect(payload.serialize).not.toHaveBeenCalled();
  });

  it("serialises the payload when the card is open", () => {
    const { payload } = countingPayload("a".repeat(2000));

    render(
      <ToolCallAdapter
        name="Write"
        arguments={{ content: payload.value }}
        status="completed"
        agentWorkLayout
        open
      />,
    );

    expect(payload.serialize).toHaveBeenCalled();
  });

  it("does not re-serialise the payload when the card re-renders unchanged", () => {
    const { payload } = countingPayload("a".repeat(2000));
    const args = { content: payload.value };

    const { rerender } = render(
      <ToolCallAdapter
        name="Write"
        arguments={args}
        status="completed"
        agentWorkLayout
        open
      />,
    );
    const afterFirstRender = payload.serialize.mock.calls.length;

    rerender(
      <ToolCallAdapter
        name="Write"
        arguments={args}
        status="completed"
        agentWorkLayout
        open
      />,
    );

    expect(payload.serialize.mock.calls.length).toBe(afterFirstRender);
  });
});
