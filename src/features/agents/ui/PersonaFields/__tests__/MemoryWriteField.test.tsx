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
  it("shows the choice first and the explanation under it", () => {
    renderField(undefined);

    const group = screen.getByRole("radiogroup");
    const state = screen.getByTestId("agent-memory-write-state");
    expect(
      group.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("selects the role default when no grant is stored", () => {
    renderField(undefined);

    expect(screen.getByTestId("agent-memory-write-inherit")).toHaveAttribute(
      "data-state",
      "checked",
    );

    const state = screen.getByTestId("agent-memory-write-state");
    expect(state).toHaveTextContent("Not set");
    // Generated from the same table the memory scanner enforces: the
    // orchestrator layer is the only one this grant is even read for.
    expect(state).toHaveTextContent("conductor: writes");
    expect(state).toHaveTextContent("orchestrator: needs this grant");
    expect(state).toHaveTextContent("worker: never writes");
  });

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

  it("says what a stored grant actually buys", () => {
    renderField(true);

    const state = screen.getByTestId("agent-memory-write-state");
    expect(state).toHaveTextContent("granted");
    // No bigger promise than the ACL keeps: the other layers ignore it.
    expect(state).toHaveTextContent("orchestrator layer");
    expect(state).not.toHaveTextContent("Not set");
  });

  it("shows a stored refusal as a stored answer", () => {
    renderField(false);

    expect(screen.getByTestId("agent-memory-write-refused")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(screen.getByTestId("agent-memory-write-state")).toHaveTextContent(
      "not granted",
    );
  });
});
