import { describe, expect, it } from "vitest";
import type { ChatSession } from "../../stores/chatSessionStore";
import { findExistingDraft } from "../newChat";
import { DEFAULT_CHAT_TITLE } from "../sessionTitle";

const opus5 = {
  harnessId: "claude-acp",
  modelProviderId: "claude-acp",
  modelId: "claude-opus-5",
  modelName: "Opus 5",
} as const;

function draft(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "draft-1",
    title: DEFAULT_CHAT_TITLE,
    executionTarget: opus5,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

function find(
  session: ChatSession,
  runSettings?: ChatSession["desiredRunSettings"],
) {
  return findExistingDraft({
    sessions: [session],
    activeSessionId: session.id,
    draftsBySession: {},
    messagesBySession: {},
    request: {
      title: DEFAULT_CHAT_TITLE,
      executionTarget: opus5,
      ...(runSettings ? { runSettings } : {}),
    },
  });
}

describe("findExistingDraft", () => {
  it("compares what was asked for, not the effort the model reports running at", () => {
    const session = draft({
      reasoningEffort: {
        configId: "effort",
        currentValue: "max",
        options: [
          { id: "high", name: "High" },
          { id: "max", name: "Max" },
        ],
      },
    });

    expect(find(session, { effort: "max" })).toBeUndefined();
    expect(find(session)).toBe(session);
  });
});
