import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";

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
