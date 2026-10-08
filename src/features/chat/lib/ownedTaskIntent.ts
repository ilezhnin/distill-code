import { z } from "zod";
import type {
  OwnedTaskModeRequest,
  OwnedTaskRequest,
} from "@/features/benchmarks/lib/ownedTaskExecution";

export type PendingOwnedTaskIntent =
  | { kind: "chat"; request: OwnedTaskRequest }
  | { kind: "mode"; request: OwnedTaskModeRequest };
export const MAX_OWNED_TASK_PROMPT_BYTES = 256 * 1024;
export function ownedTaskPromptBytes(prompt: string): number {
  return new TextEncoder().encode(prompt).length;
}
const KEY = "distill.pendingOwnedTaskIntent.v1";
const identifier = z.string().min(1).max(512);
const repository = z
  .object({ path: identifier, commit: identifier, tree: identifier })
  .strict()
  .nullable();
const modeRequest = z
  .object({
    contextId: identifier,
    promotionId: identifier.nullable(),
    acknowledgedCertificateHash: z.string().max(512),
    repository,
  })
  .strict()
  .refine((request) =>
    request.promotionId
      ? Boolean(request.acknowledgedCertificateHash)
      : request.acknowledgedCertificateHash === "" &&
        request.repository === null,
  );
// Read legacy oversized prompts intact so an operator can explicitly edit them.
// New admission enforces the native UTF-8 byte bound before persistence below.
const intentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("chat"),
      request: z
        .object({
          requestKey: identifier,
          surface: z.literal("chat"),
          contextId: identifier,
          promotionId: identifier,
          acknowledgedCertificateHash: identifier,
          prompt: z
            .string()
            .min(1)
            .refine((value) => Boolean(value.trim())),
          hardCandidateKey: identifier.nullable(),
          repository,
          entry: z.null(),
          waveMode: z.null(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("mode"), request: modeRequest }).strict(),
]);
export interface OwnedTaskIntentState {
  intent: PendingOwnedTaskIntent | null;
  error: string | null;
  busy: boolean;
}
let cachedRaw: string | null | undefined;
let cachedState: OwnedTaskIntentState = {
  intent: null,
  error: null,
  busy: false,
};
let activeClaim: symbol | null = null;
const listeners = new Set<() => void>();
const invalid =
  "The saved owned task intent needs inspection before another task";
const changed = "Recover the saved owned task before changing its intent";

export function ownedTaskIntentState(): OwnedTaskIntentState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    if (
      cachedState.error !== invalid ||
      cachedState.busy !== Boolean(activeClaim)
    )
      cachedState = {
        intent: null,
        error: invalid,
        busy: Boolean(activeClaim),
      };
    cachedRaw = undefined;
    return cachedState;
  }
  if (raw !== cachedRaw || cachedState.busy !== Boolean(activeClaim)) {
    try {
      cachedState = {
        intent: raw !== null ? intentSchema.parse(JSON.parse(raw)) : null,
        error: null,
        busy: Boolean(activeClaim),
      };
    } catch {
      cachedState = {
        intent: null,
        error: invalid,
        busy: Boolean(activeClaim),
      };
    }
    cachedRaw = raw;
  }
  return cachedState;
}
const notify = () => {
  for (const listener of listeners) listener();
};
const storageChanged = (event: StorageEvent) => {
  if (event.key === KEY || event.key === null) notify();
};
export function subscribeOwnedTaskIntent(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener("storage", storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", storageChanged);
  };
}
export function pendingOwnedTaskIntent(): PendingOwnedTaskIntent | null {
  const state = ownedTaskIntentState();
  if (state.error) throw new Error(state.error);
  return state.intent;
}
function encode(value: PendingOwnedTaskIntent): string {
  return JSON.stringify(intentSchema.parse(value));
}
export function retainOwnedTaskIntent(value: PendingOwnedTaskIntent): void {
  const existing = pendingOwnedTaskIntent();
  const encoded = encode(value);
  if (existing && encode(existing) !== encoded) throw new Error(changed);
  if (
    value.kind === "chat" &&
    ownedTaskPromptBytes(value.request.prompt) > MAX_OWNED_TASK_PROMPT_BYTES
  )
    throw new Error(
      `Task instructions exceed ${MAX_OWNED_TASK_PROMPT_BYTES} UTF-8 bytes`,
    );
  localStorage.setItem(KEY, encoded);
  notify();
}
/** One renderer operation owns the durable request; sibling launchers can only inspect it. */
export function claimOwnedTaskIntent(
  value: PendingOwnedTaskIntent,
): (() => void) | null {
  if (activeClaim) return null;
  const token = Symbol();
  activeClaim = token;
  try {
    retainOwnedTaskIntent(value);
  } catch (error) {
    activeClaim = null;
    notify();
    throw error;
  }
  notify();
  return () => {
    if (activeClaim === token) {
      activeClaim = null;
      notify();
    }
  };
}
export function releaseOwnedTaskIntent(value: PendingOwnedTaskIntent): void {
  const existing = pendingOwnedTaskIntent();
  if (!existing || encode(existing) !== encode(value))
    throw new Error("The saved task intent changed during recovery");
  localStorage.removeItem(KEY);
  notify();
}
