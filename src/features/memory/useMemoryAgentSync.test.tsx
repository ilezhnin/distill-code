/**
 * Memory's end of the agent protocol, wired the way it runs.
 *
 * The property under test is the one that matters for scope: what an agent
 * remembers lands in the project its session belongs to, and nowhere else —
 * the model names a scope, never a project.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/shared/types/messages";
import type { Persona } from "@/shared/types/agents";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionManagedBy, SessionRole } from "@/features/conductor/types";

import { useMemoryStore } from "./stores/memoryStore";
import { useMemoryAgentSync } from "./useMemoryAgentSync";

function assistant(id: string, body: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [
      {
        type: "text",
        text: ["Noted.", "```distill-memory", body, "```"].join("\n"),
      },
    ],
    metadata: { completionStatus: "completed" },
  };
}

function putMessages(sessionId: string, messages: Message[]) {
  act(() => {
    useChatStore.setState((state) => ({
      messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
    }));
  });
}

function putGraphNode(
  sessionId: string,
  role: SessionRole,
  over: { managedBy?: SessionManagedBy; personaId?: string } = {},
) {
  act(() => {
    useConductorGraphStore.setState((state) => ({
      nodesById: {
        ...state.nodesById,
        [sessionId]: {
          sessionId,
          projectId: "p-1",
          role,
          managedBy: over.managedBy ?? "ui",
          parentSessionId: null,
          rootConductorId: null,
          runId: null,
          harnessId: "goose",
          displayName: "Node",
          status: "running",
          ...(over.personaId ? { personaId: over.personaId } : {}),
        },
      },
    }));
  });
}

function putPersona(id: string, memoryWrite?: boolean) {
  const persona: Persona = {
    id,
    displayName: "Atlas",
    systemPrompt: "Orchestrate.",
    isBuiltin: false,
    writable: true,
    ...(memoryWrite === undefined ? {} : { memoryWrite }),
  };
  act(() => {
    useAgentStore.setState({ personas: [persona] });
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

describe("useMemoryAgentSync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMemoryStore.setState({ entries: [], appliedMessageIds: [] });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ sessions: [] } as never);
    useConductorGraphStore.setState({ nodesById: {} });
    useAgentStore.setState({ personas: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("files a fact under the project the session belongs to", () => {
    putSession("s-1", "p-1");
    renderHook(() => useMemoryAgentSync());

    putMessages("s-1", [
      assistant("m-1", '{"remember":[{"text":"Uses pnpm","scope":"project"}]}'),
    ]);

    expect(useMemoryStore.getState().entries[0]).toMatchObject({
      text: "Uses pnpm",
      scope: "project",
      projectId: "p-1",
      createdBySessionId: "s-1",
    });
  });

  it("keeps a global fact even from a session with no project", () => {
    putSession("s-1", null);
    renderHook(() => useMemoryAgentSync());

    putMessages("s-1", [
      assistant(
        "m-1",
        '{"remember":[{"text":"Ivan pushes","scope":"global"}]}',
      ),
    ]);

    expect(useMemoryStore.getState().entries).toHaveLength(1);
    expect(useMemoryStore.getState().entries[0].scope).toBe("global");
  });

  it("does not re-file on every later store change", () => {
    putSession("s-1", "p-1");
    renderHook(() => useMemoryAgentSync());
    const filed = assistant("m-1", '{"remember":["Once only"]}');
    putMessages("s-1", [filed]);

    putMessages("s-1", [filed, assistant("m-2", '{"remember":[]}')]);
    act(() => {
      useChatStore.setState({ activeSessionId: "s-1" });
    });

    expect(useMemoryStore.getState().entries).toHaveLength(1);
  });

  it("refuses a wave worker's fence, out loud, and does not retry it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-w", "p-1");
    putGraphNode("s-w", "worker", { managedBy: "wave" });
    renderHook(() => useMemoryAgentSync());

    putMessages("s-w", [
      assistant("m-1", '{"remember":["Poisoned global fact"]}'),
    ]);

    expect(useMemoryStore.getState().entries).toHaveLength(0);
    // Visible, in the spirit of the digest's "[protocol block removed]".
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("was not applied"),
    );
    // Tombstoned: a later store change does not re-report the same fence.
    warn.mockClear();
    act(() => {
      useChatStore.setState({ activeSessionId: "s-w" });
    });
    expect(warn).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().appliedMessageIds).toContain("m-1");
  });

  it("refuses a worker-layer node even outside the wave engine", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-w", "p-1");
    putGraphNode("s-w", "worker", { managedBy: "agent-cli" });
    renderHook(() => useMemoryAgentSync());

    putMessages("s-w", [assistant("m-1", '{"remember":["Nope"]}')]);

    expect(useMemoryStore.getState().entries).toHaveLength(0);
  });

  it("lets the conductor write", () => {
    putSession("s-c", "p-1");
    putGraphNode("s-c", "conductor");
    renderHook(() => useMemoryAgentSync());

    putMessages("s-c", [
      assistant(
        "m-1",
        '{"remember":[{"text":"Wave shipped","scope":"project"}]}',
      ),
    ]);

    expect(useMemoryStore.getState().entries[0]).toMatchObject({
      text: "Wave shipped",
      projectId: "p-1",
    });
  });

  it("lets an orchestrator write only when its persona is granted", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-o", "p-1");
    putPersona("persona-1", true);
    putGraphNode("s-o", "orchestrator", { personaId: "persona-1" });
    renderHook(() => useMemoryAgentSync());

    putMessages("s-o", [assistant("m-1", '{"remember":["Granted fact"]}')]);
    expect(useMemoryStore.getState().entries).toHaveLength(1);

    // Same layer, no grant: refused.
    putPersona("persona-1", false);
    putMessages("s-o", [assistant("m-2", '{"remember":["Ungranted fact"]}')]);
    expect(useMemoryStore.getState().entries).toHaveLength(1);
    expect(useMemoryStore.getState().appliedMessageIds).toContain("m-2");
  });

  it("stops listening once it unmounts", () => {
    putSession("s-1", "p-1");
    const { unmount } = renderHook(() => useMemoryAgentSync());
    unmount();

    putMessages("s-1", [assistant("m-1", '{"remember":["After unmount"]}')]);

    expect(useMemoryStore.getState().entries).toHaveLength(0);
  });
});
