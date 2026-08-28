import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import userEvent from "@testing-library/user-event";

import { useChatStore } from "@/features/chat/stores/chatStore";

import { ConductorTranscriptProvider } from "../ConductorTranscriptContext";

import type { SessionNode } from "../types";

const deliverEnvelope = vi.hoisted(() => vi.fn());
vi.mock("../digestDelivery", () => ({
  deliverEnvelope,
  classifyDigestDispatchError: () => ({ status: "failed" as const }),
}));

const stopOrchestratorSession = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../orchestratorControls", () => ({ stopOrchestratorSession }));

const { BrigadeWaitIndicator } = await import("./BrigadeWaitIndicator");
const { resetWavePokeForTests } = await import("../wavePoke");
const { WAVE_POKE_PROMPT } = await import("../wavePrompts");
const { createWaveState, withWaveStepPhase } = await import("../waveEngine");
const {
  getWaveEngineState,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
} = await import("../waveStore");

function node(
  sessionId: string,
  status: SessionNode["status"],
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status,
    ...overrides,
  };
}

describe("BrigadeWaitIndicator", () => {
  beforeEach(() => {
    resetWavePokeForTests();
    deliverEnvelope.mockReset();
    deliverEnvelope.mockResolvedValue({ status: "dispatched" as const });
  });

  afterEach(() => {
    resetWavePokeForTests();
  });

  it("announces the working count while the chat is idle", () => {
    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[
          node("a", "running"),
          node("b", "waiting", { managedBy: "wave" }),
          node("c", "completed"),
        ]}
      />,
    );

    const indicator = screen.getByTestId("brigade-wait-indicator");
    expect(indicator).toHaveAttribute("role", "status");
    expect(indicator).toHaveTextContent("2 executors are working");
  });

  it("uses the singular form for a single child", () => {
    render(
      <BrigadeWaitIndicator chatState="idle" nodes={[node("a", "starting")]} />,
    );

    expect(screen.getByTestId("brigade-wait-indicator")).toHaveTextContent(
      "1 executor is working",
    );
  });

  function withTranscript(
    onOpenChild: (sessionId: string, intent?: string) => void,
    nodes: SessionNode[],
  ) {
    return render(
      <ConductorTranscriptProvider
        value={{
          enabled: true,
          children: [],
          reportsByRunId: {},
          brigadeNodesByMessageId: new Map(),
          wavePlanStepsByMessageId: new Map(),
          onOpenChild,
        }}
      >
        <BrigadeWaitIndicator chatState="idle" nodes={nodes} />
      </ConductorTranscriptProvider>,
    );
  }

  it("offers each working executor as a way into its own chat (L4)", async () => {
    // Transparency is the product's rule, not a nicety: an agent the operator
    // can see working is an agent whose chat they can open. This line used to
    // be the one place that said "someone is working" and gave no way in.
    const onOpenChild = vi.fn();
    withTranscript(onOpenChild, [
      node("a", "running", { displayName: "Scout · retry" }),
      node("b", "completed", { displayName: "Bohr" }),
    ]);

    const entries = screen.getAllByTestId("agent-tree-open");
    // Only the ones actually working: a finished executor is reachable from
    // its chip, and repeating it here would make the line lie about who is
    // still running.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent("Scout · retry");

    await userEvent.click(entries[0]);
    // The same intent the chip row uses, so the child opens beside the
    // conversation instead of replacing it.
    expect(onOpenChild).toHaveBeenCalledWith("a", "openInTab");
  });

  it("nests a subagent under the executor that started it", async () => {
    // The requirement this line kept failing: "N executors are working" has to
    // lead to *every* agent it is counting, including the ones a step spawned
    // for itself, and it has to say whose they are.
    const onOpenChild = vi.fn();
    withTranscript(onOpenChild, [
      node("orch", "waiting", { role: "orchestrator", displayName: "Atlas" }),
      node("sub", "running", {
        parentSessionId: "orch",
        displayName: "Curie",
      }),
    ]);

    const rows = screen.getAllByTestId("agent-tree-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-depth", "0");
    expect(rows[1]).toHaveAttribute("data-depth", "1");
    expect(rows[1]).toHaveAttribute("data-session-id", "sub");

    await userEvent.click(
      screen.getAllByTestId("agent-tree-open")[1] as HTMLElement,
    );
    expect(onOpenChild).toHaveBeenCalledWith("sub", "openInTab");
  });

  it("says nothing clickable when there is nowhere to open a child", () => {
    render(
      <BrigadeWaitIndicator chatState="idle" nodes={[node("a", "running")]} />,
    );
    expect(screen.queryByTestId("agent-tree-open")).toBeNull();
  });

  it("renders nothing while the chat itself is streaming", () => {
    const { container } = render(
      <BrigadeWaitIndicator
        chatState="streaming"
        nodes={[node("a", "running")]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once every child is terminal", () => {
    const { container } = render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[node("a", "completed"), node("b", "stopped")]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without children", () => {
    const { container } = render(
      <BrigadeWaitIndicator chatState="idle" nodes={[]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("offers no poke without a session to poke", () => {
    render(
      <BrigadeWaitIndicator chatState="idle" nodes={[node("a", "running")]} />,
    );

    expect(screen.queryByTestId("brigade-poke-button")).toBeNull();
  });

  it("pokes the waiting session itself, never its children", async () => {
    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[node("a", "running")]}
        sessionId="conductor-1"
      />,
    );

    await act(async () => {
      screen.getByTestId("brigade-poke-button").click();
    });

    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    expect(deliverEnvelope).toHaveBeenCalledWith(
      "conductor-1",
      WAVE_POKE_PROMPT,
    );
  });

  it("cannot be spammed: a second press while one is in flight does nothing", async () => {
    let release: (() => void) | undefined;
    deliverEnvelope.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "dispatched" as const });
        }),
    );

    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[node("a", "running")]}
        sessionId="conductor-1"
      />,
    );
    const button = screen.getByTestId("brigade-poke-button");

    await act(async () => {
      button.click();
    });
    expect(button).toBeDisabled();

    await act(async () => {
      button.click();
      button.click();
    });
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
    });
    expect(screen.getByTestId("brigade-poke-button")).not.toBeDisabled();
  });

  it("stays disabled across a remount while the poke is still in flight", async () => {
    let release: (() => void) | undefined;
    deliverEnvelope.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "dispatched" as const });
        }),
    );

    const view = render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[node("a", "running")]}
        sessionId="conductor-1"
      />,
    );
    await act(async () => {
      screen.getByTestId("brigade-poke-button").click();
    });
    view.unmount();

    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[node("a", "running")]}
        sessionId="conductor-1"
      />,
    );
    // Component state would have forgotten; the process-local guard does not.
    expect(screen.getByTestId("brigade-poke-button")).toBeDisabled();

    await act(async () => {
      release?.();
    });
  });

  describe("the stop-wave control (5b)", () => {
    beforeEach(() => {
      window.localStorage.clear();
      resetWaveEngineStateCache();
      stopOrchestratorSession.mockClear();
      useChatStore.setState({ messagesBySession: {} });
    });

    function seedRunningWave(conductorSessionId = "conductor-1"): void {
      setWaveEngineState(
        withWave(
          getWaveEngineState(),
          withWaveStepPhase(
            createWaveState({
              waveId: "wave-1",
              conductorSessionId,
              planMessageId: "plan-1",
              steps: [{ role: "scout", subtask: "Look", access: [] }],
              createdAt: 1,
            }),
            0,
            { phase: "spawned", sessionId: "a", runId: "run-a" },
          ),
        ),
      );
    }

    it("offers the stop only while this session has a running wave", () => {
      render(
        <BrigadeWaitIndicator
          chatState="idle"
          nodes={[node("a", "running", { managedBy: "wave" })]}
          sessionId="conductor-1"
        />,
      );
      // No wave on the books — the children may be legacy or harness agents,
      // and there is no wave to stop.
      expect(screen.queryByTestId("brigade-stop-wave-button")).toBeNull();
    });

    it("stops the running wave: parks it, stops the child, tells the operator", async () => {
      seedRunningWave();
      render(
        <BrigadeWaitIndicator
          chatState="idle"
          nodes={[node("a", "running", { managedBy: "wave" })]}
          sessionId="conductor-1"
        />,
      );

      await act(async () => {
        screen.getByTestId("brigade-stop-wave-button").click();
      });

      expect(getWaveEngineState().waves[0]?.phase).toBe("needsOperator");
      expect(stopOrchestratorSession).toHaveBeenCalledWith("a");
      const notices = (
        useChatStore.getState().messagesBySession["conductor-1"] ?? []
      ).flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === "systemNotification" ? [block.text] : [],
        ),
      );
      expect(notices).toHaveLength(1);
    });

    it("offers no stop for another conductor's wave", () => {
      seedRunningWave("conductor-elsewhere");
      render(
        <BrigadeWaitIndicator
          chatState="idle"
          nodes={[node("a", "running", { managedBy: "wave" })]}
          sessionId="conductor-1"
        />,
      );
      expect(screen.queryByTestId("brigade-stop-wave-button")).toBeNull();
    });
  });
});
