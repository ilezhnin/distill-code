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
  it("shows the toggles first and the explanation under them", () => {
    renderField(undefined);

    // The operator complained about fields that are a paragraph until you
    // find the hidden entry point: the controls are there from the start.
    expect(screen.getByTestId("agent-spawns-toggle-orchestrator")).toBeTruthy();
    expect(screen.getByTestId("agent-spawns-toggle-worker")).toBeTruthy();

    const group = screen.getByRole("group");
    const state = screen.getByTestId("agent-spawns-state");
    expect(
      group.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("names the role defaults it is falling back to when nothing is set", () => {
    renderField(undefined);

    const state = screen.getByTestId("agent-spawns-state");
    expect(state).toHaveTextContent("Not set");
    // Generated from the ACL table, so it cannot promise a default the code
    // does not give: conductors start orchestrators and workers, workers
    // start nothing.
    expect(state).toHaveTextContent("conductor: orchestrators, workers");
    expect(state).toHaveTextContent("worker: nothing");
    expect(screen.queryByTestId("agent-spawns-clear")).toBeNull();
  });

  it("starts an override from the first box the operator checks", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(undefined);

    await user.click(screen.getByTestId("agent-spawns-toggle-worker"));

    expect(onChange).toHaveBeenCalledWith(["worker"]);
  });

  it("writes the deliberate empty override, not a clear, on the last uncheck", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(["worker"]);

    await user.click(screen.getByTestId("agent-spawns-toggle-worker"));

    // Unchecking every box is the operator saying "starts nothing". Writing
    // null here would silently hand the agent its layer's default back.
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("offers the empty override directly from the unset state", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(undefined);

    await user.click(screen.getByTestId("agent-spawns-set-nothing"));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("says an empty override means nothing, not nothing set", () => {
    renderField([]);

    const state = screen.getByTestId("agent-spawns-state");
    expect(state).toHaveTextContent("starts nothing");
    expect(state).not.toHaveTextContent("Not set");
    expect(screen.getByTestId("agent-spawns-clear")).toBeTruthy();
  });

  it("returns to unset only through Clear override", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField(["orchestrator", "worker"]);

    await user.click(screen.getByTestId("agent-spawns-clear"));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("lists a stored override and keeps its boxes checked", () => {
    renderField(["worker"]);

    expect(screen.getByTestId("agent-spawns-toggle-worker")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(
      screen.getByTestId("agent-spawns-toggle-orchestrator"),
    ).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByTestId("agent-spawns-state")).toHaveTextContent(
      "starts workers",
    );
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
