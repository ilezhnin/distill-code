import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";

import { handleUndeclaredSessionModel } from "../undeclaredSessionModelAdapter";

const PINNED = {
  harnessId: "codex-acp",
  modelProviderId: "codex-acp",
  modelId: "gpt-5.6-sol[ultra]",
  modelName: "GPT 5.6 Sol (ultra)",
};

function notificationTexts(sessionId: string): string[] {
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).flatMap(
    (message) =>
      message.content.flatMap((part) =>
        part.type === "systemNotification" ? [part.text] : [],
      ),
  );
}

describe("handleUndeclaredSessionModel", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSessionTargetCoordinatorsForTests();
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s1",
          title: "Chat",
          executionTarget: PINNED,
          workingDir: "/repo/app",
          createdAt: "now",
          updatedAt: "now",
          messageCount: 0,
        },
      ],
    });
    useAgentStore.setState({
      providers: [{ id: "codex-acp", label: "Codex" }],
    });
  });

  // Not a toast: the refusal changes which model the conversation runs on, and
  // that has to still be readable when the operator comes back to the window.
  it("puts a card in the chat naming the model and the harness", () => {
    handleUndeclaredSessionModel({
      sessionId: "s1",
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol[ultra]",
      fallbackModelId: "current",
      declaredModelIds: ["current", "gpt-5.6-sol[xhigh]"],
    });

    const texts = notificationTexts("s1");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("GPT 5.6 Sol (ultra)");
    expect(texts[0]).toContain("Codex");
  });

  it("unpins the model so the next prepare does not name it again", () => {
    handleUndeclaredSessionModel({
      sessionId: "s1",
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol[ultra]",
      fallbackModelId: "current",
      declaredModelIds: ["current"],
    });

    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual({ harnessId: "codex-acp", modelProviderId: "codex-acp" });
  });

  // The refusal happens while a session is being created, before the chat
  // store has ever heard of it. The card must survive that ordering — it is
  // the only record the operator will get.
  it("records the card for a session the chat store has not seen yet", () => {
    handleUndeclaredSessionModel({
      sessionId: "brand-new",
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol[ultra]",
      fallbackModelId: "current",
      declaredModelIds: ["current"],
    });

    expect(notificationTexts("brand-new")).toHaveLength(1);
  });
});
