import { afterEach, expect, it } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { Message } from "@/shared/types/messages";
import { createWaveState } from "./waveEngine";
import {
  resetWaveLifecycleForTests,
  restoreParkedWaveNotices,
} from "./waveLifecycle";
import { emptyWaveEngineState, parseWaveEngineState } from "./waveStore";

afterEach(() => {
  resetWaveLifecycleForTests();
  useChatStore.setState({ messagesBySession: {} });
});

function parked(conductorSessionId: string) {
  const wave = createWaveState({
    waveId: `wave-${conductorSessionId}`,
    conductorSessionId,
    planMessageId: "plan-1",
    steps: [{ role: "qa", subtask: "Verify the invented change", access: [] }],
    createdAt: 1,
  });
  return {
    ...wave,
    phase: "needsOperator" as const,
    closure: { reason: "revision-cap-reached" as const },
  };
}

function notices(sessionId: string): Message[] {
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).filter(
    (message) => message.role === "system",
  );
}

it("restates a parked wave's persisted closure once, after its transcript is loaded", () => {
  const conversation: Message = {
    id: "user-1",
    role: "user",
    created: 1,
    content: [{ type: "text", text: "Invented request" }],
    metadata: {},
  } as unknown as Message;
  const state = parseWaveEngineState(
    JSON.parse(
      JSON.stringify({
        ...emptyWaveEngineState(),
        waves: [parked("loaded-conductor"), parked("unloaded-conductor")],
      }),
    ),
  );
  // The closure survives persistence; that is what a restart reads.
  expect(state.waves.map((wave) => wave.closure?.reason)).toEqual([
    "revision-cap-reached",
    "revision-cap-reached",
  ]);
  useChatStore.setState({
    messagesBySession: { "loaded-conductor": [conversation] },
  });
  restoreParkedWaveNotices(state, () => {});
  restoreParkedWaveNotices(state, () => {});
  expect(notices("loaded-conductor")).toHaveLength(1);
  // A conductor whose history is not loaded yet gets nothing ahead of it.
  expect(notices("unloaded-conductor")).toHaveLength(0);
});
