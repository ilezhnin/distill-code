import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

/** Persisted by the host before an owned session can produce output. */
export interface ExecutionOwner {
  kind: "benchmark" | "task";
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
    if (
      session &&
      (session.executionOwner?.id !== owner.id ||
        session.executionOwner.kind !== owner.kind)
    ) {
      store.patchSession(sessionId, { executionOwner: owner });
    }
  }
  return owner;
}

export function parseExecutionOwner(value: unknown): ExecutionOwner | null {
  if (!value || typeof value !== "object") return null;
  const owner = value as Record<string, unknown>;
  return (owner.kind === "benchmark" || owner.kind === "task") &&
    typeof owner.id === "string" &&
    owner.id
    ? { kind: owner.kind, id: owner.id }
    : null;
}

export function isBenchmarkSession(
  sessionId: string | null | undefined,
): boolean {
  return Boolean(
    sessionId &&
      (observedOwners.has(sessionId) ||
        useChatSessionStore.getState().getSession(sessionId)?.executionOwner),
  );
}

/** Both owned profiles exclude ordinary memory and autonomous wave scanners. */
export const isProtectedExecutionSession = isBenchmarkSession;
/** Research rows have a separate benchmark ledger; application tasks do not. */
export function isBenchmarkExecutionSession(sessionId: string): boolean {
  const owner =
    observedOwners.get(sessionId) ??
    useChatSessionStore.getState().getSession(sessionId)?.executionOwner;
  return owner?.kind === "benchmark";
}

export function taskBindingId(sessionId: string): string | null {
  const owner =
    observedOwners.get(sessionId) ??
    useChatSessionStore.getState().getSession(sessionId)?.executionOwner;
  return owner?.kind === "task" && owner.id.startsWith("task:")
    ? owner.id.slice(5)
    : null;
}
