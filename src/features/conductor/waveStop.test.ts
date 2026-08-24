import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";

const stopOrchestratorSession = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./orchestratorControls", () => ({ stopOrchestratorSession }));

const { stopWaveByOperator } = await import("./waveStop");
const { createWaveState, withWavePhase, withWaveStepPhase } = await import(
  "./waveEngine"
);
const {
  getWaveEngineState,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
} = await import("./waveStore");

const CONDUCTOR_ID = "conductor-1";

function runningWave() {
  return withWaveStepPhase(
    withWaveStepPhase(
      createWaveState({
        waveId: "wave-1",
        conductorSessionId: CONDUCTOR_ID,
        planMessageId: "plan-1",
        steps: [
          { role: "scout", subtask: "one", access: [] },
          { role: "qa", subtask: "two", access: "all" },
        ],
        createdAt: 1,
      }),
      0,
      { phase: "spawned", sessionId: "child-0", runId: "run-0" },
    ),
    1,
    { phase: "spawning" },
  );
}

function seed(wave = runningWave()): void {
  setWaveEngineState(withWave(getWaveEngineState(), wave));
}

function noticeTexts(): string[] {
  return (
    useChatStore.getState().messagesBySession[CONDUCTOR_ID] ?? []
  ).flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "systemNotification" ? [block.text] : [],
    ),
  );
}

describe("stopWaveByOperator", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    window.localStorage.clear();
    resetWaveEngineStateCache();
    stopOrchestratorSession.mockClear();
    useChatStore.setState({ messagesBySession: {} });
  });

  it("parks the wave, stops its spawned children, and tells the operator", () => {
    seed();

    expect(stopWaveByOperator(CONDUCTOR_ID, "wave-1")).toBe(true);

    const wave = getWaveEngineState().waves.find(
      (candidate) => candidate.waveId === "wave-1",
    );
    // Phase first: whatever happens to the child stops, the scheduler will
    // never advance this wave again.
    expect(wave?.phase).toBe("needsOperator");
    // Only steps that actually have a session are told anything; the
    // `spawning` step has nothing to stop yet — the runner's adoption guard
    // covers its late arrival.
    expect(stopOrchestratorSession).toHaveBeenCalledTimes(1);
    expect(stopOrchestratorSession).toHaveBeenCalledWith("child-0");
    expect(noticeTexts()).toEqual([
      expect.stringContaining(
        i18n.t("chat:conductor.wave.verdict.reason.operatorStopped"),
      ),
    ]);
  });

  it("declines silently when the wave has already left running", () => {
    seed(withWavePhase(runningWave(), "digestPending"));

    expect(stopWaveByOperator(CONDUCTOR_ID, "wave-1")).toBe(false);
    expect(stopOrchestratorSession).not.toHaveBeenCalled();
    expect(noticeTexts()).toEqual([]);
    expect(getWaveEngineState().waves[0]?.phase).toBe("digestPending");
  });

  it("declines when the wave is unknown or belongs to another conductor", () => {
    seed();

    expect(stopWaveByOperator(CONDUCTOR_ID, "wave-elsewhere")).toBe(false);
    expect(stopWaveByOperator("someone-else", "wave-1")).toBe(false);
    expect(stopOrchestratorSession).not.toHaveBeenCalled();
    expect(getWaveEngineState().waves[0]?.phase).toBe("running");
  });
});
