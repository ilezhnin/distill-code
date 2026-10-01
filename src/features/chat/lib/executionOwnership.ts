import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

/** Persisted by the host before an owned session can produce output. */
export interface ExecutionOwner {
  kind: "benchmark";
  id: string;
}

const observedOwners = new Map<string, ExecutionOwner>();

export function observeExecutionOwner(
  sessionId: string,
  value: unknown,
): ExecutionOwner | null {
  const owner = parseExecutionOwner(value);
  if (owner) {
    observedOwners.set(sessionId, owner);
    const store = useChatSessionStore.getState();
    const session = store.getSession(sessionId);
    if (session && session.executionOwner?.id !== owner.id) {
      store.patchSession(sessionId, { executionOwner: owner });
    }
  }
  return owner;
}

export function parseExecutionOwner(value: unknown): ExecutionOwner | null {
  if (!value || typeof value !== "object") return null;
  const owner = value as Record<string, unknown>;
  return owner.kind === "benchmark" && typeof owner.id === "string" && owner.id
    ? { kind: "benchmark", id: owner.id }
    : null;
}

export function isBenchmarkSession(
  sessionId: string | null | undefined,
): boolean {
  return Boolean(
    sessionId &&
      (observedOwners.has(sessionId) ||
        useChatSessionStore.getState().getSession(sessionId)?.executionOwner
          ?.kind === "benchmark"),
  );
}
