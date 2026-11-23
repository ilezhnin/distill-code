import { automationCopy as copy } from "./automationCopy";
import { create } from "zustand";
import { z } from "zod";
import { flockDocument } from "@/shared/lib/flockDocument";
import { getUsageLedger } from "@/features/stats/lib/usageLedger";
import { GOAL_MAX_TURNS } from "./commands";

const count = z.number().int().nonnegative();
const goalSchema = z.object({
  id: z.string(),
  objective: z.string().min(1),
  status: z.enum(["active", "paused", "reached"]),
  note: z.string(),
  maxTurns: count.min(1).max(GOAL_MAX_TURNS),
  budget: count.positive().optional(),
  turns: count,
  turnsAtResume: count,
  tokensBeforeResume: count,
  ledgerAtResume: count,
  elapsedBeforeResume: count,
  resumedAt: count,
  // Remember the user message until settlement, including across a restart.
  pendingMessageId: z.string().optional(),
});
export type ChatGoal = z.infer<typeof goalSchema>;
type Goals = Record<string, ChatGoal>;

const document = flockDocument<Goals>({
  path: "state/chat-goals.json",
  legacyStorageKey: "flock:chat-goals",
  parse: (raw) => z.record(z.string(), goalSchema).parse(raw),
  serialize: (goals) => goals,
});

function sessionTokens(sessionId: string) {
  return getUsageLedger().sessions[sessionId]?.totalTokens ?? 0;
}

export function goalCounters(
  sessionId: string,
  goal: ChatGoal,
  now = Date.now(),
) {
  const active = goal.status === "active";
  return {
    turns: goal.turns,
    tokens:
      goal.tokensBeforeResume +
      (active
        ? Math.max(0, sessionTokens(sessionId) - goal.ledgerAtResume)
        : 0),
    elapsedMs:
      goal.elapsedBeforeResume +
      (active ? Math.max(0, now - goal.resumedAt) : 0),
  };
}

interface GoalStore {
  goals: Goals;
  start: (
    sessionId: string,
    objective: string,
    maxTurns: number,
    budget?: number,
  ) => void;
  pause: (sessionId: string, reason?: string) => void;
  reach: (sessionId: string, note: string) => void;
  resume: (sessionId: string) => void;
  clear: (sessionId: string) => void;
  update: (sessionId: string, changes: Partial<ChatGoal>) => void;
}

export const useChatGoalStore = create<GoalStore>((set, get) => {
  function finish(
    sessionId: string,
    status: "paused" | "reached",
    note: string,
  ) {
    const goal = get().goals[sessionId];
    if (goal?.status !== "active") return;
    const { tokens, elapsedMs } = goalCounters(sessionId, goal);
    get().update(sessionId, {
      status,
      note,
      pendingMessageId: undefined,
      tokensBeforeResume: tokens,
      elapsedBeforeResume: elapsedMs,
    });
  }
  return {
    goals: {},
    start(sessionId, objective, maxTurns, budget) {
      const goal: ChatGoal = {
        id: crypto.randomUUID(),
        status: "active",
        objective,
        maxTurns,
        budget,
        turns: 0,
        turnsAtResume: 0,
        ledgerAtResume: sessionTokens(sessionId),
        tokensBeforeResume: 0,
        elapsedBeforeResume: 0,
        resumedAt: Date.now(),
        note: "",
      };
      set({ goals: { ...get().goals, [sessionId]: goal } });
    },
    update(sessionId, changes) {
      const goal = get().goals[sessionId];
      if (goal)
        set({
          goals: { ...get().goals, [sessionId]: { ...goal, ...changes } },
        });
    },
    pause: (id, note = copy("operatorPaused")) => finish(id, "paused", note),
    reach: (id, note) => finish(id, "reached", note),
    resume(sessionId) {
      const goal = get().goals[sessionId];
      if (goal?.status !== "paused") return;
      get().update(sessionId, {
        status: "active",
        note: "",
        turnsAtResume: goal.turns,
        resumedAt: Date.now(),
        ledgerAtResume: sessionTokens(sessionId),
      });
    },
    clear(sessionId) {
      if (!get().goals[sessionId]) return;
      const { [sessionId]: _removed, ...goals } = get().goals;
      set({ goals });
    },
  };
});

export const selectChatGoal = (sessionId: string) => (store: GoalStore) =>
  store.goals[sessionId];
export const getChatGoal = (sessionId: string) =>
  useChatGoalStore.getState().goals[sessionId];

let hydration: Promise<void> | undefined;
export function hydrateChatGoals() {
  hydration ??= document
    .read()
    .then((goals) => {
      useChatGoalStore.setState({ goals: goals ?? {} });
      useChatGoalStore.subscribe((state) => document.write(state.goals));
    })
    .catch((error) => {
      hydration = undefined;
      throw error;
    });
  return hydration;
}
