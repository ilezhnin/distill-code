import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";

import { useConductorGraphStore } from "../conductorGraphStore";
import type { SessionNode } from "../types";
import { SidebarAgentsSection } from "./SidebarAgentsSection";

vi.mock("../orchestratorControls", () => ({
  stopOrchestratorSession: vi.fn().mockResolvedValue(undefined),
}));

function node(over: Partial<SessionNode> & { sessionId: string }): SessionNode {
  return {
    projectId: "p1",
    role: "worker",
    managedBy: "wave",
    parentSessionId: null,
    rootConductorId: null,
    runId: null,
    harnessId: "goose",
    displayName: over.sessionId,
    status: "running",
    ...over,
  };
}

function graph(...nodes: SessionNode[]) {
  const nodesById: Record<string, SessionNode> = {};
  for (const entry of nodes) nodesById[entry.sessionId] = entry;
  useConductorGraphStore.setState({ nodesById, reportsByRunId: {} });
}

beforeEach(() => {
  useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
});

describe("SidebarAgentsSection", () => {
  it("stays out of the way when nothing is working", () => {
    graph(
      node({ sessionId: "c", role: "conductor", status: "completed" }),
      node({ sessionId: "w", parentSessionId: "c", status: "completed" }),
    );
    const { container } = renderWithProviders(
      <SidebarAgentsSection projectId="p1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the project's live agents nested under whoever started them", () => {
    graph(
      node({ sessionId: "c", role: "conductor", displayName: "Producer" }),
      node({
        sessionId: "orch",
        role: "orchestrator",
        displayName: "Atlas",
        parentSessionId: "c",
      }),
      node({
        sessionId: "w",
        displayName: "Curie",
        parentSessionId: "orch",
      }),
    );
    renderWithProviders(<SidebarAgentsSection projectId="p1" />);

    const rows = screen.getAllByTestId("agent-tree-row");
    expect(rows.map((row) => row.getAttribute("data-depth"))).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(rows[2]).toHaveAttribute("data-session-id", "w");
  });

  it("keeps another project's agents out of this one", () => {
    graph(
      node({ sessionId: "mine", role: "conductor" }),
      node({ sessionId: "theirs", role: "conductor", projectId: "p2" }),
    );
    renderWithProviders(<SidebarAgentsSection projectId="p1" />);
    expect(screen.getAllByTestId("agent-tree-row")).toHaveLength(1);
  });

  it("opens the agent's own chat from its row", async () => {
    const onSelectSession = vi.fn();
    graph(node({ sessionId: "w", displayName: "Curie" }));
    renderWithProviders(
      <SidebarAgentsSection projectId="p1" onSelectSession={onSelectSession} />,
    );

    await userEvent.click(screen.getByTestId("agent-tree-open"));

    expect(onSelectSession).toHaveBeenCalledWith("w");
  });

  it("keeps a finished parent whose worker is still running", () => {
    // Dropping it would orphan the worker and lose the one fact that
    // explains why it is running at all.
    graph(
      node({ sessionId: "c", role: "conductor", status: "completed" }),
      node({ sessionId: "w", parentSessionId: "c", status: "running" }),
    );
    renderWithProviders(<SidebarAgentsSection projectId="p1" />);
    expect(screen.getAllByTestId("agent-tree-row")).toHaveLength(2);
  });
});
