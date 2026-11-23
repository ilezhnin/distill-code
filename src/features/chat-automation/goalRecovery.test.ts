import { beforeEach, expect, it, vi } from "vitest";
import { createUserMessage } from "@/shared/types/messages";

// A fresh renderer for each launch; only the documents survive it.
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("@/shared/api/flockStore", async (load) => ({
  ...(await load<typeof import("@/shared/api/flockStore")>()),
  isDesktopRuntime: () => true,
  readFlockDocument: async (path: string) => disk.get(path) ?? null,
  writeFlockDocument: async (path: string, text: string) => {
    disk.set(path, text);
  },
}));
vi.mock("@/features/chat/lib/sessionActivation", () => ({
  loadSessionMessages: vi.fn(async () => true),
}));
const path = "state/chat-goals.json";
beforeEach(() => {
  disk.clear();
  localStorage.clear();
  vi.resetModules();
});

async function launch() {
  const { useChatGoalStore, hydrateChatGoals } = await import("./goalStore");
  const { flushFlockDocuments } = await import("@/shared/lib/flockDocument");
  await hydrateChatGoals();
  return { store: useChatGoalStore, flush: flushFlockDocuments };
}

async function readySessions() {
  const { useChatStore } = await import("@/features/chat/stores/chatStore");
  const { useChatSessionStore } = await import(
    "@/features/chat/stores/chatSessionStore"
  );
  const { useMemoryStore } = await import(
    "@/features/memory/stores/memoryStore"
  );
  const { setWaveEngineStateHydratedForTests } = await import(
    "@/features/conductor/waveStore"
  );
  const { setConductorGraphHydratedForTests } = await import(
    "@/features/conductor/conductorGraphStore"
  );
  setWaveEngineStateHydratedForTests(true);
  setConductorGraphHydratedForTests(true);
  useMemoryStore.setState({ hydrated: true });
  useChatSessionStore.setState({
    hasHydratedSessions: true,
    sessions: ["a", "b"].map((id) => ({
      id,
      title: id,
      createdAt: "now",
      updatedAt: "now",
      messageCount: 3,
    })),
  });
  useChatStore.setState({ hasHydratedMessageQueues: true });
  return useChatStore;
}

it("restores from app state, queues once for an active chat and leaves a paused chat parked", async () => {
  const first = await launch();
  first.store.getState().start("a", "Read the sample", 5, 123);
  first.store.getState().start("b", "Park this", 2);
  first.store.getState().pause("b", "waiting for input");
  await first.flush();
  expect(JSON.parse(disk.get(path) ?? "null")).toMatchObject({
    a: { budget: 123, status: "active" },
    b: { status: "paused" },
  });
  vi.resetModules();
  const second = await launch();
  const chat = await readySessions();
  const { tickChatGoal } = await import("./goalRuntime");
  const { restoreChatAutomation } = await import("./goalRecovery");
  const stop = await restoreChatAutomation();
  try {
    tickChatGoal("a");
    tickChatGoal("b");
    expect(chat.getState().queuedMessageBySession.a).toHaveLength(1);
    expect(chat.getState().queuedMessageBySession.a[0].payload.text).toContain(
      "Read the sample",
    );
    expect(chat.getState().queuedMessageBySession.b).toBeUndefined();
    expect(second.store.getState().goals.b.note).toBe("waiting for input");
    second.store.getState().clear("a");
    await second.flush();
    expect(Object.keys(JSON.parse(disk.get(path) ?? "null"))).toEqual(["b"]);
  } finally {
    stop();
  }
});

it("still restores goals when the separate loop document fails validation", async () => {
  const first = await launch();
  first.store.getState().start("a", "Review", 5);
  await first.flush();
  disk.set("state/chat-loops.json", JSON.stringify({ a: "invalid" }));
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const chat = await readySessions();
  const { restoreChatAutomation } = await import("./goalRecovery");
  const stop = await restoreChatAutomation();
  try {
    expect(chat.getState().queuedMessageBySession.a[0].payload.text).toContain(
      "Review",
    );
    expect(disk.get("state/chat-loops.json")).toBe(
      JSON.stringify({ a: "invalid" }),
    );
  } finally {
    stop();
  }
});

it("after two closed intervals restores one overdue loop tick and skips both missed deadlines", async () => {
  vi.useFakeTimers();
  let stop: (() => void) | undefined;
  try {
    const first = await launch();
    await readySessions();
    const { hydrateChatLoops, useChatLoopStore } = await import("./loopStore");
    await hydrateChatLoops();
    const { beginLoopTurn, settleLoopTurn } = await import("./loopRuntime");
    const loop = useChatLoopStore.getState().start("a", "Inspect", 60_000);
    const parked = useChatLoopStore.getState().start("b", "Wait", 60_000);
    if (!loop || !parked) throw new Error("Expected both loops to be created.");
    useChatLoopStore.getState().pause("b", parked.id);
    beginLoopTurn("a", loop, "first");
    settleLoopTurn("a", "first");
    await first.flush();
    const saved = disk.get("state/chat-loops.json");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(disk.get("state/chat-loops.json")).toBe(saved);
    vi.resetModules();
    const chat = await readySessions();
    const { restoreChatAutomation } = await import("./goalRecovery");
    const runtime = await import("./loopRuntime");
    const { getChatLoops } = await import("./loopStore");
    stop = await restoreChatAutomation();
    await vi.advanceTimersByTimeAsync(0);
    const [restored] = getChatLoops("a");
    const queue = () => chat.getState().queuedMessageBySession.a ?? [];
    expect(queue()).toHaveLength(1);
    expect(
      queue()[0].payload.sendOptions?.userMessageMetadata?.distillDeliveryId,
    ).toBe(runtime.loopDeliveryId(restored));
    expect(restored.runs).toBe(1);
    runtime.beginLoopTurn("a", restored, "second");
    chat.getState().dismissQueuedMessage("a", queue()[0].recordId);
    runtime.settleLoopTurn("a", "second");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(queue()).toEqual([]);
    expect(getChatLoops("a")[0].runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue()).toHaveLength(1);
    expect(chat.getState().queuedMessageBySession.b).toBeUndefined();
  } finally {
    stop?.();
    vi.useRealTimers();
  }
});

it.each([
  true,
  false,
])("recovers a final loop fence when history reached disk first (done=%s)", async (done) => {
  vi.useFakeTimers();
  let stop: (() => void) | undefined;
  try {
    const first = await launch();
    const { hydrateChatLoops, useChatLoopStore } = await import("./loopStore");
    await hydrateChatLoops();
    const loop = useChatLoopStore.getState().start("a", "Inspect");
    if (!loop) throw new Error("Expected loop");
    await first.flush();
    const user = createUserMessage("First tick");
    const { loopDeliveryId } = await import("./loopRuntime");
    user.metadata = { distillDeliveryId: loopDeliveryId(loop) };
    const reply = createUserMessage(
      `\`\`\`flock-loop-state\n${JSON.stringify(done ? { done: true, note: "Ready" } : { next: "1m" })}\n\`\`\``,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    vi.resetModules();
    const chat = await readySessions();
    chat.getState().addMessage("a", user);
    chat.getState().addMessage("a", { ...reply, role: "assistant" });
    const { restoreChatAutomation } = await import("./goalRecovery");
    const { getChatLoops } = await import("./loopStore");
    stop = await restoreChatAutomation();
    const queue = chat.getState().queuedMessageBySession.a ?? [];
    if (done) {
      expect(getChatLoops("a")).toEqual([]);
      expect(queue).toEqual([]);
    } else {
      expect(getChatLoops("a")[0].runs).toBe(1);
      expect(queue).toHaveLength(1);
      expect(
        queue[0].payload.sendOptions?.userMessageMetadata?.distillDeliveryId,
      ).toBe(loopDeliveryId(loop, 2));
    }
  } finally {
    stop?.();
    vi.useRealTimers();
  }
});

it("recovers a terminal reply even if history reached disk before the goal counter", async () => {
  const first = await launch();
  first.store.getState().start("a", "Review", 5);
  const goalId = first.store.getState().goals.a.id;
  await first.flush();
  vi.resetModules();
  const second = await launch();
  const chat = await readySessions();
  const user = createUserMessage("Goal turn");
  user.metadata = { distillDeliveryId: `goal-turn:${goalId}:1` };
  chat.getState().addMessage("a", user);
  chat.getState().addMessage("a", {
    ...createUserMessage(
      '```flock-goal-state\n{"status":"reached","note":"Done"}\n```',
    ),
    role: "assistant",
  });
  const { restoreChatAutomation } = await import("./goalRecovery");
  const stop = await restoreChatAutomation();
  try {
    expect(second.store.getState().goals.a).toMatchObject({
      status: "reached",
      turns: 1,
      note: "Done",
    });
    expect(chat.getState().queuedMessageBySession.a).toBeUndefined();
  } finally {
    stop();
  }
});
