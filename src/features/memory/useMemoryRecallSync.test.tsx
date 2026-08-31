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

import type { ArchivedMemoryEntry, MemoryEntry } from "./lib/memoryEntry";
import {
  setMemoryReadEnabled,
  setMemoryWriteEnabled,
} from "./lib/memoryPreferences";
import { RECALL_LIMIT_REACHED_TEXT } from "./lib/memoryRecall";
import { useMemoryStore } from "./stores/memoryStore";
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

function archivedEntry(
  overrides: Partial<ArchivedMemoryEntry> & { id: string },
): ArchivedMemoryEntry {
  return {
    ...entry(overrides),
    archivedAt: Date.UTC(2026, 5, 1),
    archiveReason: "capacity",
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
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      hydrated: true,
    });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ sessions: [] } as never);
    useConductorGraphStore.setState({ nodesById: {} });
    useProjectStore.setState({
      projects: [{ id: "p-1", name: "Berd" }],
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
      "- The release branch is release/2026.9 (project Berd; created 2026-01-02)",
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

  it("marks an archived memory as archived", () => {
    putSession("s-1", null);
    useMemoryStore.setState({
      archived: [archivedEntry({ id: "a", text: "Ivan reviews Rust himself" })],
    });
    renderHook(() => useMemoryRecallSync());

    putMessages("s-1", [assistant("m-1", '{"query":"Rust"}')]);

    expect(delivered()[0].text).toContain(
      "- Ivan reviews Rust himself (global; created 2026-01-02; archived)",
    );
  });

  it("says so when the store holds nothing about the question", () => {
    putSession("s-1", null);
    renderHook(() => useMemoryRecallSync());

    putMessages("s-1", [assistant("m-1", '{"query":"kubernetes"}')]);

    expect(delivered()[0].text).toContain("Nothing found.");
  });

  it("leaves a wave child unanswered, out loud, and does not retry it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-w", "p-1");
    putGraphNode("s-w", "wave");
    useMemoryStore.setState({
      entries: [entry({ id: "g", text: "Secretish" })],
    });
    renderHook(() => useMemoryRecallSync());

    putMessages("s-w", [assistant("m-1", '{"query":"Secretish"}')]);

    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("was not answered"),
    );
    warn.mockClear();
    act(() => {
      useChatStore.setState({ activeSessionId: "s-w" });
    });
    expect(warn).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().recallAnsweredMessageIds).toContain("m-1");
  });

  it("answers a read-only session, which is the one that needs it most", () => {
    // Reading is not the write ACL's business: a worker outside the wave
    // engine may not write memories but still carries the block.
    putSession("s-r", "p-1");
    putGraphNode("s-r", "agent-cli");
    useMemoryStore.setState({
      entries: [entry({ id: "g", text: "Ivan reviews Rust himself" })],
    });
    renderHook(() => useMemoryRecallSync());

    putMessages("s-r", [assistant("m-1", '{"query":"Rust"}')]);

    expect(delivered()).toHaveLength(1);
    expect(delivered()[0].text).toContain("Ivan reviews Rust himself");
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

  it("still answers when only writing is paused", () => {
    setMemoryWriteEnabled(false);
    putSession("s-1", "p-1");
    useMemoryStore.setState({
      entries: [entry({ id: "g", text: "Ivan reviews Rust himself" })],
    });
    renderHook(() => useMemoryRecallSync());

    putMessages("s-1", [assistant("m-1", '{"query":"Rust"}')]);

    expect(delivered()[0].text).toContain("Ivan reviews Rust himself");
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

  it("stops listening once it unmounts", () => {
    putSession("s-1", null);
    const { unmount } = renderHook(() => useMemoryRecallSync());
    unmount();

    putMessages("s-1", [assistant("m-1", '{"query":"fact"}')]);

    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();
  });
});
