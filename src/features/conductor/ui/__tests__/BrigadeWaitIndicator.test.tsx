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
});
