import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";

const mockLoadSession = vi.fn();
const mockSetProvider = vi.fn();

vi.mock("@/shared/api/acpApi", () => ({
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  setModel: vi.fn(),
  setSessionConfigOption: vi.fn(),
  updateWorkingDir: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  invalidateClientConnectionIfUnresponsive: vi.fn(),
}));

import { ensureReplayBuffer, getReplayBuffer } from "../../hooks/replayBuffer";
import { useChatStore } from "../../stores/chatStore";
import { registerChatSessionHistoryReplayHandler } from "../sessionHistoryReplayAdapter";
import * as registry from "@/shared/api/acpSessionRegistry";

const SESSION = "session-history";

function agentMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text }],
  };
}

function userMessage(id: string, text: string): Message {
  return {
    id,
    role: "user",
    created: Date.now(),
    content: [{ type: "text", text }],
  };
}

describe("session history replay on a preparing load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      loadingSessionIds: new Set(),
    });
    mockSetProvider.mockResolvedValue({ configOptions: [] });
    registerChatSessionHistoryReplayHandler();
  });

  it("treats the history a preparing load replays as the transcript, user messages included", async () => {
    let loadingDuringReplay = false;
    mockLoadSession.mockImplementation(async () => {
      // What the notification handler does with a replayed transcript while
      // the session is marked loading: it fills the replay buffer.
      loadingDuringReplay = useChatStore
        .getState()
        .loadingSessionIds.has(SESSION);
      const buffer = ensureReplayBuffer(SESSION);
      buffer.push(userMessage("u1", "посмотри что полезного"));
      buffer.push(agentMessage("a1", "Сделано, осталось дождаться CI"));
      return { configOptions: [] };
    });

    await registry.prepareSession(SESSION, "claude-acp", "/project");

    expect(loadingDuringReplay).toBe(true);
    expect(useChatStore.getState().loadingSessionIds.has(SESSION)).toBe(false);
    expect(
      useChatStore
        .getState()
        .messagesBySession[SESSION]?.map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(getReplayBuffer(SESSION)).toBeUndefined();
  });

  it("keeps a transcript already on screen when the replay comes back empty", async () => {
    useChatStore.setState({
      messagesBySession: { [SESSION]: [userMessage("u1", "hello")] },
    });
    mockLoadSession.mockResolvedValue({ configOptions: [] });

    await registry.prepareSession(SESSION, "claude-acp", "/project");

    expect(
      useChatStore.getState().messagesBySession[SESSION]?.map((m) => m.id),
    ).toEqual(["u1"]);
    expect(useChatStore.getState().loadingSessionIds.has(SESSION)).toBe(false);
  });

  it("drops its copy of the history when another loader owns the replay", async () => {
    useChatStore.setState({ loadingSessionIds: new Set([SESSION]) });
    mockLoadSession.mockImplementation(async () => {
      ensureReplayBuffer(SESSION).push(agentMessage("a1", "twice?"));
      return { configOptions: [] };
    });

    await registry.prepareSession(SESSION, "claude-acp", "/project");

    // The owner flushes its own buffer later; ours must not be in it, and
    // the owner's loading flag stays up for its replay.
    expect(getReplayBuffer(SESSION)).toBeUndefined();
    expect(useChatStore.getState().loadingSessionIds.has(SESSION)).toBe(true);
    expect(useChatStore.getState().messagesBySession[SESSION]).toBeUndefined();
  });
});
