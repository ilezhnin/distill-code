import { createContext, useContext, type ReactNode } from "react";

import type { Message } from "@/shared/types/messages";

// Type-only: `brigadeAnchors` imports `latestConductorFooterHostId` from here,
// so the value graph must stay one-directional.
import type { BrigadeNodesByMessageId } from "./brigadeAnchors";
import type { WaveStep } from "./distillWave";
import type { SessionNode, StructuredReport } from "./types";

/**
 * How a child chip wants its session surfaced. Callers omit it and get
 * `navigate`; `openInTab` and `reveal` gain distinct handling in later stages.
 */
export type ConductorOpenChildIntent = "navigate" | "openInTab" | "reveal";

export const DEFAULT_OPEN_CHILD_INTENT: ConductorOpenChildIntent = "navigate";

export interface ConductorTranscriptContextValue {
  enabled: boolean;
  /**
   * The conversation these agents belong to.
   *
   * Carried because the brigade footer's totals have to include the conductor
   * itself: it is a real model call that reads every report and judges every
   * digest, and leaving it out of the one number the operator watches hid the
   * most likely source of a runaway spend.
   */
  hostSessionId?: string;
  children: SessionNode[];
  reportsByRunId: Record<string, StructuredReport>;
  /**
   * Which message hosts which children's chips. Computed once per transcript
   * (see `groupBrigadeNodesByHostMessage`) so each bubble is an O(1) lookup.
   */
  brigadeNodesByMessageId: BrigadeNodesByMessageId;
  /**
   * The wave plan each plan message carried, by that message's id — the chip
   * row's own anchor. It is what lets a chip name its step's access mode after
   * the wave itself has left the engine state.
   */
  wavePlanStepsByMessageId: ReadonlyMap<string, readonly WaveStep[]>;
  onOpenChild?: (sessionId: string, intent?: ConductorOpenChildIntent) => void;
  onStopChild?: (sessionId: string) => void;
}

/**
 * The transcript itself is deliberately *not* on this value. Nothing consumed
 * it, and `controller.messages` is a fresh array on every streamed token — so
 * carrying it here made the context value new on every token, and context
 * consumption bypasses `memo`: every visible bubble re-rendered per token.
 */
const EMPTY_VALUE: ConductorTranscriptContextValue = {
  enabled: false,
  children: [],
  reportsByRunId: {},
  brigadeNodesByMessageId: new Map(),
  wavePlanStepsByMessageId: new Map(),
};

const ConductorTranscriptContext =
  createContext<ConductorTranscriptContextValue>(EMPTY_VALUE);

export function ConductorTranscriptProvider({
  value,
  children,
}: {
  value: ConductorTranscriptContextValue;
  children: ReactNode;
}) {
  return (
    <ConductorTranscriptContext.Provider value={value}>
      {children}
    </ConductorTranscriptContext.Provider>
  );
}

export function useConductorTranscript(): ConductorTranscriptContextValue {
  return useContext(ConductorTranscriptContext);
}

export function latestConductorFooterHostId(
  messages: readonly Message[],
): string | null {
  let lastUserId: string | null = null;
  let assistantAfterLastUser: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      lastUserId = message.id;
      assistantAfterLastUser = null;
    }
    if (message.role === "assistant" && lastUserId) {
      assistantAfterLastUser = message.id;
    }
  }
  return assistantAfterLastUser ?? lastUserId;
}
