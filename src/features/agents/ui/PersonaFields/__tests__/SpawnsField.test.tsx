import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import type { AgentSpawnLayer } from "@/shared/types/agents";

import { SpawnsField } from "../SpawnsField";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

function renderField(value: AgentSpawnLayer[] | undefined) {
  const onChange = vi.fn();
  renderWithProviders(<SpawnsField value={value} onChange={onChange} />);
  return { onChange };
}

describe("SpawnsField", () => {
  it("writes the deliberate empty override, not a clear, on the last uncheck", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(["worker"]);

    await user.click(screen.getByTestId("agent-spawns-toggle-worker"));

    // Unchecking every box is the operator saying "starts nothing". Writing
    // null here would silently hand the agent its layer's default back.
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("returns to unset only through Clear override", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(["orchestrator", "worker"]);

    await user.click(screen.getByTestId("agent-spawns-clear"));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps a hand-written conductor permission visible and intact", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(["conductor"]);

    // The editor does not offer this layer, but a persona that carries it
    // must not lose it the moment another box is touched.
    expect(screen.getByTestId("agent-spawns-toggle-conductor")).toHaveAttribute(
      "data-state",
      "checked",
    );

    await user.click(screen.getByTestId("agent-spawns-toggle-worker"));

    expect(onChange).toHaveBeenCalledWith(["conductor", "worker"]);
  });
});
