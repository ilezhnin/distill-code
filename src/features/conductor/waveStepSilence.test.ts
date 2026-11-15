import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  noteSessionUpdate,
  resetSessionPulsesForTests,
  sessionPulse,
} from "@/features/chat/lib/sessionPulse";
import { useAccountQuotaWaitStore } from "@/features/chat/lib/accountQuotaWait";
import { useChatStore } from "@/features/chat/stores/chatStore";

import { createWaveState, withWaveStepPhase } from "./waveEngine";
import { waveStepAllowanceWaitNoticeText } from "./waveNotices";
import {
  allowanceWaitingWaveSteps,
  quietWaveSteps,
  resetWaveStepSilenceForTests,
  WAVE_STEP_SILENCE_MS,
} from "./waveRunner";

const MINUTE = 60_000;
const START = 1_000_000;

function waveWithRunningStep() {
  return withWaveStepPhase(
    createWaveState({
      waveId: "wave-1",
      conductorSessionId: "conductor-1",
      planMessageId: "plan-1",
      steps: [{ role: "scout", subtask: "Read the slice", access: [] }],
      createdAt: START,
    }),
    0,
    { phase: "spawned", sessionId: "child-1", runId: "run-1" },
  );
}

function setChildState(chatState: string | null): void {
  useChatStore.setState({
    sessionStateById: chatState ? ({ "child-1": { chatState } } as never) : {},
  });
}

describe("a session's pulse", () => {
  beforeEach(() => {
    resetSessionPulsesForTests();
  });

  it("counts the tool calls a turn started and has not heard the end of", () => {
    expect(sessionPulse("s")).toBeUndefined();
    noteSessionUpdate("s", { sessionUpdate: "agent_thought_chunk" }, 10);
    expect(sessionPulse("s")).toEqual({ lastEventAt: 10, toolsInFlight: 0 });
    noteSessionUpdate(
      "s",
      { sessionUpdate: "tool_call", toolCallId: "t1", status: "pending" },
      20,
    );
    noteSessionUpdate(
      "s",
      { sessionUpdate: "tool_call_update", toolCallId: "t1" },
      30,
    );
    expect(sessionPulse("s")).toEqual({ lastEventAt: 30, toolsInFlight: 1 });
    noteSessionUpdate(
      "s",
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" },
      40,
    );
    expect(sessionPulse("s")).toEqual({ lastEventAt: 40, toolsInFlight: 0 });
  });
});

describe("a wave step waiting for a spent allowance", () => {
  beforeEach(() => {
    resetWaveStepSilenceForTests();
    useAccountQuotaWaitStore.setState({ waits: {} });
    return () => {
      resetWaveStepSilenceForTests();
      useAccountQuotaWaitStore.setState({ waits: {} });
    };
  });

  const wait = (
    reason: "quota" | "rate_limit",
    startedAt: number,
    resetAt: number | null,
  ) => ({
    retryAt: startedAt + MINUTE,
    startedAt,
    message: "usage limit reached",
    reason,
    resetAt,
    resetTokensAvailable: false,
  });

  it("is told once per wait, with the time the allowance comes back", () => {
    const wave = waveWithRunningStep();
    expect(allowanceWaitingWaveSteps(wave)).toEqual([]);
    useAccountQuotaWaitStore.setState({
      waits: { "child-1": wait("quota", START, START + 60 * MINUTE) },
    });
    expect(allowanceWaitingWaveSteps(wave)).toEqual([
      { stepIndex: 0, sessionId: "child-1", resetAt: START + 60 * MINUTE },
    ]);
    // The same wait is not announced on every tick.
    expect(allowanceWaitingWaveSteps(wave)).toEqual([]);
    // It ends, and a later one is a new wait.
    useAccountQuotaWaitStore.setState({ waits: {} });
    expect(allowanceWaitingWaveSteps(wave)).toEqual([]);
    useAccountQuotaWaitStore.setState({
      waits: { "child-1": wait("quota", START + 90 * MINUTE, null) },
    });
    expect(allowanceWaitingWaveSteps(wave)).toEqual([
      { stepIndex: 0, sessionId: "child-1", resetAt: null },
    ]);
  });

  it("is not a rate-limit refusal, which is sent again within minutes", () => {
    const wave = waveWithRunningStep();
    useAccountQuotaWaitStore.setState({
      waits: { "child-1": wait("rate_limit", START, null) },
    });
    expect(allowanceWaitingWaveSteps(wave)).toEqual([]);
  });

  it("names the step, the time and the command that runs it elsewhere", () => {
    const text = waveStepAllowanceWaitNoticeText({
      waveId: "wave-7",
      stepIndex: 1,
      name: "Reader",
      resetAt: Date.UTC(2026, 10, 14, 21, 30),
      model: "example-one",
    });
    expect(text).toContain("Step 2 (Reader) is waiting on example-one");
    expect(text).toContain("2026-11-14T21:30:00.000Z");
    expect(text).toContain("flockctl wave restart --wave-id wave-7 --step 2");
    expect(
      waveStepAllowanceWaitNoticeText({
        waveId: "wave-7",
        stepIndex: 0,
        name: "Reader",
        resetAt: null,
      }),
    ).toContain("gives no reset time");
  });
});

describe("a wave step whose model has gone quiet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSessionPulsesForTests();
    resetWaveStepSilenceForTests();
    setChildState("thinking");
    return () => {
      resetWaveStepSilenceForTests();
      vi.useRealTimers();
    };
  });

  it("is named once after a long silence, and again only after a new one", () => {
    const wave = waveWithRunningStep();
    noteSessionUpdate(
      "child-1",
      { sessionUpdate: "agent_message_chunk" },
      START,
    );
    // The engine sees the step running from the moment it spawned it.
    expect(quietWaveSteps(wave, START)).toEqual([]);
    // Minutes of thinking are not silence worth a word.
    expect(quietWaveSteps(wave, START + 5 * MINUTE)).toEqual([]);
    expect(quietWaveSteps(wave, START + WAVE_STEP_SILENCE_MS + MINUTE)).toEqual(
      [{ stepIndex: 0, sessionId: "child-1", minutes: 16 }],
    );
    // The same quiet spell is not announced twice.
    expect(quietWaveSteps(wave, START + 40 * MINUTE)).toEqual([]);
    // The model speaks, and falls quiet again: a new spell.
    noteSessionUpdate(
      "child-1",
      { sessionUpdate: "agent_message_chunk" },
      START + 41 * MINUTE,
    );
    expect(quietWaveSteps(wave, START + 45 * MINUTE)).toEqual([]);
    expect(
      quietWaveSteps(wave, START + 41 * MINUTE + WAVE_STEP_SILENCE_MS),
    ).toHaveLength(1);
  });

  it("is not a turn waiting on a tool it started, on its provider, or one that ended", () => {
    const wave = waveWithRunningStep();
    const late = START + WAVE_STEP_SILENCE_MS + MINUTE;
    // A long build in a tool call says nothing for as long as it runs.
    noteSessionUpdate(
      "child-1",
      {
        sessionUpdate: "tool_call",
        toolCallId: "build",
        status: "in_progress",
      },
      START,
    );
    expect(quietWaveSteps(wave, late)).toEqual([]);
    // Waiting for the provider's allowance is already shown as waiting.
    resetSessionPulsesForTests();
    resetWaveStepSilenceForTests();
    noteSessionUpdate(
      "child-1",
      { sessionUpdate: "agent_message_chunk" },
      START,
    );
    setChildState("waiting");
    expect(quietWaveSteps(wave, late)).toEqual([]);
    // And a turn that ended is not running at all.
    setChildState("idle");
    expect(quietWaveSteps(wave, late)).toEqual([]);
    setChildState(null);
    expect(quietWaveSteps(wave, late)).toEqual([]);
  });

  it("starts its clock when this process first sees the step running", () => {
    const wave = waveWithRunningStep();
    // After a restart nothing was ever heard from the child here.
    expect(quietWaveSteps(wave, START)).toEqual([]);
    expect(quietWaveSteps(wave, START + WAVE_STEP_SILENCE_MS - MINUTE)).toEqual(
      [],
    );
    expect(quietWaveSteps(wave, START + WAVE_STEP_SILENCE_MS)).toEqual([
      { stepIndex: 0, sessionId: "child-1", minutes: 15 },
    ]);
  });
});
