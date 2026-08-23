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

function reportBlock(summary: string): string {
  return `Done.\n\n\`\`\`distill-report\n{"status":"completed","summary":"${summary}","decisions":[],"artifacts":[],"risks":[],"needsOperator":false,"nextSuggestedTask":null}\n\`\`\``;
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a whole wave and publishes one summary for it", async () => {
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

    // Nothing is published while the wave still has a step running.
    expect(
      useChatStore
        .getState()
        .messagesBySession[CONDUCTOR_ID].filter(
          (message) => message.id !== "plan-1",
        ),
    ).toHaveLength(0);

    await act(async () => {
      useChatStore.setState((state) => ({
        messagesBySession: {
          ...state.messagesBySession,
          "child-1": [assistant("c1", reportBlock("Test plan written"))],
        },
      }));
      useConductorGraphStore
        .getState()
        .patchNode("child-1", { status: "completed" });
    });

    await vi.waitFor(() => {
      const published = useChatStore
        .getState()
        .messagesBySession[CONDUCTOR_ID].filter(
          (message) => message.role === "assistant" && message.id !== "plan-1",
        );
      expect(published).toHaveLength(1);
    });

    const summary = useChatStore
      .getState()
      .messagesBySession[CONDUCTOR_ID].filter(
        (message) => message.role === "assistant" && message.id !== "plan-1",
      )[0];
    const text = summary.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(text).toContain("Three callers in src/");
    expect(text).toContain("Test plan written");

    // The wave is retired once it is over; the tombstone keeps it from rerunning.
    expect(modules.waveStore.getWaveEngineState().waves).toHaveLength(0);
    expect(
      modules.waveStore.hasWaveTombstone(
        modules.waveStore.getWaveEngineState(),
        "plan-1",
      ),
    ).toBe(true);
    expect(spawnCount).toBe(2);
  });

  it("still publishes a legacy orchestrator turn", async () => {
    const {
      useConductorGraphSync,
      useConductorGraphStore,
      useChatStore,
      useChatSessionStore,
    } = await loadModules();

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

    await vi.waitFor(() => {
      const published =
        useChatStore.getState().messagesBySession[CONDUCTOR_ID] ?? [];
      expect(published).toHaveLength(1);
    });
    const text = (useChatStore.getState().messagesBySession[CONDUCTOR_ID] ??
      [])[0].content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(text).toContain("Legacy work done");
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
  });
});
