import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWaveState, type WavePhase } from "../../waveEngine";
import {
  emptyWaveEngineState,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
} from "../../waveStore";
import type { SessionNode } from "../../types";
import { BrigadeWaitIndicator } from "../BrigadeWaitIndicator";

const mocks = vi.hoisted(() => ({
  stopWaveByOperator: vi.fn(),
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
  useConductorTranscript: () => ({}),
}));

const CONDUCTOR_ID = "conductor-1";

function worker(status: SessionNode["status"]): SessionNode {
  return {
    sessionId: "child-0",
    projectId: "p",
    role: "worker",
    managedBy: "wave",
    parentSessionId: CONDUCTOR_ID,
    rootConductorId: CONDUCTOR_ID,
    runId: "run-0",
    harnessId: "goose",
    displayName: "Bohr",
    status,
    waveId: "w1",
    stepIndex: 0,
  };
}

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

describe("BrigadeWaitIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetWaveEngineStateCache();
  });

  afterEach(() => {
    resetWaveEngineStateCache();
  });

  it("says what the wave is doing, not 'waiting for the verdict', in every phase", () => {
    // One label for every live phase was wrong in two of them: a wave in
    // `running` with no working children is still creating them, and a wave in
    // `digestPending` is building its digest. Neither waits on the conductor.
    const labels: Array<[WavePhase, string]> = [
      ["running", "conductor.wave.spawning"],
      ["digestPending", "conductor.wave.digestPending"],
      ["dispatchingDigest", "conductor.wave.dispatchingDigest"],
      ["awaitingVerdict", "conductor.wave.awaitingVerdict"],
    ];
    for (const [phase, key] of labels) {
      seedWave(phase);
      const view = render(
        <BrigadeWaitIndicator
          chatState="idle"
          nodes={[]}
          sessionId={CONDUCTOR_ID}
        />,
      );
      expect(
        screen.getByTestId("brigade-wait-indicator").textContent,
      ).toContain(key);
      view.unmount();
    }
  });

  it("keeps the stop control while the conductor itself is streaming", () => {
    // A conductor mid-answer while its workers edit the folder is exactly when
    // an operator reaches for stop; the label needs the idle check, the wave
    // lookup does not.
    seedWave("running");

    render(
      <BrigadeWaitIndicator
        chatState="streaming"
        nodes={[worker("running")]}
        sessionId={CONDUCTOR_ID}
      />,
    );

    expect(screen.getByTestId("brigade-stop-wave-button")).toBeInTheDocument();
    // …and it does not claim anything is being waited for: the answer is
    // arriving right now.
    expect(
      screen.getByTestId("brigade-wait-indicator").textContent,
    ).not.toMatch(
      /conductor\.wave\.(spawning|digestPending|dispatchingDigest|awaitingVerdict)/,
    );
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

  it("renders nothing with no live wave and no working children", () => {
    seedWave("accepted");

    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[]}
        sessionId={CONDUCTOR_ID}
      />,
    );

    expect(screen.queryByTestId("brigade-wait-indicator")).toBeNull();
  });
});
