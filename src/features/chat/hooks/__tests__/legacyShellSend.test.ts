import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";

vi.mock("../../lib/chatExecutorDispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chatExecutorDispatch")>()),
  prepareChatExecutorDispatch: vi.fn(async () => undefined),
}));

vi.mock("@/shared/api/acp", () => ({
  acpPrepareSessionAccount: vi.fn(async () => undefined),
  acpSendMessage: vi.fn(
    async (
      _sessionId: string,
      _prompt: string,
      options?: {
        onPromptDispatching?: () => void;
        onPromptDispatched?: () => void;
      },
    ) => {
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
    },
  ),
  acpSteerMessage: vi.fn(),
  acpCancelSession: vi.fn(),
  acpLoadSession: vi.fn(),
  acpPrepareSession: vi.fn(),
}));

import { useChat } from "../useChat";
import { useMessageQueue } from "../useMessageQueue";

const SETTLED_WITHIN_MS = 1_000;

function settleState(promise: Promise<boolean>) {
  return Promise.race([
    promise.then((accepted) => `resolved:${accepted}`),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("still pending"), SETTLED_WITHIN_MS),
    ),
  ]);
}

function seed(sessionId: string, legacyShell: boolean) {
  useChatSessionStore.setState({
    sessions: [
      {
        id: sessionId,
        title: "Chat",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 0,
        executionTarget: { harnessId: "goose" },
      },
    ],
    hasHydratedSessions: true,
  });
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
    draftsBySession: {},
  });
  const state = useConductorGraphStore.getState();
  useConductorGraphStore.setState({
    nodesById: legacyShell
      ? {
          ...state.nodesById,
          [sessionId]: {
            ...(Object.values(state.nodesById)[0] ?? {}),
            sessionId,
            role: "orchestrator",
          } as never,
        }
      : {},
  });
}

// B-4 (bug hunt 2026-11-25): the queue's finalize, which lets the record go
// and releases its dispatch leases, runs only when the send settles.
describe("send into a legacy orchestrator shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("control: an ordinary chat's send settles as accepted", async () => {
    seed("plain-chat", false);
    const { result } = renderHook(() => useChat("plain-chat"));
    const outcome = await settleState(result.current.sendMessage("hello"));
    expect(outcome).toBe("resolved:true");
  });

  it("a legacy orchestrator shell's send settles once its user turn is committed", async () => {
    seed("legacy-shell", true);
    const { result } = renderHook(() => useChat("legacy-shell"));
    const outcome = await settleState(result.current.sendMessage("hello"));
    const transcript = (
      useChatStore.getState().messagesBySession["legacy-shell"] ?? []
    ).map((message) => message.role);
    expect(
      { outcome, transcript },
      "the user turn is committed, so the send must resolve as accepted",
    ).toEqual({ outcome: "resolved:true", transcript: ["user"] });
  });

  it("a legacy orchestrator shell's queue lets each sent message go and sends the next one", async () => {
    seed("legacy-shell", true);
    for (const text of ["first", "second"])
      useChatStore.getState().enqueueTransportReadyMessage("legacy-shell", {
        persona: { kind: "inherit" },
        text,
      });
    renderHook(() => {
      const { sendMessage, chatState } = useChat("legacy-shell");
      return useMessageQueue("legacy-shell", chatState, sendMessage);
    });
    await waitFor(
      () =>
        expect({
          transcript: (
            useChatStore.getState().messagesBySession["legacy-shell"] ?? []
          ).map((message) => message.content[0]),
          queued:
            useChatStore.getState().queuedMessageBySession["legacy-shell"]
              ?.length ?? 0,
        }).toEqual({
          transcript: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
          queued: 0,
        }),
      { timeout: SETTLED_WITHIN_MS },
    );
  });
});
