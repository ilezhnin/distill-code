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
import {
  setConductorGraphHydratedForTests,
  useConductorGraphStore,
} from "@/features/conductor/conductorGraphStore";
import type { SessionManagedBy, SessionRole } from "@/features/conductor/types";

import { MEMORY_SCAN_TAIL } from "./lib/memoryAgentScan";
import { setMemoryWriteEnabled } from "./lib/memoryPreferences";
import {
  resetWaveExecutorWatchForTests,
  useMemoryStore,
} from "./stores/memoryStore";
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

/** Settled assistant chatter with no fence in it — used to bury one. */
function filler(id: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text: "Working on it." }],
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
    resetWaveExecutorWatchForTests();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      waveExecutorSessionIds: [],
      hydrated: true,
    });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ sessions: [] } as never);
    useConductorGraphStore.setState({ nodesById: {} });
    useAgentStore.setState({ personas: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("refuses a wave child's fence after the graph has evicted its node", () => {
    // The P16 flow: the graph passes its 500-node bound, an old worker's
    // terminal node is the first thing evicted, and the ACL's other default —
    // "no node is an ordinary chat" — would then read that worker's
    // transcript as the operator's own. LAWS/MEMORY.md, Writing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-w", "p-1");
    putGraphNode("s-w", "worker", { managedBy: "wave" });
    renderHook(() => useMemoryAgentSync());
    act(() => {
      useConductorGraphStore.setState({ nodesById: {} });
    });

    // The operator opens the old chat; the transcript replays and the deep
    // first scan finds the fence the worker left in it.
    putMessages("s-w", [
      assistant("m-1", '{"remember":["Poisoned global fact"]}'),
    ]);

    expect(useMemoryStore.getState().entries).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("was not applied"),
    );
    expect(useMemoryStore.getState().appliedMessageIds).toContain("m-1");
  });

  it("waits for the graph before judging who wrote a fence", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-w", "p-1");
    act(() => {
      setConductorGraphHydratedForTests(false);
    });
    try {
      renderHook(() => useMemoryAgentSync());
      // The worker's node is still on disk: with no node, the ACL would
      // read this session as the operator's own chat.
      putMessages("s-w", [assistant("m-1", '{"remember":["Too early"]}')]);
      expect(useMemoryStore.getState().entries).toHaveLength(0);
      expect(useMemoryStore.getState().appliedMessageIds).not.toContain("m-1");

      putGraphNode("s-w", "worker", { managedBy: "wave" });
      act(() => {
        setConductorGraphHydratedForTests(true);
      });

      expect(useMemoryStore.getState().entries).toHaveLength(0);
      expect(useMemoryStore.getState().appliedMessageIds).toContain("m-1");
    } finally {
      setConductorGraphHydratedForTests(null);
    }
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

  it("refuses a statement that carries a secret, by kind only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-1", "p-1");
    renderHook(() => useMemoryAgentSync());

    // A synthetic prefix plus placeholder characters — nothing here is a key.
    const looksLikeAKey = `AKIA${"Q".repeat(16)}`;
    putMessages("s-1", [
      assistant(
        "m-1",
        JSON.stringify({
          remember: [
            { text: `The deploy key is ${looksLikeAKey}`, scope: "global" },
            { text: "Deploys run from CI", scope: "global" },
          ],
        }),
      ),
    ]);

    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].text).toBe("Deploys run from CI");
    expect(warn).toHaveBeenCalledWith(
      "[memory] statement refused: looks like a secret (aws-key)",
    );
    // The warning names the shape and nothing else; the statement itself must
    // not end up in a log either.
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(looksLikeAKey);
    }

    // Tombstoned like any other read fence: a later store change is silent.
    warn.mockClear();
    act(() => {
      useChatStore.setState({ activeSessionId: "s-1" });
    });
    expect(warn).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().appliedMessageIds).toContain("m-1");
  });

  it("keeps the fact when a correction's replacement cannot be kept", () => {
    // The checklist's C.4 correction, sent from a chat with no project. The
    // replacement is refused, so the retirement does not run either: losing
    // both halves would lose the fact, and quietly.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    putSession("s-1", null);
    useMemoryStore.setState({
      entries: [
        {
          id: "old",
          text: "The branch is release/2026.9",
          scope: "global",
          projectId: null,
          createdAt: 1,
        },
      ],
    });
    renderHook(() => useMemoryAgentSync());

    putMessages("s-1", [
      assistant(
        "m-1",
        JSON.stringify({
          forget: ["The branch is release/2026.9"],
          remember: [
            { text: "The branch is release/2026.10", scope: "project" },
          ],
        }),
      ),
    ]);

    const state = useMemoryStore.getState();
    expect(state.entries.map((e) => e.id)).toEqual(["old"]);
    expect(state.archived).toEqual([]);
  });

  describe("while the operator has writing switched off", () => {
    it("keeps the fence, and applies it once writing comes back", () => {
      setMemoryWriteEnabled(false);
      putSession("s-1", "p-1");
      renderHook(() => useMemoryAgentSync());
      putMessages("s-1", [
        assistant(
          "m-1",
          '{"remember":[{"text":"Uses pnpm","scope":"project"}]}',
        ),
      ]);
      expect(useMemoryStore.getState().entries).toHaveLength(0);

      act(() => {
        setMemoryWriteEnabled(true);
      });

      expect(useMemoryStore.getState().entries[0]).toMatchObject({
        text: "Uses pnpm",
        projectId: "p-1",
      });
    });

    it("still reaches a fence the pause left far behind", () => {
      // The reason turning the switch back on re-arms the deep pass: while
      // it was off nothing was scanned, so the request never counted as
      // seen — but by now it is well past the tail this drain normally
      // reads, and a tail scan would leave it there forever.
      setMemoryWriteEnabled(false);
      putSession("s-1", "p-1");
      renderHook(() => useMemoryAgentSync());
      putMessages("s-1", [
        assistant("m-1", '{"remember":["Written during the pause"]}'),
        ...Array.from({ length: MEMORY_SCAN_TAIL + 5 }, (_, index) =>
          filler(`f-${index}`),
        ),
      ]);

      act(() => {
        setMemoryWriteEnabled(true);
      });

      expect(useMemoryStore.getState().entries.map((e) => e.text)).toEqual([
        "Written during the pause",
      ]);
    });
  });
});
