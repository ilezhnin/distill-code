import { beforeEach, describe, expect, it } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";

import {
  harnessRejectedModelNotice,
  isHarnessRejectedModelError,
  noticeForUndeclaredSessionModel,
  recoverSessionFromRejectedModel,
} from "./rejectedModelRecovery";

function session(executionTarget: SessionExecutionTarget) {
  return {
    id: "s1",
    title: "Chat",
    executionTarget,
    workingDir: "/repo/app",
    createdAt: "now",
    updatedAt: "now",
    messageCount: 0,
  };
}

const PINNED = {
  harnessId: "codex-acp",
  modelProviderId: "codex-acp",
  modelId: "gpt-5.6-sol[max]",
  modelName: "GPT 5.6 Sol (max)",
};

describe("isHarnessRejectedModelError", () => {
  // The shape the operator actually saw, every single send.
  it("recognizes the goose wrapper around the agent's Invalid params", () => {
    expect(
      isHarnessRejectedModelError(
        new Error(
          "Request failed: Failed to set ACP model option: Invalid params",
        ),
      ),
    ).toBe(true);
  });

  it("recognizes it through an ACP error object's data field", () => {
    expect(
      isHarnessRejectedModelError({
        message: "Request failed",
        data: "Failed to set ACP model option: Invalid params",
      }),
    ).toBe(true);
  });

  // Both halves are required: rewriting a session's target is far too big a
  // consequence to hang on either phrase alone.
  it("ignores an unrelated Invalid params and an unrelated option failure", () => {
    expect(
      isHarnessRejectedModelError(new Error("Request failed: Invalid params")),
    ).toBe(false);
    expect(
      isHarnessRejectedModelError(
        new Error("Failed to set ACP model option: connection closed"),
      ),
    ).toBe(false);
    expect(isHarnessRejectedModelError(undefined)).toBe(false);
  });
});

describe("recoverSessionFromRejectedModel", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({ sessions: [session(PINNED)] });
    useAgentStore.setState({
      providers: [{ id: "codex-acp", label: "Codex" }],
    });
  });

  it("unpins the model so the next send runs on the harness' own", () => {
    expect(recoverSessionFromRejectedModel("s1")).toEqual({
      rejectedModelName: "GPT 5.6 Sol (max)",
      harnessId: "codex-acp",
    });

    // The provider survives: the harness rejected a value for the model
    // option, it said nothing about the provider.
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual({ harnessId: "codex-acp", modelProviderId: "codex-acp" });
  });

  it("has nothing to blame when the session names no model", () => {
    useChatSessionStore.setState({
      sessions: [session({ harnessId: "codex-acp" })],
    });

    expect(recoverSessionFromRejectedModel("s1")).toBeNull();
    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual({ harnessId: "codex-acp" });
  });

  it("names the model, the harness and the way out", () => {
    const notice = harnessRejectedModelNotice({
      rejectedModelName: "GPT 5.6 Sol (max)",
      harnessId: "codex-acp",
    });

    expect(notice).toContain("GPT 5.6 Sol (max)");
    expect(notice).toContain("Codex");
    expect(notice).toContain("model pill");
  });
});

// The same repair before the send instead of after it. The registry has
// already declined to forward the pin by the time this runs, so the session is
// on the harness' current model either way; what is left is making the store
// agree — otherwise the next prepare re-pins the same dead id — and saying so.
describe("noticeForUndeclaredSessionModel", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({ sessions: [session(PINNED)] });
    useAgentStore.setState({
      providers: [{ id: "codex-acp", label: "Codex" }],
    });
  });

  it("unpins the model the harness never offered", () => {
    noticeForUndeclaredSessionModel({
      sessionId: "s1",
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol[max]",
    });

    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual({ harnessId: "codex-acp", modelProviderId: "codex-acp" });
  });

  it("names the model and the harness, in the operator's own words for both", () => {
    const notice = noticeForUndeclaredSessionModel({
      sessionId: "s1",
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol[max]",
    });

    expect(notice).toContain("GPT 5.6 Sol (max)");
    expect(notice).toContain("Codex");
    expect(notice).toContain("model pill");
  });

  // The refusal is about a request that is no longer current; rewriting the
  // target would throw away a choice the operator made after it.
  it("leaves a target that has already moved on alone", () => {
    noticeForUndeclaredSessionModel({
      sessionId: "s1",
      providerId: "codex-acp",
      modelId: "some-other-model",
    });

    expect(
      useChatSessionStore.getState().getSession("s1")?.executionTarget,
    ).toEqual(PINNED);
  });

  // A pin can be refused before it ever reaches a target — a stored preference
  // applied to a session being created. The card still has to name it.
  it("still names a model the session target never carried", () => {
    const notice = noticeForUndeclaredSessionModel({
      sessionId: "s1",
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol[ultra]",
    });

    expect(notice).toContain("gpt-5.6-sol[ultra]");
  });
});
