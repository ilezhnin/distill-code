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

  it("wears the plan's explicit model on the step's chip (4a/D5)", () => {
    const pinned: WaveStep[] = [
      {
        role: "researcher",
        subtask: "Read the docs",
        access: [],
        model: "opus",
      },
      { role: "qa", subtask: "Verify", access: "all" },
    ];
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[node({ sessionId: "a", displayName: "Curie", stepIndex: 0 })]}
        reportsByRunId={{}}
        planSteps={pinned}
      />,
    );

    // One suffix: the spawned, pinned step. The pending unpinned step and any
    // ranking-targeted chip stay bare — the suffix marks the instruction.
    expect(
      screen.getAllByTestId("brigade-chip-model").map((el) => el.textContent),
    ).toEqual(["opus"]);
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

describe("the shape of the wave, before it has one", () => {
  const PLAN: WaveStep[] = [
    { role: "researcher", subtask: "Read the docs", access: [] },
    { role: "qa", subtask: "Verify", access: "all" },
  ];

  it("holds a place for every step the plan promised", () => {
    // A four-step wave whose first step is slow to start used to render as
    // one chip, and grew sideways as the others spawned.
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[node({ sessionId: "a", displayName: "Curie", stepIndex: 0 })]}
        reportsByRunId={{}}
        planSteps={PLAN}
      />,
    );

    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-status", "running");
    expect(chips[1]).toHaveAttribute("data-status", "pending");
  });

  it("draws the whole row when nothing has started at all", () => {
    renderWithProviders(
      <ConductorAgentFooter nodes={[]} reportsByRunId={{}} planSteps={PLAN} />,
    );

    expect(screen.getAllByTestId("brigade-chip")).toHaveLength(2);
    expect(screen.getAllByTestId("brigade-chip-pending-dot")).toHaveLength(2);
  });

  it("names a not-yet-spawned step after its role", () => {
    renderWithProviders(
      <ConductorAgentFooter nodes={[]} reportsByRunId={{}} planSteps={PLAN} />,
    );

    expect(screen.getAllByTestId("conductor-agent-chip")[0]).toHaveAttribute(
      "aria-label",
      "Step 1 (sees nothing): Researcher, not started",
    );
  });

  it("does not offer to open or stop a step that does not exist yet", async () => {
    const onOpen = vi.fn();
    const onStop = vi.fn();
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[]}
        reportsByRunId={{}}
        planSteps={PLAN}
        onOpen={onOpen}
        onStop={onStop}
      />,
    );

    await userEvent.click(screen.getAllByTestId("conductor-agent-chip")[0]);

    expect(onOpen).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("conductor-agent-stop"),
    ).not.toBeInTheDocument();
  });

  it("still renders nothing when there is neither a plan nor a child", () => {
    renderWithProviders(
      <ConductorAgentFooter nodes={[]} reportsByRunId={{}} />,
    );
    expect(
      screen.queryByTestId("conductor-agent-footer"),
    ).not.toBeInTheDocument();
  });
});

describe("two waves under one message (P58)", () => {
  it("keeps a revision's executors in their own labelled row", () => {
    // A revision spawns against the same plan message its predecessor did.
    // Until they were grouped, eight chips claimed to be one brigade of
    // eight, and the plan's own slots were shared out between two waves.
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[
          node({
            sessionId: "a",
            displayName: "Bohr",
            waveId: "w1",
            createdAt: 1,
            status: "completed",
          }),
          node({
            sessionId: "b",
            displayName: "Curie",
            waveId: "w2",
            createdAt: 5,
          }),
        ]}
        reportsByRunId={{}}
      />,
    );

    const rows = screen.getAllByTestId("conductor-agent-footer-wave");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-wave-id", "w1");
    expect(rows[1]).toHaveAttribute("data-wave-id", "w2");
    const labels = screen
      .getAllByTestId("conductor-agent-footer-wave-label")
      .map((label) => label.textContent);
    expect(labels).toEqual(["Brigade", "Revision"]);
  });

  it("says nothing about waves when there is only one", () => {
    renderWithProviders(
      <ConductorAgentFooter
        nodes={[node({ sessionId: "a", displayName: "Bohr", waveId: "w1" })]}
        reportsByRunId={{}}
      />,
    );
    expect(
      screen.queryByTestId("conductor-agent-footer-wave-label"),
    ).toBeNull();
  });
});
