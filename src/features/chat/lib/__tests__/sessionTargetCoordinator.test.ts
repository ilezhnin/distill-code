import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  observeSessionTargetModelSnapshot,
  resetSessionTargetCoordinatorsForTests,
} from "../sessionTargetCoordinator";

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
  acpPrepareSession: vi.fn(),
}));

function seedSession(modelId: string, harnessId = "codex-acp"): ChatSession {
  const session: ChatSession = {
    id: "session-1",
    title: "Chat",
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z",
    messageCount: 0,
    executionTarget: {
      harnessId,
      modelProviderId: harnessId,
      modelId,
      modelName: modelId,
    },
    executionTargetSource: "ui",
  };
  useChatSessionStore.setState({ sessions: [session] });
  return session;
}

function observe(
  snapshotModelId: string,
  contextModelId: string,
  harnessId = "codex-acp",
): boolean {
  return observeSessionTargetModelSnapshot({
    sessionId: "session-1",
    snapshot: { modelId: snapshotModelId, modelName: snapshotModelId },
    context: {
      origin: "response",
      providerId: harnessId,
      modelId: contextModelId,
    },
  });
}

describe("observeSessionTargetModelSnapshot", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({ sessions: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("accepts a snapshot that still folds the effort into the model id", () => {
    seedSession("gpt-5.6-sol");

    expect(observe("gpt-5.6-sol[ultra]", "gpt-5.6-sol[ultra]")).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("accepts a base-id snapshot for a target that still carries the effort", () => {
    seedSession("gpt-5.6-sol[ultra]");

    expect(observe("gpt-5.6-sol", "gpt-5.6-sol")).toBe(true);
  });

  it("drops a snapshot that names a different model", () => {
    seedSession("gpt-5.6-sol");

    expect(observe("gpt-6-astra[ultra]", "gpt-6-astra[ultra]")).toBe(false);
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({ executionTarget: { modelId: "gpt-5.6-sol" } });
  });

  it("drops a snapshot whose context names a model the response does not", () => {
    seedSession("gpt-5.6-sol");

    expect(observe("gpt-5.6-sol[ultra]", "gpt-6-astra[ultra]")).toBe(false);
  });

  it("keeps a context lane apart from the model without it", () => {
    seedSession("opus[1m]", "claude-acp");

    expect(observe("opus", "opus", "claude-acp")).toBe(false);
  });
});
