import { beforeEach, describe, expect, it } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";

import {
  harnessRejectedModelNotice,
  isHarnessRejectedModelError,
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
