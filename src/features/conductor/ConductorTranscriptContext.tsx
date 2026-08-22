import { createContext, useContext, type ReactNode } from "react";

import type { Message } from "@/shared/types/messages";

import type { SessionNode, StructuredReport } from "./types";

export interface ConductorTranscriptContextValue {
  enabled: boolean;
  children: SessionNode[];
  reportsByRunId: Record<string, StructuredReport>;
  messages: readonly Message[];
  onOpenChild?: (sessionId: string) => void;
  onStopChild?: (sessionId: string) => void;
}

const EMPTY_VALUE: ConductorTranscriptContextValue = {
  enabled: false,
  children: [],
  reportsByRunId: {},
  messages: [],
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
