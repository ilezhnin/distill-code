import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useConductorGraphStore } from "../../conductorGraphStore";
import { conductorHeld } from "../../conductorHold";
import type { SessionNode } from "../../types";
import { createWaveState, type WavePhase } from "../../waveEngine";
import {
  emptyWaveEngineState,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
} from "../../waveStore";
import { BrigadeWaitIndicator } from "../BrigadeWaitIndicator";

const mocks = vi.hoisted(() => ({
  stopWaveByOperator: vi.fn(),
  onOpenChild: vi.fn(),
}));

vi.mock("../../waveStop", () => ({
  stopWaveByOperator: mocks.stopWaveByOperator,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "count" in options ? `${key}:${String(options.count)}` : key,
  }),
}));

vi.mock("../../ConductorTranscriptContext", () => ({
  useConductorTranscript: () => ({ onOpenChild: mocks.onOpenChild }),
}));

const CONDUCTOR_ID = "conductor-1";

function seedWave(phase: WavePhase): void {
  const wave = {
    ...createWaveState({
      waveId: "w1",
      conductorSessionId: CONDUCTOR_ID,
      planMessageId: "plan-1",
      steps: [{ role: "scout", subtask: "Look", access: [] as const }],
      createdAt: 1,
    }),
    phase,
  };
  setWaveEngineState(withWave(emptyWaveEngineState(), wave));
}

function workers(count: number, conductorId: string): SessionNode[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `${conductorId}-worker-${index}`,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: conductorId,
    rootConductorId: conductorId,
    runId: null,
    harnessId: "claude-acp",
    displayName: `Scout ${index}`,
    status: "running",
    createdAt: 1_000 + index,
  }));
}

describe("BrigadeWaitIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetWaveEngineStateCache();
  });

  afterEach(() => {
    resetWaveEngineStateCache();
  });

  it("stops the wave, not one child", async () => {
    const user = userEvent.setup();
    seedWave("awaitingVerdict");

    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[]}
        sessionId={CONDUCTOR_ID}
      />,
    );
    await user.click(screen.getByTestId("brigade-stop-wave-button"));

    expect(mocks.stopWaveByOperator).toHaveBeenCalledWith(CONDUCTOR_ID, "w1");
  });

  it("lets the operator hold a conductor's new work, and shows the hold until it is lifted", async () => {
    const user = userEvent.setup();
    const conductorId = "conductor-held";
    useConductorGraphStore.setState({
      nodesById: {
        [conductorId]: {
          ...workers(1, conductorId)[0],
          sessionId: conductorId,
          role: "conductor",
          managedBy: "ui",
          parentSessionId: null,
        },
      },
    });
    const view = render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={workers(2, conductorId)}
        sessionId={conductorId}
      />,
    );
    const button = screen.getByTestId("brigade-hold-button");
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    expect(conductorHeld(conductorId)).toBe(true);
    expect(screen.getByTestId("brigade-hold-button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // The brigade finishes: the hold is still said, and can be lifted.
    view.rerender(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[]}
        sessionId={conductorId}
      />,
    );
    expect(screen.getByTestId("brigade-hold-label")).toHaveTextContent(
      "conductor.hold.label",
    );
    await user.click(screen.getByTestId("brigade-hold-button"));
    expect(conductorHeld(conductorId)).toBe(false);
    expect(screen.queryByTestId("brigade-wait-indicator")).toBeNull();
    useConductorGraphStore.setState({ nodesById: {} });
  });

  it("offers no hold in a chat that is no conductor", () => {
    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={workers(2, "plain-chat")}
        sessionId="plain-chat"
      />,
    );
    expect(screen.queryByTestId("brigade-hold-button")).toBeNull();
  });

  it("counts a brigade in one line and lists it when asked", async () => {
    const user = userEvent.setup();
    const conductorId = "conductor-folded";

    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={workers(23, conductorId)}
        sessionId={conductorId}
      />,
    );

    const toggle = screen.getByTestId("brigade-wait-toggle");
    expect(toggle).toHaveTextContent("conductor.waitingOnChildren:23");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("agent-tree-row")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("agent-tree-row")).toHaveLength(23);
    // The list scrolls inside its own bounded box rather than growing with
    // the brigade.
    expect(screen.getByTestId("brigade-wait-lists")).toHaveClass(
      "overflow-y-auto",
      "max-h-[min(40vh,15rem)]",
    );

    await user.click(screen.getAllByTestId("agent-tree-open")[4]);
    expect(mocks.onOpenChild).toHaveBeenCalledWith(
      `${conductorId}-worker-4`,
      "openInTab",
    );

    await user.click(toggle);
    expect(screen.queryByTestId("agent-tree-row")).not.toBeInTheDocument();
  });

  it("keeps a chat's list the way the operator left it", async () => {
    const user = userEvent.setup();
    const opened = "conductor-opened";
    const untouched = "conductor-untouched";

    const first = render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={workers(2, opened)}
        sessionId={opened}
      />,
    );
    await user.click(screen.getByTestId("brigade-wait-toggle"));
    expect(screen.getAllByTestId("agent-tree-row")).toHaveLength(2);

    // The same indicator now serves another chat: that one stays folded.
    first.rerender(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={workers(2, untouched)}
        sessionId={untouched}
      />,
    );
    expect(screen.queryByTestId("agent-tree-row")).not.toBeInTheDocument();
    first.unmount();

    // Coming back to the first chat finds its list open.
    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={workers(2, opened)}
        sessionId={opened}
      />,
    );
    expect(screen.getAllByTestId("agent-tree-row")).toHaveLength(2);
  });
});
