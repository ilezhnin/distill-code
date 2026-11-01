import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SessionNode } from "../../types";
import {
  WorkerBriefHeader,
  workerRoleLabel,
  workerRunLabel,
} from "../WorkerBriefHeader";

function node(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: "worker-1",
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: "run-1",
    harnessId: "claude-acp",
    modelId: "claude-sonnet-5-5",
    effort: "high",
    roleId: "scout",
    displayName: "Scout · waveEngine",
    status: "running",
    ...overrides,
  };
}

const conductor = node({
  sessionId: "conductor-1",
  role: "conductor",
  parentSessionId: null,
  roleId: undefined,
  displayName: "Producer",
});

describe("WorkerBriefHeader", () => {
  it("names the worker, its role, what it runs on, and the chat that sent it", async () => {
    const user = userEvent.setup();
    const onOpenParent = vi.fn();
    render(
      <WorkerBriefHeader
        messageId="u1"
        node={node({ fast: true })}
        parent={conductor}
        onOpenParent={onOpenParent}
      />,
    );

    expect(screen.getByText("Scout · waveEngine")).toBeInTheDocument();
    expect(screen.getByText("· Scout")).toBeInTheDocument();
    expect(
      screen.getByText("· claude-sonnet-5-5 · high · fast"),
    ).toBeInTheDocument();
    expect(screen.getByText("Brief")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Started by Producer" }),
    );
    expect(onOpenParent).toHaveBeenCalledTimes(1);
  });

  it("still says who sent the brief when the parent is not in the graph", () => {
    render(<WorkerBriefHeader messageId="u1" node={node()} />);
    expect(screen.getByText("Started by another chat")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("splits a legacy model id that carries its effort, and never repeats a role that is the name", () => {
    expect(
      workerRunLabel(
        { modelId: "gpt-5-codex[high]", effort: undefined },
        "fast",
      ),
    ).toBe("gpt-5-codex · high");
    expect(workerRunLabel({ modelId: undefined }, "fast")).toBeUndefined();
    expect(
      workerRoleLabel({ roleId: "scout", displayName: "Scout" }),
    ).toBeUndefined();
    expect(
      workerRoleLabel({ roleId: undefined, displayName: "Atlas" }),
    ).toBeUndefined();
  });
});
