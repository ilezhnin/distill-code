import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import { isSystemNotification } from "@/shared/types/messages";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";
import { dispatchPrompt } from "./sendCore";

const mocks = vi.hoisted(() => ({
  acpSendMessage: vi.fn(),
  acpPrepareSession: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
}));

// Mocked at the telemetry chokepoint rather than at the feature wrapper, so
// these tests run the real wrapper and the real event factory and would catch a
// param that stopped reaching the wire.
vi.mock("@/shared/telemetry/client", () => ({
  track: (...args: unknown[]) => mocks.track(...args),
}));

function turnEvents() {
  return mocks.track.mock.calls
    .map(
      ([event]) =>
        event as { name: string; parameters: Record<string, unknown> },
    )
    .filter((event) => event.name === "distill_chat_turn_ended");
}

describe("dispatchPrompt pre-commit rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("preserves the complete newer-owner runtime on ownership loss", async () => {
    let newerOwnerRuntime: SessionChatRuntime | undefined;
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        const store = useChatStore.getState();
        store.setError("session-1", "newer owner error");
        store.setChatState("session-1", "streaming");
        store.setPendingAssistantProvider("session-1", "newer-provider");
        store.setActiveRunId("session-1", "newer-run");
        store.setRunCancellationPending("session-1", true);
        newerOwnerRuntime = structuredClone(
          store.getSessionRuntime("session-1"),
        );
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchPrompt("session-1", "stale queued turn", {
        beforeUserMessageCommitted: () => {
          throw new QueuedMessageOwnershipLostError();
        },
      }),
    ).rejects.toBeInstanceOf(QueuedMessageOwnershipLostError);

    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
    expect(useChatStore.getState().getSessionRuntime("session-1")).toEqual(
      newerOwnerRuntime,
    );
  });
});

describe("dispatchPrompt model rejection recovery", () => {
  const PINNED = {
    harnessId: "codex-acp",
    modelProviderId: "codex-acp",
    modelId: "gpt-5.6-sol[max]",
    modelName: "GPT 5.6 Sol (max)",
  };

  function notices(sessionId: string) {
    return (useChatStore.getState().messagesBySession[sessionId] ?? [])
      .flatMap((message) => message.content)
      .filter(isSystemNotification);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
    useAgentStore.setState({
      providers: [{ id: "codex-acp", label: "Codex" }],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Chat",
          executionTarget: PINNED,
          workingDir: "/repo/app",
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
        },
      ],
    });
  });

  function failWith(message: string) {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.reject(new Error(message));
      },
    );
  }

  // The P0 as the operator lived it: the harness refuses the session's model
  // from inside stream(), so the failure repeats on every send and no control
  // in the chat can clear it. The session has to heal itself.
  it("unpins the refused model and tells the operator what changed", async () => {
    failWith("Request failed: Failed to set ACP model option: Invalid params");

    await expect(dispatchPrompt("session-1", "hello", {})).rejects.toThrow(
      "Invalid params",
    );

    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual({ harnessId: "codex-acp", modelProviderId: "codex-acp" });

    const notice = notices("session-1").at(-1);
    expect(notice?.notificationType).toBe("warning");
    expect(notice?.text).toContain("GPT 5.6 Sol (max)");
    expect(notice?.text).toContain("Codex");
    expect(notice?.text).toContain("model pill");
    // The raw error stays: it is what actually happened.
    expect(notices("session-1")[0]?.text).toContain(
      "Failed to set ACP model option",
    );
  });

  // Not a retry (Q2): re-running the prompt on a model the operator did not
  // choose is the silent substitution D5 forbids.
  it("does not re-send the message it just repaired the target for", async () => {
    failWith("Request failed: Failed to set ACP model option: Invalid params");

    await expect(dispatchPrompt("session-1", "hello", {})).rejects.toThrow();

    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves the target alone for any other send failure", async () => {
    failWith("Request failed: Bad request (400): prompt is too long");

    await expect(dispatchPrompt("session-1", "hello", {})).rejects.toThrow();

    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual(PINNED);
    expect(notices("session-1")).toHaveLength(1);
  });
});

// A turn that errors or is cancelled used to leave the same trace as one that
// answered: none. These pin that all three ways out report, and that a
// pre-commit rejection — which hands the session on having changed nothing —
// still does not.
describe("dispatchPrompt turn-outcome telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
    useAgentStore.setState({ providers: [] });
    useChatSessionStore.setState({ sessions: [] });
  });

  it("reports a completed turn with its provider and a duration", async () => {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "hello", { providerId: "codex-acp" });

    const [event] = turnEvents();
    expect(event?.parameters.outcome).toBe("TURN_OUTCOME_COMPLETED");
    expect(event?.parameters.message_committed).toBe(true);
    expect(event?.parameters.provider).toBe("codex-acp");
    expect(typeof event?.parameters.duration_ms).toBe("number");
    expect("error_kind" in (event?.parameters ?? {})).toBe(false);
  });

  it("reports a cancelled turn rather than a failed one", async () => {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.reject(
          new DOMException("The operation was aborted.", "AbortError"),
        );
      },
    );

    await expect(dispatchPrompt("session-1", "hello", {})).rejects.toThrow();

    const [event] = turnEvents();
    expect(event?.parameters.outcome).toBe("TURN_OUTCOME_CANCELLED");
    expect("error_kind" in (event?.parameters ?? {})).toBe(false);
  });

  it("reports a failed turn by kind, never by message", async () => {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.reject(
          new Error("Failed to get provider: Provider not set"),
        );
      },
    );

    await expect(dispatchPrompt("session-1", "hello", {})).rejects.toThrow();

    const [event] = turnEvents();
    expect(event?.parameters.outcome).toBe("TURN_OUTCOME_ERROR");
    expect(event?.parameters.error_kind).toBe(
      "TURN_ERROR_KIND_PROVIDER_NOT_SET",
    );
    expect(JSON.stringify(event?.parameters)).not.toContain("Provider not set");
  });

  it("reports nothing for a pre-commit rejection", async () => {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchPrompt("session-1", "stale queued turn", {
        beforeUserMessageCommitted: () => {
          throw new QueuedMessageOwnershipLostError();
        },
      }),
    ).rejects.toBeInstanceOf(QueuedMessageOwnershipLostError);

    expect(turnEvents()).toEqual([]);
  });

  // The reporter sits in a `finally`; a throw there would replace the error on
  // its way out and rename a harness failure after the telemetry stack.
  it("lets the original error out when reporting throws", async () => {
    mocks.track.mockImplementationOnce(() => {
      throw new Error("telemetry exploded");
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.reject(new Error("harness said no"));
      },
    );

    await expect(dispatchPrompt("session-1", "hello", {})).rejects.toThrow(
      "harness said no",
    );
  });
});
