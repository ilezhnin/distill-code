import { invoke } from "@tauri-apps/api/core";
import { useChatSessionStore, type ChatSession } from "./chatSessionStore";
import type { QueuedMessagePayload, QueuedMessageRecord } from "./chatStore";
import {
  isAdmittedQueuedMessagePayload,
  personaIntentFromComposer,
  type PersonaIntent,
} from "../lib/admittedSend";
import type { DeferredWorkspaceSend } from "../lib/firstWorkspaceSend";
import {
  normalizeSessionRunSettings,
  type SessionRunSettings,
} from "../lib/sessionRunSettings";
import { splitLegacyFoldedModelId } from "@/shared/lib/foldedModelId";

const QUEUES_STORAGE_KEY = "distill:chat-message-queues:v1";
let nativeWriteChain = Promise.resolve();
const pendingNativeUpdates = new Map<string, QueuedMessageRecord[] | null>();

type PersistedQueues = Record<string, QueuedMessageRecord[]>;

function isQueuedRecord(value: unknown): value is QueuedMessageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    (record.kind !== "transport-ready" && record.kind !== "deferred") ||
    typeof record.recordId !== "string" ||
    !record.recordId
  ) {
    return false;
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return false;
  if (typeof (payload as Record<string, unknown>).text !== "string") {
    return false;
  }
  if (record.kind === "deferred") {
    const state = record.state;
    if (!state || typeof state !== "object") return false;
    return (
      (state as Record<string, unknown>).type === "workspace-first-send" &&
      ["choice", "naming", "creating", "held", "failed"].includes(
        String((state as Record<string, unknown>).status),
      )
    );
  }
  return true;
}

function normalizeQueuedRecord(
  record: QueuedMessageRecord,
): QueuedMessageRecord | null {
  const { editing: _editing, restored: _restored, ...persisted } = record;
  const normalizedPayload = normalizeQueuedPayload(persisted.payload);
  const restoredPayload =
    normalizedPayload.showInComposer === false
      ? { ...normalizedPayload, showInComposer: true }
      : normalizedPayload;
  if (persisted.kind !== "deferred") {
    if (!isAdmittedQueuedMessagePayload(restoredPayload)) return null;
    return { ...persisted, payload: restoredPayload, restored: true };
  }
  const state = persisted.state as Partial<DeferredWorkspaceSend> | undefined;
  if (state?.type !== "workspace-first-send") {
    return persisted;
  }
  if (state.status === "creating") {
    return {
      ...persisted,
      payload: restoredPayload,
      state: {
        ...state,
        status: "held",
        error: "Workspace setup was interrupted. Review the plan and retry.",
      },
      restored: true,
    };
  }
  return {
    ...persisted,
    payload: restoredPayload,
    restored: true,
  };
}

function normalizeQueuedPayload(
  payload: QueuedMessagePayload,
): QueuedMessagePayload {
  const legacy = payload as QueuedMessagePayload & {
    providerId?: unknown;
    modelId?: unknown;
    executionTarget?: unknown;
    persona?: unknown;
    personaId?: unknown;
    personaName?: unknown;
  };
  const {
    providerId: legacyProviderId,
    modelId: legacyModelId,
    executionTarget: rawTarget,
    persona: rawPersona,
    personaId: legacyPersonaId,
    personaName: legacyPersonaName,
    runSettings: rawRunSettings,
    ...rest
  } = legacy;
  const runSettings =
    parseQueuedRunSettings(rawRunSettings) ??
    legacyFoldedRunSettings(rawTarget, legacyModelId);

  let persona: PersonaIntent;
  if (rawPersona !== undefined) {
    if (!rawPersona || typeof rawPersona !== "object") {
      throw new Error("Invalid persisted queue persona intent.");
    }
    const candidate = rawPersona as Record<string, unknown>;
    if (candidate.kind === "inherit" || candidate.kind === "none") {
      persona = { kind: candidate.kind };
    } else if (
      candidate.kind === "persona" &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0 &&
      (candidate.name === undefined || typeof candidate.name === "string")
    ) {
      persona = {
        kind: "persona",
        id: candidate.id,
        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      };
    } else {
      throw new Error("Invalid persisted queue persona intent.");
    }
  } else if (
    legacyPersonaId === undefined ||
    legacyPersonaId === null ||
    typeof legacyPersonaId === "string"
  ) {
    persona = personaIntentFromComposer(
      legacyPersonaId,
      typeof legacyPersonaName === "string" ? legacyPersonaName : undefined,
    );
  } else {
    throw new Error("Invalid legacy queue persona intent.");
  }

  return {
    ...rest,
    persona,
    ...(runSettings ? { runSettings } : {}),
  };
}

/**
 * The run settings a record was queued under. A malformed value is dropped
 * rather than rejecting the message: dispatch does not act on it yet, so losing
 * it costs nothing, while losing the prompt would.
 */
function parseQueuedRunSettings(
  value: unknown,
): SessionRunSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return normalizeSessionRunSettings({
    ...(typeof raw.effort === "string" ? { effort: raw.effort } : {}),
    ...(typeof raw.fast === "boolean" ? { fast: raw.fast } : {}),
  });
}

/**
 * A record written before effort was its own selection named its model with
 * the effort folded in (`gpt-5.6-sol[low]`). The target itself is not kept —
 * dispatch leases the session's live one — but the effort is what the message
 * was queued under, so it survives as the record's run settings.
 */
function legacyFoldedRunSettings(
  rawTarget: unknown,
  legacyModelId: unknown,
): SessionRunSettings | undefined {
  const targetModelId =
    rawTarget && typeof rawTarget === "object"
      ? (rawTarget as Record<string, unknown>).modelId
      : undefined;
  let modelId: string | undefined;
  if (typeof targetModelId === "string") modelId = targetModelId;
  else if (typeof legacyModelId === "string") modelId = legacyModelId;
  const folded = splitLegacyFoldedModelId(modelId);
  return folded ? { effort: folded.effort } : undefined;
}

/**
 * Records the chat's run settings on a message as it is queued.
 *
 * Whether a queued message keeps the effort and fast mode it was queued under,
 * or runs at whatever the chat is set to when it is dispatched, is not decided
 * (LAWS/CHAT.md is silent). Dispatch keeps reading them at dispatch; the record
 * only carries them, so choosing the other way later finds them already on
 * every queued message.
 */
export function withQueuedRunSettings<T extends QueuedMessagePayload>(
  sessionId: string,
  payload: T,
): T {
  const runSettings = normalizeSessionRunSettings(
    useChatSessionStore.getState().getSession(sessionId)?.desiredRunSettings,
  );
  return {
    ...payload,
    executorRequestKey:
      payload.executorRequestKey ?? `chat:${crypto.randomUUID()}`,
    ...(!payload.runSettings && runSettings ? { runSettings } : {}),
  };
}

export async function loadPersistedMessageQueues(): Promise<PersistedQueues> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    return loadCachedMessageQueues();
  }
  // Missing native data is an empty queue. Keep any legacy browser copy as
  // recovery data, but never turn potentially completed sends into new turns.
  // Read failures propagate so hydration cannot overwrite an unreadable file.
  const stored = await invoke<string | null>("load_message_queues");
  if (stored == null) {
    try {
      const legacy = window.localStorage.getItem(QUEUES_STORAGE_KEY);
      if (legacy)
        window.localStorage.setItem(`${QUEUES_STORAGE_KEY}:recovery`, legacy);
    } catch {
      /* The original cache is left intact when recovery storage is unavailable. */
    }
    return {};
  }
  const queues = parseMessageQueues(stored);
  for (const [id, records] of Object.entries(queues)) {
    const draft = (
      records[0] as QueuedMessageRecord & { draftSession?: ChatSession }
    ).draftSession;
    if (
      !draft ||
      draft.id !== id ||
      typeof draft.title !== "string" ||
      typeof draft.createdAt !== "string" ||
      typeof draft.updatedAt !== "string" ||
      !["pending", "failed"].includes(draft.creationState ?? "") ||
      useChatSessionStore.getState().getSession(id)
    )
      continue;
    useChatSessionStore.getState().addSession({
      ...draft,
      creationState: "failed",
      creationError:
        "Chat creation was interrupted. Your queued message was preserved; retry creation to continue.",
    });
  }
  try {
    const cached = window.localStorage.getItem(QUEUES_STORAGE_KEY);
    if (cached && cached !== stored) {
      window.localStorage.setItem(`${QUEUES_STORAGE_KEY}:recovery`, cached);
    }
    window.localStorage.setItem(QUEUES_STORAGE_KEY, stored);
  } catch {
    // Native persistence remains authoritative for oversized queues.
  }
  return queues;
}

function parseMessageQueues(stored: string): PersistedQueues {
  const parsed: unknown = JSON.parse(stored);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([sessionId, value]) => {
      if (!Array.isArray(value)) return [];
      const records = value.filter(isQueuedRecord).flatMap((record) => {
        try {
          const normalized = normalizeQueuedRecord(record);
          return normalized ? [normalized] : [];
        } catch {
          return [];
        }
      });
      return records.length > 0 ? [[sessionId, records]] : [];
    }),
  );
}

export function loadCachedMessageQueues(): PersistedQueues {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(QUEUES_STORAGE_KEY);
    return stored ? parseMessageQueues(stored) : {};
  } catch {
    return {};
  }
}

// A draft needs its local session metadata alongside its queue. It is restored
// as failed, requiring the operator to retry creation before anything can send.
function persistableRecords(
  sessionId: string,
  records: QueuedMessageRecord[] | undefined,
) {
  if (!records?.length) return null;
  const session = useChatSessionStore.getState().getSession(sessionId);
  return records.map((record) => {
    const { draftSession: _old, ...current } = record as QueuedMessageRecord & {
      draftSession?: ChatSession;
    };
    return session?.creationState
      ? { ...current, draftSession: session }
      : current;
  });
}

export function persistMessageQueues(
  queues: PersistedQueues,
  changedSessionIds: string[],
): void {
  if (typeof window === "undefined" || changedSessionIds.length === 0) return;
  const updates = Object.fromEntries(
    changedSessionIds.map((sessionId) => [
      sessionId,
      persistableRecords(sessionId, queues[sessionId]),
    ]),
  );
  if (window.__TAURI_INTERNALS__) {
    for (const [id, records] of Object.entries(updates))
      pendingNativeUpdates.set(id, records);
    void flushMessageQueues().catch((error: unknown) => {
      console.error("Failed to persist message queues:", error);
    });
  }
  refreshCachedMessageQueues(updates);
}

/** Retry retained writes and report failures to the close barrier. */
export function flushMessageQueues(): Promise<void> {
  nativeWriteChain = nativeWriteChain
    .catch(() => {})
    .then(async () => {
      const updates = Object.fromEntries(pendingNativeUpdates);
      if (Object.keys(updates).length === 0) return;
      await invoke<void>("persist_message_queue_updates", {
        serializedUpdates: JSON.stringify(updates),
      });
      for (const [id, records] of Object.entries(updates)) {
        if (pendingNativeUpdates.get(id) === records)
          pendingNativeUpdates.delete(id);
      }
    });
  return nativeWriteChain;
}

export function refreshCachedMessageQueues(
  updates: Record<string, QueuedMessageRecord[] | null>,
): void {
  if (typeof window === "undefined") return;
  try {
    const cached = loadCachedMessageQueues();
    for (const [sessionId, records] of Object.entries(updates)) {
      if (records?.length) cached[sessionId] = records;
      else delete cached[sessionId];
    }
    const serialized = Object.keys(cached).length
      ? JSON.stringify(cached)
      : null;
    if (serialized) window.localStorage.setItem(QUEUES_STORAGE_KEY, serialized);
    else window.localStorage.removeItem(QUEUES_STORAGE_KEY);
  } catch {
    // The native file remains authoritative when localStorage is unavailable
    // or the queue contains inline image data that exceeds its quota.
  }
}
