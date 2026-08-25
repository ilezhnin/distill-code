/**
 * Memory's end of the agent protocol, wired the way it runs.
 *
 * The property under test is the one that matters for scope: what an agent
 * remembers lands in the project its session belongs to, and nowhere else —
 * the model names a scope, never a project.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";

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

  it("stops listening once it unmounts", () => {
    putSession("s-1", "p-1");
    const { unmount } = renderHook(() => useMemoryAgentSync());
    unmount();

    putMessages("s-1", [assistant("m-1", '{"remember":["After unmount"]}')]);

    expect(useMemoryStore.getState().entries).toHaveLength(0);
  });
});
