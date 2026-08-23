import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import type { WaveStep } from "../distillWave";
import type { SessionNode } from "../types";
import { ConductorAgentFooter } from "./ConductorAgentFooter";

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "project-1",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "host",
    rootConductorId: "host",
    runId: null,
    harnessId: "goose",
    displayName: overrides.sessionId,
    status: "running",
    ...overrides,
  };
}

describe("ConductorAgentFooter open intent", () => {
  it("opens a real child's chip in a tab instead of navigating away", async () => {
    const onOpen = vi.fn();
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[node({ sessionId: "child-1", displayName: "Atlas" })]}
        reportsByRunId={{}}
        onOpen={onOpen}
      />,
    );

    await userEvent.click(screen.getByTestId("conductor-agent-chip"));

    expect(onOpen).toHaveBeenCalledWith("child-1", "openInTab");
  });

  it("leaves chips unclickable when the host offers no open handler", () => {
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[node({ sessionId: "child-1", displayName: "Atlas" })]}
        reportsByRunId={{}}
      />,
    );

    expect(screen.getByTestId("conductor-agent-chip")).toBeInTheDocument();
  });
});

describe("failure attribution affordances on the chip row", () => {
  const PLAN: WaveStep[] = [
    { role: "researcher", subtask: "Read the docs", access: [] },
    { role: "qa", subtask: "Verify", access: "all" },
  ];

  it("orders chips by their wave step, not by spawn order", () => {
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[
          node({ sessionId: "b", displayName: "Bohr", stepIndex: 1 }),
          node({ sessionId: "a", displayName: "Curie", stepIndex: 0 }),
        ]}
        reportsByRunId={{}}
        planSteps={PLAN}
      />,
    );

    expect(
      screen
        .getAllByTestId("brigade-chip")
        .map((chip) => chip.getAttribute("data-step")),
    ).toEqual(["1", "2"]);
  });

  it("names each step's number and access mode", () => {
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[
          node({ sessionId: "a", displayName: "Curie", stepIndex: 0 }),
          node({ sessionId: "b", displayName: "Bohr", stepIndex: 1 }),
        ]}
        reportsByRunId={{}}
        planSteps={PLAN}
      />,
    );

    expect(
      screen.getAllByTestId("brigade-chip-access").map((el) => el.textContent),
    ).toEqual(["sees nothing", "sees earlier reports"]);
    expect(screen.getAllByTestId("conductor-agent-chip")[0]).toHaveAttribute(
      "aria-label",
      "Step 1 (sees nothing): Curie, running",
    );
  });

  it("shows the step number alone when the plan is not in this transcript", () => {
    // A historical wave whose plan message scrolled out of the loaded window:
    // the step index is on the node, the access mode is only in the plan.
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[node({ sessionId: "a", displayName: "Curie", stepIndex: 0 })]}
        reportsByRunId={{}}
      />,
    );

    expect(screen.queryByTestId("brigade-chip-access")).toBeNull();
    expect(screen.getByTestId("conductor-agent-chip")).toHaveAttribute(
      "aria-label",
      "Step 1: Curie, running",
    );
  });

  it("leaves a chip with no step index alone", () => {
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[node({ sessionId: "a", displayName: "Atlas" })]}
        reportsByRunId={{}}
      />,
    );

    expect(screen.queryByTestId("brigade-chip-step")).toBeNull();
    expect(screen.getByTestId("conductor-agent-chip")).toHaveAttribute(
      "aria-label",
      "Atlas, running",
    );
  });
});
