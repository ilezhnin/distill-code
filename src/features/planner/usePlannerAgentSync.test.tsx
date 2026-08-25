/**
 * The planner's end of the agent protocol, wired the way it runs.
 *
 * The interesting property is not "a fence parses" — that is `plannerFence`'s
 * own suite — but that the drain is safe to run on a store that wakes it: the
 * chat store fires on every streamed token, and the drain writes to a store of
 * its own. It must file each message once and then go quiet.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Message } from "@/shared/types/messages";

import { useChatStore } from "@/features/chat/stores/chatStore";

import { usePlannerStore } from "./stores/plannerStore";
import { usePlannerAgentSync } from "./usePlannerAgentSync";

function assistant(id: string, body: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [
      {
        type: "text",
        text: ["Done.", "```distill-todo", body, "```"].join("\n"),
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

describe("usePlannerAgentSync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePlannerStore.setState({ tasks: [], appliedMessageIds: [] });
    useChatStore.setState({ messagesBySession: {} });
  });

  it("files a task an agent wrote into a live chat", () => {
    renderHook(() => usePlannerAgentSync());

    putMessages("s-1", [
      assistant("m-1", '{"add":[{"title":"Renew the certificate"}]}'),
    ]);

    const tasks = usePlannerStore.getState().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Renew the certificate",
      createdBySessionId: "s-1",
    });
  });

  it("files what is already on screen when it mounts", () => {
    putMessages("s-1", [assistant("m-1", '{"add":["Already there"]}')]);

    renderHook(() => usePlannerAgentSync());

    expect(usePlannerStore.getState().tasks).toHaveLength(1);
  });

  it("does not re-file a message on every later store change", () => {
    renderHook(() => usePlannerAgentSync());
    const filed = assistant("m-1", '{"add":["Once only"]}');
    putMessages("s-1", [filed]);

    // Whatever else happens in the chat, the message keeps being in the
    // transcript — and the transcript is what the drain reads.
    putMessages("s-1", [filed, assistant("m-2", '{"add":[]}')]);
    act(() => {
      useChatStore.setState({ activeSessionId: "s-1" });
    });

    expect(usePlannerStore.getState().tasks).toHaveLength(1);
  });

  it("stops listening once it unmounts", () => {
    const { unmount } = renderHook(() => usePlannerAgentSync());
    unmount();

    putMessages("s-1", [assistant("m-1", '{"add":["After unmount"]}')]);

    expect(usePlannerStore.getState().tasks).toHaveLength(0);
  });

  it("ticks a task off from the chat that finished it", () => {
    act(() => {
      usePlannerStore.getState().addTask({ title: "Draft the notes" });
    });
    renderHook(() => usePlannerAgentSync());

    putMessages("s-1", [assistant("m-1", '{"complete":["Draft the notes"]}')]);

    expect(usePlannerStore.getState().tasks[0].completedAt).not.toBeNull();
  });
});
