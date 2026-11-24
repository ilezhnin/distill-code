import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";
import {
  __resetAllPersonaHandoffs,
  claimPersonaHandoff,
} from "@/shared/api/acpPersonaHandoff";

import {
  __resetSessionTokenKeyForTests,
  sessionTokenFor,
} from "../../sessionToken";
import type { CommandContext } from "../types";
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

const run = (args: Record<string, unknown>, caller?: string | CommandContext) =>
  stopSessionCommand.execute(
    stopSessionCommand.schema.parse(args),
    typeof caller === "string" ? { actor: caller } : (caller ?? {}),
  );

/** A call from an agent's shell on the built-in host: the mark, no actor. */
const AGENT: CommandContext = { fromAgent: true };

describe("flockctl session stop", () => {
  beforeEach(() => {
    stop.mockClear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    __resetSessionTokenKeyForTests();
    __resetAllPersonaHandoffs();
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

  // The built-in host sends no actor, only the mark of an agent's shell.
  // The rule above then applied to nobody, and any agent stopped any child.
  it("refuses an agent's call that does not prove which session makes it", async () => {
    useConductorGraphStore.getState().registerNode(child());
    await expect(run({ session_id: "child-1" }, AGENT)).rejects.toMatchObject({
      code: "spawn_not_allowed",
      message: expect.stringContaining("--session-token"),
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops a child for the chat that started it, proven with that chat's token", async () => {
    useConductorGraphStore.getState().registerNode(child());
    await expect(
      run(
        {
          session_id: "child-1",
          session_token: await sessionTokenFor("parent-1"),
        },
        AGENT,
      ),
    ).resolves.toMatchObject({ outcome: "stopped" });
    expect(stop).toHaveBeenCalledWith("child-1", "Stopped through flockctl");
  });

  it("refuses another chat's token, and a token this app did not make", async () => {
    useConductorGraphStore.getState().registerNode(child());
    for (const session_token of [
      await sessionTokenFor("someone-else"),
      // The child stopping itself is not its starter either.
      await sessionTokenFor("child-1"),
      `parent-1.${"0".repeat(16)}`,
    ]) {
      await expect(
        run({ session_id: "child-1", session_token }, AGENT),
      ).rejects.toMatchObject({ code: "spawn_not_allowed" });
    }
    expect(stop).not.toHaveBeenCalled();
  });

  it("lets a chat stop what its script started under one of its executors", async () => {
    // The conductor's dispatcher hangs a reader under the step that
    // launched it, with the conductor's token in its environment.
    const graph = useConductorGraphStore.getState();
    graph.registerNode(
      child({ sessionId: "executor-1", parentSessionId: "parent-1" }),
    );
    graph.registerNode(
      child({ sessionId: "reader-1", parentSessionId: "executor-1" }),
    );
    graph.registerNode(
      child({ sessionId: "executor-2", parentSessionId: "parent-1" }),
    );
    // A sibling executor did not start the reader.
    await expect(
      run(
        {
          session_id: "reader-1",
          session_token: await sessionTokenFor("executor-2"),
        },
        AGENT,
      ),
    ).rejects.toMatchObject({ code: "spawn_not_allowed" });
    expect(stop).not.toHaveBeenCalled();
    await expect(
      run(
        {
          session_id: "reader-1",
          session_token: await sessionTokenFor("parent-1"),
        },
        AGENT,
      ),
    ).resolves.toMatchObject({ outcome: "stopped" });
    expect(stop).toHaveBeenCalledWith("reader-1", "Stopped through flockctl");
  });

  it("sends the starting chat its context again when an unproven call names its child", async () => {
    useConductorGraphStore.getState().registerNode(child());
    const delivered = () =>
      claimPersonaHandoff("parent-1", "claude-acp", "persona", "app");
    expect(delivered()).not.toBeNull();
    expect(delivered()).toBeNull();
    await expect(run({ session_id: "child-1" }, AGENT)).rejects.toMatchObject({
      code: "spawn_not_allowed",
    });
    expect(delivered()).not.toBeNull();
  });

  it("states the stop without a reason", () => {
    expect(flockctlStopReason({})).toBe("Stopped through flockctl");
    expect(flockctlStopReason({ from: "Lead" })).toBe("Stopped by Lead");
  });
});
