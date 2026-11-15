/**
 * A wave step that ends its turn without the report block is asked for it
 * once, in its own chat, and the step stays open until it has answered.
 *
 * On 11-14 a step told to start work and wait ended its turn with nothing,
 * and the wave went on with "The agent finished." as that step's result.
 */
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/shared/types/messages";

import type { SessionNode } from "./types";

const mocks = vi.hoisted(() => ({
  deliverEnvelope: vi.fn(async () => ({ status: "dispatched" as const })),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: vi.fn(async () => {
    throw new Error("not available in tests");
  }),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: vi.fn(async () => {}),
}));

vi.mock("./digestDelivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./digestDelivery")>()),
  deliverEnvelope: mocks.deliverEnvelope,
}));

function stepNode(
  sessionId: string,
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "invented-project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${sessionId}`,
    harnessId: "grok-acp",
    displayName: "Integrator",
    status: "starting",
    createdAt: 1,
    ...overrides,
  };
}

function reply(id: string, text: string, role: Message["role"] = "assistant") {
  return {
    id,
    role,
    created: Date.now(),
    content: [{ type: "text", text }],
    metadata: { userVisible: true, agentVisible: true },
  } as Message;
}

const REPORT = [
  "```distill-report",
  JSON.stringify({
    status: "completed",
    summary: "Read the slice and wrote the names.",
    decisions: [],
    artifacts: [{ label: "names.csv", path: "out/names.csv" }],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
  }),
  "```",
].join("\n");

async function loadModules() {
  vi.resetModules();
  const [
    { useConductorGraphSync },
    { useConductorGraphStore },
    { useChatStore },
    { useChatSessionStore },
    { WAVE_REPORT_NUDGE_PROMPT },
  ] = await Promise.all([
    import("./useConductorGraphSync"),
    import("./conductorGraphStore"),
    import("@/features/chat/stores/chatStore"),
    import("@/features/chat/stores/chatSessionStore"),
    import("./wavePrompts"),
  ]);
  useChatStore.setState({ hasHydratedMessageQueues: true });
  useChatSessionStore.setState({ hasHydratedSessions: true });
  renderHook(() => useConductorGraphSync());
  return {
    graph: () => useConductorGraphStore.getState(),
    useChatStore,
    WAVE_REPORT_NUDGE_PROMPT,
  };
}

describe("a wave step that ends its turn without the report block", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.deliverEnvelope.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("is asked for it once, stays open, and reports in the turn that answers", async () => {
    const { graph, useChatStore, WAVE_REPORT_NUDGE_PROMPT } =
      await loadModules();
    act(() => {
      graph().registerNode(stepNode("step-1"));
      useChatStore.getState().setChatState("step-1", "streaming");
    });
    act(() => {
      useChatStore
        .getState()
        .addMessage("step-1", reply("m1", "Started the readers. Waiting."));
      useChatStore.getState().setChatState("step-1", "idle");
    });
    expect(mocks.deliverEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.deliverEnvelope).toHaveBeenCalledWith(
      "step-1",
      WAVE_REPORT_NUDGE_PROMPT,
    );
    // Nothing is concluded from the silence while the question is out.
    expect(graph().getNode("step-1")?.status).toBe("running");
    expect(graph().getNode("step-1")?.reportNudged).toBe(true);
    expect(graph().getReport("run-step-1")).toBeUndefined();

    // The step answers with its report.
    act(() => {
      useChatStore.getState().setChatState("step-1", "streaming");
    });
    act(() => {
      useChatStore.getState().addMessage("step-1", reply("m2", REPORT));
      useChatStore.getState().setChatState("step-1", "idle");
    });
    expect(graph().getNode("step-1")?.status).toBe("completed");
    expect(graph().getReport("run-step-1")?.summary).toBe(
      "Read the slice and wrote the names.",
    );
    expect(mocks.deliverEnvelope).toHaveBeenCalledTimes(1);
  });

  it("is read as it stands when the answer carries no report either", async () => {
    const { graph, useChatStore } = await loadModules();
    act(() => {
      graph().registerNode(stepNode("step-2"));
      useChatStore.getState().setChatState("step-2", "streaming");
    });
    act(() => {
      useChatStore.getState().addMessage("step-2", reply("m1", "Done."));
      useChatStore.getState().setChatState("step-2", "idle");
    });
    act(() => {
      useChatStore.getState().setChatState("step-2", "streaming");
    });
    act(() => {
      useChatStore
        .getState()
        .addMessage("step-2", reply("m2", "The names are in out/names.csv."));
      useChatStore.getState().setChatState("step-2", "idle");
    });
    // Asked once: the step's own words stand in for the report it never
    // wrote, as they did before.
    expect(mocks.deliverEnvelope).toHaveBeenCalledTimes(1);
    expect(graph().getNode("step-2")?.status).toBe("completed");
    expect(graph().getReport("run-step-2")?.summary).toBe(
      "The names are in out/names.csv.",
    );
  });

  it("is not asked when it reported, is no wave step, or spoke with the operator", async () => {
    const { graph, useChatStore } = await loadModules();
    const finish = (sessionId: string, messages: Message[]) => {
      act(() => {
        useChatStore.getState().setChatState(sessionId, "streaming");
      });
      act(() => {
        for (const message of messages) {
          useChatStore.getState().addMessage(sessionId, message);
        }
        useChatStore.getState().setChatState(sessionId, "idle");
      });
    };
    act(() => {
      graph().registerNode(stepNode("reported"));
      graph().registerNode(stepNode("not-a-step", { managedBy: "ui" }));
      graph().registerNode(stepNode("with-operator"));
    });
    finish("reported", [reply("m1", REPORT)]);
    finish("not-a-step", [reply("m1", "Done.")]);
    finish("with-operator", [
      {
        ...reply("u1", "Stop there, I will take it from here.", "user"),
        metadata: { origin: "operator_direct" },
      } as Message,
      reply("m1", "Understood."),
    ]);
    expect(mocks.deliverEnvelope).not.toHaveBeenCalled();
    for (const sessionId of ["reported", "not-a-step", "with-operator"]) {
      expect(graph().getNode(sessionId)?.status).toBe("completed");
    }
  });
});
