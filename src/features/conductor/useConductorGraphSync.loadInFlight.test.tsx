/**
 * A step whose turn ends while its chat is being loaded is read from the
 * transcript that load writes, not from the cache under it.
 *
 * While a load is in flight the store keeps the chat's live updates for the
 * replay, and a load asked for during a turn waits behind that turn's own
 * prompt. On 11-14 an acceptor's chat was loading for the last eleven minutes
 * of its turn: the pass took five lines of narration from the middle of the
 * work for its report, the gate refused that for naming no evidence, and the
 * wave stopped on a step that had reported five checks of six passed.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/shared/types/messages";

import type { SessionNode } from "./types";

const mocks = vi.hoisted(() => ({
  deliverEnvelope: vi.fn(async () => ({ status: "dispatched" as const })),
  loadSessionMessages: vi.fn(async (_sessionId: string) => true),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: vi.fn(async () => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => {}),
}));

vi.mock("./digestDelivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./digestDelivery")>()),
  deliverEnvelope: mocks.deliverEnvelope,
}));

vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/sessionActivation")
  >()),
  loadSessionMessages: mocks.loadSessionMessages,
}));

const STEP = "step-acceptor";

function stepNode(): SessionNode {
  return {
    sessionId: STEP,
    projectId: "invented-project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${STEP}`,
    harnessId: "claude-acp",
    roleId: "acceptor",
    displayName: "Acceptor",
    status: "starting",
    createdAt: 1,
  };
}

function message(id: string, text: string, role: Message["role"]): Message {
  return {
    id,
    role,
    created: Date.now(),
    content: [{ type: "text", text }],
    metadata: { userVisible: true, agentVisible: true },
  } as Message;
}

const NARRATION = "All four also fail in v3. Now counts and trust labels.";

const REPORT = [
  "Five of six checks passed.",
  "",
  "```distill-report",
  JSON.stringify({
    status: "completed",
    summary: "Five of six checks passed; the trust labels are incomplete.",
    decisions: [],
    artifacts: [{ label: "smoke log", path: "out/smoke.log" }],
    risks: [],
    needsOperator: true,
    nextSuggestedTask: null,
  }),
  "```",
].join("\n");

/** The transcript as the host recorded it: the brief, then the whole reply. */
const RECORDED = [
  message("brief", "Verify the rebuilt tree yourself.", "user"),
  message("reply", `${NARRATION}\n${REPORT}`, "assistant"),
];

async function loadModules() {
  vi.resetModules();
  const [
    { useConductorGraphSync },
    { useConductorGraphStore },
    { useChatStore },
    { useChatSessionStore },
    { markTranscriptHydrated },
  ] = await Promise.all([
    import("./useConductorGraphSync"),
    import("./conductorGraphStore"),
    import("@/features/chat/stores/chatStore"),
    import("@/features/chat/stores/chatSessionStore"),
    import("@/features/chat/lib/transcriptHydration"),
  ]);
  useChatStore.setState({ hasHydratedMessageQueues: true });
  useChatSessionStore.setState({ hasHydratedSessions: true });
  renderHook(() => useConductorGraphSync());
  return {
    graph: () => useConductorGraphStore.getState(),
    useChatStore,
    markTranscriptHydrated,
  };
}

/**
 * The step works, a load of its chat starts, and the turn ends under it: the
 * cache still holds what it held when the load was asked for.
 */
function endTurnUnderLoad(
  graph: Awaited<ReturnType<typeof loadModules>>["graph"],
  useChatStore: Awaited<ReturnType<typeof loadModules>>["useChatStore"],
): void {
  act(() => {
    graph().registerNode(stepNode());
    useChatStore.getState().setChatState(STEP, "streaming");
  });
  act(() => {
    useChatStore
      .getState()
      .addMessage(STEP, message("live", NARRATION, "assistant"));
    useChatStore.getState().setSessionLoading(STEP, true);
  });
  act(() => {
    useChatStore.getState().setChatState(STEP, "idle");
  });
}

describe("a step whose turn ends while its chat is being loaded", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.deliverEnvelope.mockClear();
    mocks.loadSessionMessages.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("stays open until the load has written the transcript, and reports from it", async () => {
    const { graph, useChatStore, markTranscriptHydrated } = await loadModules();
    endTurnUnderLoad(graph, useChatStore);

    // Nothing is read from the cache, and the step is not asked for a report
    // it has in fact written.
    expect(graph().getNode(STEP)?.status).toBe("running");
    expect(graph().getReport(`run-${STEP}`)).toBeUndefined();
    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();

    // The loader writes the transcript, then says it is done.
    act(() => {
      useChatStore.getState().setMessages(STEP, RECORDED);
      markTranscriptHydrated(STEP);
    });
    expect(graph().getReport(`run-${STEP}`)).toBeUndefined();
    act(() => {
      useChatStore.getState().setSessionLoading(STEP, false);
    });

    expect(graph().getNode(STEP)?.status).toBe("completed");
    expect(graph().getReport(`run-${STEP}`)).toMatchObject({
      status: "completed",
      summary: "Five of six checks passed; the trust labels are incomplete.",
      artifacts: [{ label: "smoke log", path: "out/smoke.log" }],
      needsOperator: true,
    });
    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();
    expect(mocks.loadSessionMessages).not.toHaveBeenCalled();
  });

  it("asks for the transcript again when that load wrote none", async () => {
    const { graph, useChatStore, markTranscriptHydrated } = await loadModules();
    mocks.loadSessionMessages.mockImplementation(async (sessionId: string) => {
      useChatStore.getState().setMessages(sessionId, RECORDED);
      markTranscriptHydrated(sessionId);
      return true;
    });
    endTurnUnderLoad(graph, useChatStore);

    // The load fails: the cache is as stale as it was.
    await act(async () => {
      useChatStore.getState().setSessionLoading(STEP, false);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.loadSessionMessages).toHaveBeenCalledTimes(1);
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(STEP);
    expect(graph().getNode(STEP)?.status).toBe("completed");
    expect(graph().getReport(`run-${STEP}`)?.artifacts).toEqual([
      { label: "smoke log", path: "out/smoke.log" },
    ]);
    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();
  });

  it("reads the cache as it stands once the transcript cannot be had", async () => {
    const { graph, useChatStore } = await loadModules();
    vi.useFakeTimers();
    try {
      // Every load settles without a transcript.
      mocks.loadSessionMessages.mockResolvedValue(false);
      endTurnUnderLoad(graph, useChatStore);
      await act(async () => {
        useChatStore.getState().setSessionLoading(STEP, false);
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(mocks.loadSessionMessages).toHaveBeenCalledTimes(3);
      // The step is then treated as any other that ended without the block:
      // it is asked for it, once.
      expect(mocks.deliverEnvelope).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
