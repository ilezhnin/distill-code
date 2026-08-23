import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
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
