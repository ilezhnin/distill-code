import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatSessionReasoningEffortConfig } from "../../stores/chatSessionStore";
import { ReasoningEffortPill } from "../ReasoningEffortPill";

afterEach(() => {
  cleanup();
});

/** Opus 4.6's menu: no xhigh. */
const opus46Effort: ChatSessionReasoningEffortConfig = {
  configId: "effort",
  currentValue: "high",
  options: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
    { id: "max", name: "Max" },
  ],
};

async function openPill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Reasoning effort/ }));
  return screen.findByRole("radiogroup", { name: "Reasoning effort" });
}

describe("ReasoningEffortPill", () => {
  it("names the stop the model runs at and hands a chosen stop's own id to onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ReasoningEffortPill config={opus46Effort} onSelect={onSelect} />);

    expect(
      screen.getByRole("button", { name: "Reasoning effort: High" }),
    ).toBeInTheDocument();
    await openPill(user);
    expect(screen.getByRole("radio", { name: "High" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Max" }));

    expect(onSelect).toHaveBeenCalledWith("max");
  });
});
