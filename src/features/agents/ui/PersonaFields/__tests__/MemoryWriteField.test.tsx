import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { MemoryWriteField } from "../MemoryWriteField";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

function renderField(value: boolean | undefined) {
  const onChange = vi.fn();
  renderWithProviders(<MemoryWriteField value={value} onChange={onChange} />);
  return { onChange };
}

describe("MemoryWriteField", () => {
  it("stores the grant when the operator grants it", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(undefined);

    await user.click(screen.getByTestId("agent-memory-write-granted"));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("stores a refusal as false, not as an absent key", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(undefined);

    await user.click(screen.getByTestId("agent-memory-write-refused"));

    // The orchestrator layer treats false and absent alike, but the editor
    // must not: one is the operator's answer, the other is silence.
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("returns to the role default with an explicit clear", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(true);

    expect(screen.getByTestId("agent-memory-write-granted")).toHaveAttribute(
      "data-state",
      "checked",
    );

    await user.click(screen.getByTestId("agent-memory-write-inherit"));

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
