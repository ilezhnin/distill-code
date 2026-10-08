import { acpGetSessionInfo } from "@/shared/api/acp";
import { acpSessionToChatSession } from "./acpSessionMapping";
import {
  ownedTaskExecution,
  type OwnedTaskRequest,
  type PreparedOwnedTask,
} from "@/features/benchmarks/lib/ownedTaskExecution";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import { createUserMessage } from "@/shared/types/messages";
import type { MessageMetadata } from "@/shared/types/messages";
import { readSessionTranscript } from "@/shared/api/acpApi";
import { flushBufferedStreamingUpdatesForSession } from "../acp/liveStreamingUpdates";
import { taskBindingId } from "./executionOwnership";
import type { SendCoreOptions } from "./sendCore";
import { executorSelection } from "@/features/benchmarks/lib/executorSelection";
import type { ExecutorHostReceipt } from "@/features/benchmarks/lib/executorSelection";
import type { OwnedTaskDispatch } from "@/features/benchmarks/lib/ownedTaskExecution";
import { PreCommitSendRejectedError } from "./preCommitSendRejection";

// Projection hints only: every settlement still verifies fresh native binding/status/receipt.
const canonicalMessages = new WeakSet<object>();
const reconciliations = new Map<
  string,
  { again: boolean; promise: Promise<boolean> }
>();

function verifyOwnedReceipt(
  sessionId: string,
  bindingId: string,
  prepared: PreparedOwnedTask,
  status: OwnedTaskDispatch,
  receipt: ExecutorHostReceipt,
): void {
  const key = prepared.binding.request.requestKey;
  if (
    prepared.binding.id !== bindingId ||
    prepared.session.owned.sessionId !== sessionId ||
    prepared.session.owned.ownerId !== `task:${bindingId}` ||
    status.sessionId !== sessionId ||
    status.requestKey !== key ||
    receipt.start.sessionId !== sessionId ||
    receipt.start.link.decisionKey !== key ||
    receipt.start.link.logicalRunId !== key ||
    receipt.start.hostRunId !== status.runId ||
    receipt.start.messageId !== status.userMessageId
  )
    throw new Error("Native processing receipt differs from this bound task");
}

/** Merge canonical IDs/times/order into current live messages without replacing their content. */
async function mergeOwnedTranscript(
  sessionId: string,
  prepared: PreparedOwnedTask,
  status: OwnedTaskDispatch,
  metadata?: MessageMetadata,
  outcome?: "completed" | "failed" | "cancelled",
) {
  const transcript = await readSessionTranscript(sessionId);
  const rows = new Map(
    transcript.messages.map((message, index) => [
      message.id,
      { message, index },
    ]),
  );
  const canonicalUser = rows.get(status.userMessageId)?.message;
  const created = canonicalUser?.created
    ? Date.parse(canonicalUser.created)
    : Number.NaN;
  if (canonicalUser?.role !== "user" || !Number.isFinite(created))
    throw new Error(
      "The accepted native user message is not available in persisted history",
    );
  flushBufferedStreamingUpdatesForSession(sessionId, { flushSubtitle: true });
  const store = useChatStore.getState();
  const current = store.messagesBySession[sessionId] ?? [];
  const existing = current.find(
    (message) => message.id === status.userMessageId,
  );
  if (existing && existing.role !== "user")
    throw new Error(
      "The accepted native message ID belongs to another visible role",
    );
  const user = existing ?? createUserMessage(prepared.binding.task.prompt);
  const merged = [
    ...current.filter((message) => message.id !== status.userMessageId),
    {
      ...user,
      id: status.userMessageId,
      created,
      metadata: { ...user.metadata, ...metadata },
    },
  ].map((message) => {
    const canonical = rows.get(message.id)?.message;
    if (!canonical || canonical.role !== message.role) return message;
    const nativeCreated = canonical.created
      ? Date.parse(canonical.created)
      : Number.NaN;
    if (!Number.isFinite(nativeCreated))
      throw new Error("Native task history has no canonical message time");
    return {
      ...message,
      created: nativeCreated,
      ...(outcome && message.role === "assistant"
        ? {
            metadata: {
              ...message.metadata,
              completionStatus:
                outcome === "completed"
                  ? ("completed" as const)
                  : outcome === "cancelled"
                    ? ("stopped" as const)
                    : ("error" as const),
            },
          }
        : {}),
    };
  });
  merged.sort((left, right) => {
    const a = rows.get(left.id);
    const b = rows.get(right.id);
    return a && b ? a.index - b.index : left.created - right.created;
  });
  store.setMessages(sessionId, merged);
  for (const message of useChatStore.getState().messagesBySession[sessionId] ??
    [])
    if (rows.get(message.id)?.message.role === message.role)
      canonicalMessages.add(message);
}

async function settleOwnedTask(
  sessionId: string,
  bindingId: string,
  prepared: PreparedOwnedTask,
  status: OwnedTaskDispatch,
) {
  const key = prepared.binding.request.requestKey;
  const record = await executorSelection.get(key);
  const receipt = record?.hostExecution;
  if (!receipt || record.decision.request.requestKey !== key || !receipt.finish)
    throw new Error(
      "Native terminal processing proof is unavailable; inspect this task before retrying",
    );
  verifyOwnedReceipt(sessionId, bindingId, prepared, status, receipt);
  const outcome = status.error
    ? status.error.kind === "cancelled"
      ? "cancelled"
      : "failed"
    : "completed";
  if (status.phase !== "terminal" || receipt.finish.status !== outcome)
    throw new Error(
      "Native terminal status differs from the processing receipt",
    );
  // This idempotent native operation verifies the terminal receipt, session policy and exact key.
  await executorSelection.syncOutcome(key, sessionId, key, outcome);
  const store = useChatStore.getState();
  const messages = store.messagesBySession[sessionId];
  const projected =
    messages?.some(
      (message) =>
        message.id === status.userMessageId && canonicalMessages.has(message),
    ) &&
    messages.every(
      (message) =>
        message.role !== "assistant" ||
        (canonicalMessages.has(message) &&
          message.metadata?.completionStatus ===
            (outcome === "completed"
              ? "completed"
              : outcome === "cancelled"
                ? "stopped"
                : "error")),
    );
  if (messages && !projected && !store.loadingSessionIds.has(sessionId))
    await mergeOwnedTranscript(sessionId, prepared, status, undefined, outcome);
  const latest = useChatStore.getState();
  if (
    latest.sessionStateById[sessionId] ||
    latest.messagesBySession[sessionId]
  ) {
    latest.setError(
      sessionId,
      status.error
        ? (status.error.message ?? status.error.kind ?? "Owned task failed")
        : null,
    );
    latest.setChatState(sessionId, "idle");
    latest.setRunCancellationPending(sessionId, false);
    latest.setPendingAssistantProvider(sessionId, null);
    latest.settleActiveRun(sessionId);
  }
}

/** Existing native metadata/history triggers recover terminal evidence after renderer reload. Never dispatch. */
async function reconcileOwnedTaskSessionOnce(
  sessionId: string,
): Promise<boolean> {
  const bindingId = taskBindingId(sessionId);
  if (!bindingId) return false;
  try {
    const prepared = await ownedTaskExecution.get(bindingId);
    const status = await ownedTaskExecution.status(bindingId);
    if (!status || status.phase !== "terminal") return false;
    await settleOwnedTask(sessionId, bindingId, prepared, status);
    return true;
  } catch (error) {
    const store = useChatStore.getState();
    if (
      store.sessionStateById[sessionId] ||
      store.messagesBySession[sessionId]
    ) {
      store.setError(
        sessionId,
        error instanceof Error ? error.message : String(error),
      );
      store.setRunCancellationPending(sessionId, true);
    }
    console.warn("Owned task reconciliation is unresolved", error);
    return false;
  }
}

export function reconcileOwnedTaskSession(sessionId: string): Promise<boolean> {
  if (!taskBindingId(sessionId)) return Promise.resolve(false);
  const current = reconciliations.get(sessionId);
  if (current) {
    current.again = true;
    return current.promise;
  }
  const entry = { again: false, promise: Promise.resolve(false) };
  const run = async () => {
    let settled = false;
    do {
      entry.again = false;
      settled = await reconcileOwnedTaskSessionOnce(sessionId);
    } while (entry.again);
    return settled;
  };
  entry.promise = run().finally(() => {
    if (reconciliations.get(sessionId) === entry)
      reconciliations.delete(sessionId);
  });
  reconciliations.set(sessionId, entry);
  return entry.promise;
}

export async function attachPreparedOwnedTask(prepared: PreparedOwnedTask) {
  const info = await acpGetSessionInfo(prepared.session.owned.sessionId);
  const session = acpSessionToChatSession(info);
  if (
    session.executionOwner?.kind !== "task" ||
    session.executionOwner.id !== prepared.session.owned.ownerId
  )
    throw new Error("The native session did not acknowledge task ownership");
  useChatSessionStore.getState().addSession(session);
  return session;
}

/** Initial chat and wave children share this native owned dispatch consumer. */
export async function dispatchOwnedTaskInChat(
  sessionId: string,
  text: string,
  options: SendCoreOptions,
) {
  const bindingId = options.ownedTaskBindingId;
  if (!bindingId) throw new Error("Owned task has no native binding");
  if (
    options.attachments?.length ||
    options.assistantPrompt ||
    options.systemPrompt ||
    options.persona
  )
    throw new Error(
      "This explicit owned contract does not accept ordinary tools, attachments or composed role context",
    );
  const prepared = await ownedTaskExecution.get(bindingId);
  if (
    prepared.session.owned.sessionId !== sessionId ||
    prepared.binding.task.prompt !== text
  )
    throw new Error(
      "Owned task text or session differs from the immutable native binding",
    );
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  options.beforeUserMessageCommitted?.();
  const store = useChatStore.getState();
  store.setChatState(sessionId, "thinking");
  store.setError(sessionId, null);
  let dispatched = false;
  let terminal = false;
  let cancellationFailure: Error | null = null;
  const cancel = () => {
    void ownedTaskExecution.cancel(bindingId).catch((error: unknown) => {
      cancellationFailure = new Error(
        `Native cancellation is unresolved: ${error instanceof Error ? error.message : String(error)}`,
      );
      store.setError(sessionId, cancellationFailure.message);
      store.setRunCancellationPending(sessionId, true);
    });
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    dispatched = true;
    let status = await ownedTaskExecution.dispatch(bindingId);
    // A reserved IPC result is not a processed accepted message. Keep the
    // caller's accepted-send lease until the native provider receipt is claimed.
    let receipt = (
      await executorSelection.get(prepared.binding.request.requestKey)
    )?.hostExecution;
    while (!receipt) {
      if (cancellationFailure) throw cancellationFailure;
      if (status.phase === "terminal") {
        terminal = true;
        throw new PreCommitSendRejectedError(
          status.error?.message ??
            "Owned task was refused before native processing",
        );
      }
      if (status.phase === "uncertain")
        throw new Error(
          "Native processing is unknown. Inspect this task before retrying.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await ownedTaskExecution.status(bindingId);
      if (!current) throw new Error("Native task reservation disappeared");
      status = current;
      receipt = (
        await executorSelection.get(prepared.binding.request.requestKey)
      )?.hostExecution;
    }
    verifyOwnedReceipt(sessionId, bindingId, prepared, status, receipt);
    await mergeOwnedTranscript(
      sessionId,
      prepared,
      status,
      options.userMessageMetadata,
    );
    options.onUserMessageCommitted?.();
    store.setChatState(sessionId, "streaming");
    options.onPromptDispatched?.();
    if (options.signal?.aborted) cancel();
    while (status.phase !== "terminal") {
      if (cancellationFailure) throw cancellationFailure;
      if (status.phase === "uncertain")
        throw new Error(
          "Native acceptance is unknown. Inspect this task; it will not be sent again.",
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const current = await ownedTaskExecution.status(bindingId);
      if (!current)
        throw new Error(
          "Native task receipt disappeared. Inspect before retrying.",
        );
      status = current;
    }
    await settleOwnedTask(sessionId, bindingId, prepared, status);
    terminal = true;
    if (status.error)
      throw new Error(
        status.error.message ?? status.error.kind ?? "Owned task failed",
      );
  } catch (error) {
    store.setError(
      sessionId,
      error instanceof Error ? error.message : String(error),
    );
    if (dispatched) store.setRunCancellationPending(sessionId, !terminal);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    store.setChatState(sessionId, "idle");
    store.setPendingAssistantProvider(sessionId, null);
  }
}

export async function startInitialOwnedChatTask(
  request: OwnedTaskRequest,
  onAttached?: (sessionId: string) => void,
) {
  if (request.surface !== "chat" || request.entry || request.waveMode)
    throw new Error("Initial owned chat needs a fresh native entry");
  const prepared = await ownedTaskExecution.prepare(request);
  const session = await attachPreparedOwnedTask(prepared);
  useChatSessionStore.getState().setActiveSession(session.id);
  onAttached?.(session.id);
  const { dispatchPrompt } = await import("./sendCore");
  let accepted!: () => void;
  let refused!: (error: unknown) => void;
  const admission = new Promise<void>((resolve, reject) => {
    accepted = resolve;
    refused = reject;
  });
  void dispatchPrompt(session.id, request.prompt, {
    ownedTaskBindingId: prepared.binding.id,
    executorRequestKey: prepared.binding.request.requestKey,
    onPromptDispatched: accepted,
  }).catch((error) => {
    console.warn("Owned initial task stopped", error);
    refused(error);
  });
  await admission;
  return session.id;
}
