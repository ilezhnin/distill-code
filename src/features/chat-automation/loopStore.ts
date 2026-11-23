import { automationCopy as copy } from "./automationCopy";
import { create } from "zustand";
import { z } from "zod";
import { flockDocument } from "@/shared/lib/flockDocument";
import { getUsageLedger } from "@/features/stats/lib/usageLedger";
import { DAY, MAX_CHAT_LOOPS, MIN_DELAY } from "./loopCommands";

const count = z.number().int().nonnegative();
const schema = z.object({
  id: z.string(),
  number: count.positive(),
  prompt: z.string().min(1),
  intervalMs: count.min(MIN_DELAY).optional(),
  createdAt: count,
  nextRunAt: count.nullable(),
  status: z.enum(["active", "paused"]),
  note: z.string(),
  runs: count,
  tokens: count,
  failures: count,
  pending: z
    .object({
      messageId: z.string(),
      stopped: z.literal(true).optional(),
      ledgerBefore: count,
      dueAt: count,
    })
    .optional(),
});
export type ChatLoop = z.infer<typeof schema>;
type Loops = Record<string, ChatLoop[]>;
const document = flockDocument<Loops>({
  path: "state/chat-loops.json",
  legacyStorageKey: "flock:chat-loops",
  parse: (raw) =>
    z.record(z.string(), z.array(schema).max(MAX_CHAT_LOOPS)).parse(raw),
  serialize: (loops) => loops,
});
export const loopExpiry = (loop: ChatLoop) => loop.createdAt + 7 * DAY;
export const loopSessionTokens = (id: string) =>
  getUsageLedger().sessions[id]?.totalTokens ?? 0;
export function loopCounters(id: string, loop: ChatLoop) {
  return {
    runs: loop.runs,
    tokens:
      loop.tokens +
      (loop.pending
        ? Math.max(0, loopSessionTokens(id) - loop.pending.ledgerBefore)
        : 0),
    nextRunAt: loop.status === "active" ? loop.nextRunAt : null,
    expiresAt: loopExpiry(loop),
  };
}

interface LoopStore {
  loops: Loops;
  start: (
    id: string,
    prompt: string,
    intervalMs?: number,
  ) => ChatLoop | undefined;
  pause: (id: string, loopId: string, reason?: string) => void;
  resume: (id: string, loopId: string) => void;
  stop: (id: string, loopId: string, reason?: string) => void;
  clear: (id: string, reason?: string) => void;
  update: (id: string, loopId: string, changes: Partial<ChatLoop>) => void;
}
type Transition = (
  id: string,
  loop: ChatLoop,
  status: "paused" | "resumed" | "ended",
  reason: string,
) => void;
const listeners = new Set<Transition>();
export function onLoopTransition(listener: Transition) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function announce(...args: Parameters<Transition>) {
  for (const listener of listeners) listener(...args);
}

export const useChatLoopStore = create<LoopStore>((set, get) => {
  function replace(id: string, loops: ChatLoop[]) {
    const all = { ...get().loops };
    if (loops.length) all[id] = loops;
    else delete all[id];
    set({ loops: all });
  }
  return {
    loops: {},
    start(id, prompt, intervalMs) {
      const loops = get().loops[id] ?? [];
      if (loops.length >= MAX_CHAT_LOOPS) return;
      let number = 1;
      while (loops.some((loop) => loop.number === number)) number++;
      const now = Date.now();
      const loop: ChatLoop = {
        id: crypto.randomUUID(),
        number,
        prompt,
        intervalMs,
        createdAt: now,
        nextRunAt: now,
        status: "active",
        note: "",
        runs: 0,
        tokens: 0,
        failures: 0,
      };
      replace(id, [...loops, loop]);
      return loop;
    },
    update(id, loopId, changes) {
      const loops = get().loops[id];
      if (loops?.some((loop) => loop.id === loopId))
        replace(
          id,
          loops.map((loop) =>
            loop.id === loopId ? { ...loop, ...changes } : loop,
          ),
        );
    },
    pause(id, loopId, reason = copy("operatorPaused")) {
      const loop = getChatLoop(id, loopId);
      if (loop?.status !== "active") return;
      get().update(id, loopId, {
        status: "paused",
        note: reason,
        nextRunAt: null,
      });
      announce(id, loop, "paused", reason);
    },
    resume(id, loopId) {
      const loop = getChatLoop(id, loopId);
      if (loop?.status !== "paused") return;
      get().update(id, loopId, {
        status: "active",
        note: "",
        failures: 0,
        nextRunAt: Date.now(),
      });
      announce(id, loop, "resumed", "");
    },
    stop(id, loopId, reason = copy("operatorStopped")) {
      const loop = getChatLoop(id, loopId);
      if (!loop) return;
      replace(
        id,
        get().loops[id].filter((item) => item.id !== loopId),
      );
      announce(id, loop, "ended", reason);
    },
    clear(id, reason) {
      const loops = get().loops[id];
      if (!loops) return;
      replace(id, []);
      if (reason) for (const loop of loops) announce(id, loop, "ended", reason);
    },
  };
});
const empty: readonly ChatLoop[] = [];
export const selectChatLoops =
  (id: string) =>
  (state: LoopStore): readonly ChatLoop[] =>
    state.loops[id] ?? empty;
export const getChatLoops = (id: string) =>
  selectChatLoops(id)(useChatLoopStore.getState());
export const getChatLoop = (id: string, loopId: unknown) =>
  getChatLoops(id).find((loop) => loop.id === loopId);

let hydration: Promise<void> | undefined;
export function hydrateChatLoops() {
  hydration ??= document
    .read()
    .then((loops) => {
      useChatLoopStore.setState({ loops: loops ?? {} });
      useChatLoopStore.subscribe((state) => document.write(state.loops));
    })
    .catch((error) => {
      hydration = undefined;
      throw error;
    });
  return hydration;
}
