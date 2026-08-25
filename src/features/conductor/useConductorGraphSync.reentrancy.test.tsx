/**
 * The graph sync pass writes to the store whose subscription runs the pass.
 *
 * That loop closed for real on 2026-08-25: a worker whose whole reply was its
 * `distill-report` block parsed to an empty summary, the pass read the stored
 * report as "not there yet", re-attached it, the store woke the pass again —
 * and the renderer died with "Maximum call stack size exceeded" the moment any
 * store event touched it (creating a conductor was enough).
 *
 * These cases hold the two properties that keep it closed: a pass converges on
 * a report it has already written, and the pass cannot re-enter itself no
 * matter what it writes.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const WORKER_ID = "worker-1";
const RUN_ID = "run-worker-1";

/** A reply that is nothing but the report block — the shape that crashed. */
const FENCE_ONLY = `\`\`\`distill-report\n{"status":"completed","decisions":[],"artifacts":[],"risks":[],"needsOperator":false,"nextSuggestedTask":null}\n\`\`\``;

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function workerNode(): SessionNode {
  return {
    sessionId: WORKER_ID,
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: RUN_ID,
    harnessId: "goose",
    displayName: "Writer",
    status: "completed",
    createdAt: 1,
  };
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
  };
}

describe("useConductorGraphSync re-entrancy", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("attaches a fence-only worker report once and stops", async () => {
    const { useConductorGraphSync, useConductorGraphStore, useChatStore } =
      await loadModules();

    useChatStore.setState({
      messagesBySession: { [WORKER_ID]: [assistant("m-1", FENCE_ONLY)] },
      sessionStateById: {},
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });

    let reportWrites = 0;
    let previousReports = useConductorGraphStore.getState().reportsByRunId;
    const unsubscribe = useConductorGraphStore.subscribe((state) => {
      if (state.reportsByRunId !== previousReports) {
        previousReports = state.reportsByRunId;
        reportWrites += 1;
      }
    });

    // Before the fix this threw RangeError instead of returning.
    useConductorGraphStore.getState().registerNode(workerNode());
    renderHook(() => useConductorGraphSync());

    // Any later store event re-runs the pass; a converged pass writes nothing.
    act(() => {
      useChatStore.setState({ isConnected: true });
    });
    unsubscribe();

    expect(reportWrites).toBe(1);
    const report = useConductorGraphStore.getState().getReport(RUN_ID);
    expect(report?.status).toBe("completed");
    // The summary is never empty: an empty one reads as "no report yet".
    expect(report?.summary).not.toBe("");
  });

  it("never re-enters the pass, whatever a listener writes", async () => {
    const { useConductorGraphSync, useConductorGraphStore, useChatStore } =
      await loadModules();

    useChatStore.setState({
      messagesBySession: { [WORKER_ID]: [assistant("m-1", FENCE_ONLY)] },
      sessionStateById: {},
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });

    // A listener that writes on every store event is the adversarial shape of
    // the crash: without the guard its write re-enters the pass that woke it.
    let echoes = 0;
    const unsubscribe = useConductorGraphStore.subscribe(() => {
      if (echoes >= 50) return;
      echoes += 1;
      useConductorGraphStore
        .getState()
        .patchNode(WORKER_ID, { task: `echo-${echoes}` });
    });

    useConductorGraphStore.getState().registerNode(workerNode());
    expect(() => {
      renderHook(() => useConductorGraphSync());
      act(() => {
        useChatStore.setState({ isConnected: true });
      });
    }).not.toThrow();
    unsubscribe();

    expect(useConductorGraphStore.getState().getNode(WORKER_ID)).toBeDefined();
  });
});
