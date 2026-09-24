/**
 * The read half of the agent protocol, wired the way it runs.
 *
 * Two properties carry the law here: what comes back is only what this
 * session may see (LAWS/MEMORY.md, Reading back), and one question costs one
 * answer — the drain re-reads the tail on every store change, and the answer
 * it delivers is itself a store change.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/shared/types/messages";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionManagedBy } from "@/features/conductor/types";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import type { MemoryEntry } from "./lib/memoryEntry";
import { setMemoryReadEnabled } from "./lib/memoryPreferences";
import { RECALL_LIMIT_REACHED_TEXT } from "./lib/memoryRecall";
import {
  resetWaveExecutorWatchForTests,
  useMemoryStore,
} from "./stores/memoryStore";
import { useMemoryRecallSync } from "./useMemoryRecallSync";

const mocks = vi.hoisted(() => ({
  deliverEnvelope: vi.fn(),
}));

vi.mock("@/features/conductor/digestDelivery", () => ({
  deliverEnvelope: (...args: unknown[]) => mocks.deliverEnvelope(...args),
}));

function assistant(id: string, body: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [
      {
        type: "text",
        text: ["Checking.", "```distill-recall", body, "```"].join("\n"),
      },
    ],
    metadata: { completionStatus: "completed" },
  };
}

function plain(id: string, role: "user" | "assistant", text: string): Message {
  return {
    id,
    role,
    created: 1,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function entry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "A fact",
    scope: "global",
    projectId: null,
    createdAt: Date.UTC(2026, 0, 2),
    ...overrides,
  };
}

function putMessages(sessionId: string, messages: Message[]) {
  act(() => {
    useChatStore.setState((state) => ({
      messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
    }));
  });
}

function putSession(sessionId: string, projectId: string | null) {
  act(() => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: "A chat",
          createdAt: 1,
          updatedAt: 1,
          ...(projectId ? { projectId } : {}),
        },
      ],
    } as never);
  });
}

function putGraphNode(sessionId: string, managedBy: SessionManagedBy) {
  act(() => {
    useConductorGraphStore.setState((state) => ({
      nodesById: {
        ...state.nodesById,
        [sessionId]: {
          sessionId,
          projectId: "p-1",
          role: "worker",
          managedBy,
          parentSessionId: null,
          rootConductorId: null,
          runId: null,
          harnessId: "goose",
          displayName: "Node",
          status: "running",
        },
      },
    }));
  });
}

function delivered(): { sessionId: string; text: string }[] {
  return mocks.deliverEnvelope.mock.calls.map(([sessionId, text]) => ({
    sessionId: sessionId as string,
    text: text as string,
  }));
}

describe("useMemoryRecallSync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mocks.deliverEnvelope.mockResolvedValue({ status: "dispatched" });
    resetWaveExecutorWatchForTests();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      waveExecutorSessionIds: [],
      hydrated: true,
    });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ sessions: [] } as never);
    useConductorGraphStore.setState({ nodesById: {} });
    useProjectStore.setState({
      projects: [{ id: "p-1", name: "Distill" }],
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a settled question exactly once", () => {
    putSession("s-1", "p-1");
    useMemoryStore.setState({
      entries: [
        entry({
          id: "p",
          text: "The release branch is release/2026.9",
          scope: "project",
          projectId: "p-1",
        }),
      ],
    });
    renderHook(() => useMemoryRecallSync());

    const asked = assistant("m-1", '{"query":"release branch"}');
    putMessages("s-1", [asked]);

    expect(delivered()).toHaveLength(1);
    expect(delivered()[0].sessionId).toBe("s-1");
    expect(delivered()[0].text).toContain(
      "- The release branch is release/2026.9 (project Distill; created 2026-01-02)",
    );
    expect(delivered()[0].text).toContain(
      "Do not repeat this recall for the same question.",
    );

    // Tombstoned: later store changes do not ask the same question again.
    putMessages("s-1", [asked, plain("m-2", "assistant", "Anything else?")]);
    act(() => {
      useChatStore.setState({ activeSessionId: "s-1" });
    });
    expect(delivered()).toHaveLength(1);
    expect(useMemoryStore.getState().recallAnsweredMessageIds).toEqual(["m-1"]);
  });

  it("never hands over another project's memories", () => {
    // LAWS/MEMORY.md, Reading back: crossing projects is the operator's search.
    putSession("s-1", "p-1");
    useMemoryStore.setState({
      entries: [
        entry({
          id: "mine",
          text: "Deploys from release branch",
          scope: "project",
          projectId: "p-1",
        }),
        entry({
          id: "theirs",
          text: "Other release branch is main",
          scope: "project",
          projectId: "p-2",
        }),
      ],
    });
    renderHook(() => useMemoryRecallSync());

    putMessages("s-1", [assistant("m-1", '{"query":"release branch"}')]);

    const text = delivered()[0].text;
    expect(text).toContain("Deploys from release branch");
    expect(text).not.toContain("Other release branch is main");
  });

  it("leaves a wave child unanswered after the graph has evicted its node", () => {
    // The graph is bounded and drops a finished wave child's node first; the
    // answer would hand the operator's list to an executor that was never
    // taught to ask for it (LAWS/MEMORY.md, Writing).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-w", "p-1");
    putGraphNode("s-w", "wave");
    useMemoryStore.setState({
      entries: [entry({ id: "g", text: "Secretish" })],
    });
    renderHook(() => useMemoryRecallSync());
    act(() => {
      useConductorGraphStore.setState({ nodesById: {} });
    });

    putMessages("s-w", [assistant("m-1", '{"query":"Secretish"}')]);

    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("was not answered"),
    );
    expect(useMemoryStore.getState().recallAnsweredMessageIds).toContain("m-1");
  });

  it("answers nothing once the operator switches memory out of prompts", () => {
    // An answer is memory reaching a session's context, which is the exact
    // thing that switch turns off — so recall follows `read`, not `write`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setMemoryReadEnabled(false);
    putSession("s-1", "p-1");
    useMemoryStore.setState({
      entries: [entry({ id: "g", text: "Ivan reviews Rust himself" })],
    });
    renderHook(() => useMemoryRecallSync());

    putMessages("s-1", [assistant("m-1", '{"query":"Rust"}')]);

    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("was not answered"),
    );
    // Refused, not deferred: an answer that turned up later would land in a
    // conversation that has moved on.
    expect(useMemoryStore.getState().recallAnsweredMessageIds).toContain("m-1");
  });

  it("stops searching once the session has asked three times over", () => {
    putSession("s-1", null);
    useMemoryStore.setState({ entries: [entry({ id: "g", text: "A fact" })] });
    renderHook(() => useMemoryRecallSync());

    const answer =
      '<memory-recall query="fact">\nNothing found.\n</memory-recall>';
    putMessages("s-1", [
      plain("a-1", "user", answer),
      plain("a-2", "user", answer),
      plain("a-3", "user", answer),
      assistant("m-1", '{"query":"fact"}'),
    ]);

    expect(delivered()[0].text).toBe(RECALL_LIMIT_REACHED_TEXT);
  });

  it("waits for the turn to settle before answering", () => {
    putSession("s-1", null);
    renderHook(() => useMemoryRecallSync());

    const streaming: Message = {
      ...assistant("m-1", '{"query":"fact"}'),
      metadata: { completionStatus: "inProgress" },
    };
    putMessages("s-1", [streaming]);
    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();

    putMessages("s-1", [assistant("m-1", '{"query":"fact"}')]);
    expect(delivered()).toHaveLength(1);
  });
});
