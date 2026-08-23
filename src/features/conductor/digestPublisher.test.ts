import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode, StructuredReport } from "./types";

const deliverEnvelope = vi.hoisted(() => vi.fn());
vi.mock("./digestDelivery", () => ({
  deliverEnvelope,
  classifyDigestDispatchError: () => ({ status: "failed" as const }),
}));

const { publishTerminalGroupDigests, resetDigestPublisherForTests } =
  await import("./digestPublisher");

const PARENT = "conductor-1";

function node(over: Partial<SessionNode> & { sessionId: string }): SessionNode {
  return {
    projectId: "project",
    role: "orchestrator",
    managedBy: "ui",
    parentSessionId: PARENT,
    rootConductorId: PARENT,
    runId: `run-${over.sessionId}`,
    harnessId: "goose",
    displayName: over.sessionId,
    status: "completed",
    ...over,
  };
}

function report(runId: string, summary: string): StructuredReport {
  return {
    runId,
    status: "completed",
    summary,
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
  };
}

function workersFor(parentSessionId: string): SessionNode[] {
  return useConductorGraphStore
    .getState()
    .getChildren(parentSessionId)
    .filter((candidate) => candidate.role === "worker");
}

function notices(sessionId: string): string[] {
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).flatMap(
    (message) =>
      message.content.flatMap((block) =>
        block.type === "systemNotification" ? [block.text] : [],
      ),
  );
}

describe("publishTerminalGroupDigests", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    resetDigestPublisherForTests();
    deliverEnvelope.mockReset();
    deliverEnvelope.mockResolvedValue({ status: "dispatched" as const });
    useChatStore.setState({ messagesBySession: {} });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
  });

  it("delivers a legacy orchestrator turn through the envelope, not as a bubble", async () => {
    const graph = useConductorGraphStore.getState();
    graph.registerNode(node({ sessionId: "orch-1", anchorMessageId: "msg-1" }));
    graph.attachReport(report("run-orch-1", "Legacy work done"));

    publishTerminalGroupDigests(workersFor);
    await Promise.resolve();

    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    const [target, text] = deliverEnvelope.mock.calls[0];
    expect(target).toBe(PARENT);
    expect(text).toContain("Legacy work done");
    // No synthetic assistant message is appended any more.
    expect(useChatStore.getState().messagesBySession[PARENT]).toBeUndefined();
  });

  it("publishes a turn exactly once, however often the sync fires", async () => {
    const graph = useConductorGraphStore.getState();
    graph.registerNode(node({ sessionId: "orch-1", anchorMessageId: "msg-1" }));
    graph.attachReport(report("run-orch-1", "Legacy work done"));

    publishTerminalGroupDigests(workersFor);
    publishTerminalGroupDigests(workersFor);
    await Promise.resolve();
    publishTerminalGroupDigests(workersFor);
    await Promise.resolve();

    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    expect(
      useConductorGraphStore.getState().getReport("run-orch-1")
        ?.publishedToParent,
    ).toBe(true);
  });

  it("waits for every leaf of the turn to finish", async () => {
    const graph = useConductorGraphStore.getState();
    graph.registerNode(node({ sessionId: "orch-1", anchorMessageId: "msg-1" }));
    graph.registerNode(
      node({
        sessionId: "w-1",
        role: "worker",
        parentSessionId: "orch-1",
        status: "running",
      }),
    );
    graph.attachReport(report("run-w-1", "half done"));

    publishTerminalGroupDigests(workersFor);
    await Promise.resolve();
    expect(deliverEnvelope).not.toHaveBeenCalled();

    graph.patchNode("w-1", { status: "completed" });
    publishTerminalGroupDigests(workersFor);
    await Promise.resolve();
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
  });

  it("ignores wave children — the wave publishes its own digest", async () => {
    const graph = useConductorGraphStore.getState();
    graph.registerNode(
      node({
        sessionId: "w-1",
        role: "worker",
        managedBy: "wave",
        waveId: "wave-1",
        stepIndex: 0,
        anchorMessageId: "plan-1",
      }),
    );
    graph.attachReport(report("run-w-1", "wave work"));

    publishTerminalGroupDigests(workersFor);
    await Promise.resolve();
    expect(deliverEnvelope).not.toHaveBeenCalled();
  });

  it("shows the digest in a notice when delivery fails outright", async () => {
    deliverEnvelope.mockResolvedValue({
      status: "failed" as const,
      detail: "No session.",
    });
    const graph = useConductorGraphStore.getState();
    graph.registerNode(node({ sessionId: "orch-1", anchorMessageId: "msg-1" }));
    graph.attachReport(report("run-orch-1", "Legacy work done"));

    publishTerminalGroupDigests(workersFor);
    await Promise.resolve();
    await Promise.resolve();

    const text = notices(PARENT).join("\n");
    expect(text).toContain("No session.");
    // The report is flagged published, so the notice is the only copy left.
    expect(text).toContain("Legacy work done");
  });
});
