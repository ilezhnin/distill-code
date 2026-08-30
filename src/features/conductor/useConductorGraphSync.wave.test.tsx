import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";

import type { SessionNode } from "./types";

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: vi.fn(async () => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => {}),
}));

const spawnConductorChildSession = vi.hoisted(() => vi.fn());
vi.mock("./spawnOrchestrator", () => ({ spawnConductorChildSession }));

/**
 * The envelope is the whole point of 3a, so it is the seam the tests hold: a
 * digest is a *real user message* through the berdctl cross-session path, not
 * a synthetic assistant bubble. The mock commits exactly what that path
 * commits — a user message carrying `origin: "berdctl_cross_session"`.
 */
const deliverEnvelope = vi.hoisted(() => vi.fn());
vi.mock("./digestDelivery", () => ({
  deliverEnvelope,
  classifyDigestDispatchError: () => ({ status: "failed" as const }),
}));

const CONDUCTOR_ID = "conductor-1";

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

const PLAN = `Working on it.\n\n\`\`\`distill-wave\n{"steps":[{"role":"scout","subtask":"Find every caller","access":[]},{"role":"qa","subtask":"Write the test plan","access":"all"}]}\n\`\`\``;

function reportBlock(summary: string, artifactPath?: string): string {
  // P62: a completed verify-stage report must name evidence artifacts, or
  // the gate quarantines it — so the qa step's fixture carries one.
  const artifacts = artifactPath
    ? `[{"label":"evidence","path":"${artifactPath}"}]`
    : "[]";
  return `Done.\n\n\`\`\`distill-report\n{"status":"completed","summary":"${summary}","decisions":[],"artifacts":${artifacts},"risks":[],"needsOperator":false,"nextSuggestedTask":null}\n\`\`\``;
}

/** Module-level guards live in the modules, so each case reloads them. */
async function loadModules() {
  vi.resetModules();
  const [
    { useConductorGraphSync },
    { useConductorGraphStore },
    { useChatStore },
    { useChatSessionStore },
    waveStore,
  ] = await Promise.all([
    import("./useConductorGraphSync"),
    import("./conductorGraphStore"),
    import("@/features/chat/stores/chatStore"),
    import("@/features/chat/stores/chatSessionStore"),
    import("./waveStore"),
  ]);
  waveStore.resetWaveEngineStateCache();
  return {
    useConductorGraphSync,
    useConductorGraphStore,
    useChatStore,
    useChatSessionStore,
    waveStore,
  };
}

function conductorNode(): SessionNode {
  return {
    sessionId: CONDUCTOR_ID,
    projectId: "project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: CONDUCTOR_ID,
    runId: null,
    harnessId: "goose",
    displayName: "Producer",
    status: "stopped",
  };
}

describe("useConductorGraphSync wave bridge", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    window.localStorage.clear();
    spawnConductorChildSession.mockReset();
    deliverEnvelope.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a whole wave and delivers one digest envelope for it", async () => {
    const modules = await loadModules();
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = modules;

    let spawnCount = 0;
    spawnConductorChildSession.mockImplementation(async (args) => {
      spawnCount += 1;
      const sessionId = `child-${args.stepIndex}`;
      const runId = `run-${args.stepIndex}`;
      useConductorGraphStore.getState().registerNode({
        sessionId,
        projectId: "project",
        role: "worker",
        managedBy: "wave",
        parentSessionId: CONDUCTOR_ID,
        rootConductorId: CONDUCTOR_ID,
        runId,
        harnessId: "goose",
        displayName: sessionId,
        status: "running",
        waveId: args.waveId,
        stepIndex: args.stepIndex,
        anchorMessageId: args.anchorMessageId,
      });
      return { sessionId, runId };
    });
    deliverEnvelope.mockImplementation(
      async (sessionId: string, text: string) => {
        useChatStore.getState().addMessage(sessionId, {
          id: `digest-${crypto.randomUUID()}`,
          role: "user",
          created: Date.now(),
          content: [{ type: "text", text }],
          metadata: { origin: "berdctl_cross_session" },
        });
        return { status: "dispatched" as const };
      },
    );

    useChatSessionStore.setState({ hasHydratedSessions: true });
    useChatStore.setState({
      hasHydratedMessageQueues: true,
      messagesBySession: { [CONDUCTOR_ID]: [assistant("plan-1", PLAN)] },
      sessionStateById: {},
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode(conductorNode());

    renderHook(() => useConductorGraphSync());

    await vi.waitFor(() => expect(spawnCount).toBe(1));

    // Step 0 finishes with a real report; that unblocks the access:"all" step.
    await act(async () => {
      useChatStore.setState((state) => ({
        messagesBySession: {
          ...state.messagesBySession,
          "child-0": [assistant("c0", reportBlock("Three callers in src/"))],
        },
      }));
      useConductorGraphStore
        .getState()
        .patchNode("child-0", { status: "completed" });
    });

    await vi.waitFor(() => expect(spawnCount).toBe(2));
    const secondPrompt = spawnConductorChildSession.mock.calls[1][0].prompt;
    expect(secondPrompt).toContain("Three callers in src/");

    // Nothing is delivered while the wave still has a step running.
    expect(deliverEnvelope).not.toHaveBeenCalled();

    await act(async () => {
      useChatStore.setState((state) => ({
        messagesBySession: {
          ...state.messagesBySession,
          "child-1": [
            assistant(
              "c1",
              reportBlock("Test plan written", "docs/test-plan.md"),
            ),
          ],
        },
      }));
      useConductorGraphStore
        .getState()
        .patchNode("child-1", { status: "completed" });
    });

    await vi.waitFor(() => expect(deliverEnvelope).toHaveBeenCalledTimes(1));
    const [target, digest] = deliverEnvelope.mock.calls[0];
    expect(target).toBe(CONDUCTOR_ID);
    // One digest per wave, covering both steps — never one per worker.
    expect(digest).toContain("Three callers in src/");
    expect(digest).toContain("Test plan written");
    expect(digest).toContain("[distill-digest:");

    // No synthetic assistant summary is appended any more: the only thing that
    // reaches the conductor is the digest the envelope committed.
    const assistantMessages = useChatStore
      .getState()
      .messagesBySession[CONDUCTOR_ID].filter(
        (message) => message.role === "assistant" && message.id !== "plan-1",
      );
    expect(assistantMessages).toHaveLength(0);

    // The wave is not retired at the digest: it is waiting for a verdict.
    await vi.waitFor(() => {
      const [wave] = modules.waveStore.getWaveEngineState().waves;
      expect(wave?.phase).toBe("awaitingVerdict");
    });
    expect(spawnCount).toBe(2);
  });

  it("still publishes a legacy orchestrator turn, through the envelope", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = await loadModules();
    deliverEnvelope.mockResolvedValue({ status: "dispatched" as const });

    useChatSessionStore.setState({ hasHydratedSessions: true });
    useChatStore.setState({
      hasHydratedMessageQueues: true,
      messagesBySession: {
        "orch-1": [assistant("o1", reportBlock("Legacy work done"))],
      },
      sessionStateById: {},
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    const graph = useConductorGraphStore.getState();
    graph.registerNode(conductorNode());
    graph.registerNode({
      sessionId: "orch-1",
      projectId: "project",
      role: "orchestrator",
      managedBy: "ui",
      parentSessionId: CONDUCTOR_ID,
      rootConductorId: CONDUCTOR_ID,
      runId: "run-orch",
      harnessId: "goose",
      displayName: "Atlas",
      status: "completed",
      anchorMessageId: "msg-1",
    });

    renderHook(() => useConductorGraphSync());

    await vi.waitFor(() => expect(deliverEnvelope).toHaveBeenCalledTimes(1));
    const [target, digest] = deliverEnvelope.mock.calls[0];
    expect(target).toBe(CONDUCTOR_ID);
    expect(digest).toContain("Legacy work done");
    expect(digest).toContain("[distill-digest:");
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    // The report is flagged exactly once, so a second sync pass sends nothing.
    expect(
      useConductorGraphStore.getState().getReport("run-orch")
        ?.publishedToParent,
    ).toBe(true);
  });
});
