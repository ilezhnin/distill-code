import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";

import { flockctlStopReason, stopSessionCommand } from "./stopSession";

const stop = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/features/conductor/orchestratorControls", () => ({
  stopOrchestratorSession: stop,
}));

const child = (patch: Partial<SessionNode> = {}): SessionNode => ({
  sessionId: "child-1",
  projectId: "project",
  role: "worker",
  managedBy: "agent-cli",
  parentSessionId: "parent-1",
  rootConductorId: null,
  runId: null,
  harnessId: "codex-acp",
  displayName: "Finish the task",
  status: "running",
  ...patch,
});

const run = (args: Record<string, unknown>, actor?: string) =>
  stopSessionCommand.execute(
    stopSessionCommand.schema.parse(args),
    actor ? { actor } : {},
  );

describe("flockctl session stop", () => {
  beforeEach(() => {
    stop.mockClear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  });

  it("stops a working child and says who stopped it and why", async () => {
    useConductorGraphStore.getState().registerNode(child());
    await expect(
      run({
        session_id: "child-1",
        from: "Parent chat",
        reason: "provider out of quota",
      }),
    ).resolves.toEqual({
      ok: true,
      session_id: "child-1",
      outcome: "stopped",
    });
    expect(stop).toHaveBeenCalledWith(
      "child-1",
      "Stopped by Parent chat: provider out of quota",
    );
  });

  it("stops a child that never started because its provider was out of quota", async () => {
    useConductorGraphStore
      .getState()
      .registerNode(child({ status: "starting" }));
    await expect(run({ session_id: "child-1" })).resolves.toMatchObject({
      outcome: "stopped",
    });
    expect(stop).toHaveBeenCalledWith("child-1", "Stopped through flockctl");
  });

  it("leaves a finished child alone", async () => {
    useConductorGraphStore
      .getState()
      .registerNode(child({ status: "completed" }));
    await expect(run({ session_id: "child-1" })).resolves.toMatchObject({
      outcome: "already_finished",
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("refuses a chat no other chat started", async () => {
    useConductorGraphStore
      .getState()
      .registerNode(child({ parentSessionId: null }));
    await expect(run({ session_id: "child-1" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(run({ session_id: "unknown" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("refuses a caller that names itself and did not start the child", async () => {
    useConductorGraphStore.getState().registerNode(child());
    await expect(
      run({ session_id: "child-1" }, "someone-else"),
    ).rejects.toMatchObject({ code: "spawn_not_allowed" });
    await expect(
      run({ session_id: "child-1" }, "parent-1"),
    ).resolves.toMatchObject({ outcome: "stopped" });
  });

  it("states the stop without a reason", () => {
    expect(flockctlStopReason({})).toBe("Stopped through flockctl");
    expect(flockctlStopReason({ from: "Lead" })).toBe("Stopped by Lead");
  });
});
