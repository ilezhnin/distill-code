import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

import {
  applyChildReasoningEffort,
  reasoningEffortOptionId,
  resetChildReasoningEffortIoForTests,
  setChildReasoningEffortIoForTests,
} from "./childReasoningEffort";

const CHILD_ID = "child-1";

function seedChild(
  reasoningEffort:
    | {
        configId: string;
        currentValue: string;
        options: { id: string; name: string }[];
      }
    | undefined,
): void {
  useChatSessionStore.setState({
    sessions: [
      {
        id: CHILD_ID,
        title: "Scout",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 0,
        workingDir: "/repo",
        executionTarget: {
          harnessId: "claude-acp",
          modelProviderId: "claude-acp",
          modelId: "fable-5-1",
          modelName: "Fable 5.1",
        },
        reasoningEffort,
      } as never,
    ],
  });
}

describe("reasoningEffortOptionId", () => {
  const config = {
    configId: "reasoning",
    currentValue: "xhigh",
    options: [
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "xhigh", name: "XHigh" },
    ],
  };

  it("matches an option by id or name, case-insensitively", () => {
    expect(reasoningEffortOptionId(config, "medium")).toBe("medium");
    expect(
      reasoningEffortOptionId(
        { ...config, options: [{ id: "effort-2", name: "medium" }] },
        "medium",
      ),
    ).toBe("effort-2");
  });

  it("answers nothing rather than the nearest neighbour", () => {
    // Running a step at an effort the ranking did not ask for is the failure
    // this path exists to remove; the harness default is the honest fallback.
    expect(reasoningEffortOptionId(config, "ultra")).toBeNull();
    expect(reasoningEffortOptionId(undefined, "medium")).toBeNull();
    expect(
      reasoningEffortOptionId({ ...config, options: [] }, "medium"),
    ).toBeNull();
  });
});

describe("applyChildReasoningEffort", () => {
  const setConfigOption = vi.fn();

  beforeEach(() => {
    setConfigOption.mockReset();
    setConfigOption.mockResolvedValue({ model: null, reasoningEffort: null });
    setChildReasoningEffortIoForTests({ setConfigOption });
  });

  afterEach(() => {
    resetChildReasoningEffortIoForTests();
    useChatSessionStore.setState({ sessions: [] });
  });

  it("moves the child to the ranked effort and records it", async () => {
    // The whole point: "medium engineering at medium" was a session running at
    // whatever the bridge defaults to on every harness that does not embed the
    // effort in the model id.
    seedChild({
      configId: "reasoning",
      currentValue: "xhigh",
      options: [
        { id: "medium", name: "Medium" },
        { id: "xhigh", name: "XHigh" },
      ],
    });

    await expect(applyChildReasoningEffort(CHILD_ID, "medium")).resolves.toBe(
      true,
    );
    expect(setConfigOption).toHaveBeenCalledWith(
      CHILD_ID,
      "reasoning",
      "medium",
      expect.objectContaining({ reasoningEffortValue: "medium" }),
    );
    expect(
      useChatSessionStore.getState().getSession(CHILD_ID)?.reasoningEffort
        ?.currentValue,
    ).toBe("medium");
  });

  it("leaves a session that cannot express the effort alone", async () => {
    seedChild({
      configId: "reasoning",
      currentValue: "high",
      options: [{ id: "high", name: "High" }],
    });

    await expect(applyChildReasoningEffort(CHILD_ID, "medium")).resolves.toBe(
      false,
    );
    expect(setConfigOption).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession(CHILD_ID)?.reasoningEffort
        ?.currentValue,
    ).toBe("high");
  });

  it("puts the previous effort back when the call fails", async () => {
    seedChild({
      configId: "reasoning",
      currentValue: "xhigh",
      options: [
        { id: "medium", name: "Medium" },
        { id: "xhigh", name: "XHigh" },
      ],
    });
    setConfigOption.mockRejectedValue(new Error("bridge died"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // A child that is already created and already has its prompt queued must
    // not be taken down by a config call.
    await expect(applyChildReasoningEffort(CHILD_ID, "medium")).resolves.toBe(
      false,
    );
    expect(
      useChatSessionStore.getState().getSession(CHILD_ID)?.reasoningEffort
        ?.currentValue,
    ).toBe("xhigh");
  });

  it("does nothing when the session advertises no effort at all", async () => {
    seedChild(undefined);
    await expect(applyChildReasoningEffort(CHILD_ID, "medium")).resolves.toBe(
      false,
    );
    expect(setConfigOption).not.toHaveBeenCalled();
  });
});
