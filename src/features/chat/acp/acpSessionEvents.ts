import type { CompactionUpdate, SessionUpdate } from "@agentclientprotocol/sdk";
import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { ensureReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { getReplayCreated } from "@/shared/api/acpReplayMetadata";
import { isRecord } from "@/shared/lib/isRecord";
import type {
  CompactionMeasure,
  Message,
  SystemNotificationContent,
} from "@/shared/types/messages";

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The compaction's measure after one more of its updates: the host writes
 * the context window as the bridge last counted it on every update, so the
 * first one holds the window before and a terminal one the window after.
 */
function measureCompaction(
  previous: CompactionMeasure | undefined,
  status: string,
  usage: unknown,
  at: number | undefined,
): CompactionMeasure | undefined {
  const used = isRecord(usage) ? finite(usage.used) : undefined;
  const size =
    (isRecord(usage) ? finite(usage.size) : undefined) ?? previous?.size;
  const measure: CompactionMeasure =
    status === "in_progress"
      ? {
          ...previous,
          usedBefore: previous?.usedBefore ?? used,
          startedAt: previous?.startedAt ?? at,
        }
      : {
          ...previous,
          usedAfter: used ?? previous?.usedAfter,
          // A bridge may end a compaction twice, the second time with its
          // facts: the first end is when it ended.
          endedAt: previous?.endedAt ?? at,
        };
  if (size !== undefined) measure.size = size;
  return Object.values(measure).some((value) => value !== undefined)
    ? measure
    : undefined;
}

/** Compaction is a timeline entity, never a prompt completion or queue signal. */
export function handleSessionEvent(
  sessionId: string,
  update: SessionUpdate,
  isReplay: boolean,
): boolean {
  if (update.sessionUpdate === "notice") {
    if (!isReplay) {
      const show =
        update.severity === "error"
          ? toast.error
          : update.severity === "warning"
            ? toast.warning
            : toast.info;
      show(update.title, { description: update.description ?? undefined });
    }
    return true;
  }
  if (
    update.sessionUpdate !== "compaction_update" &&
    update.sessionUpdate !== "compaction_summary_chunk"
  )
    return false;

  const store = useChatStore.getState();
  const messages = isReplay
    ? ensureReplayBuffer(sessionId)
    : (store.messagesBySession[sessionId] ?? []);
  const id = `acp-compaction:${update.compactionId}`;
  const existing = messages.find((message) => message.id === id);
  const recorded = existing?.content.find(
    (content): content is SystemNotificationContent =>
      content.type === "systemNotification",
  );
  const previous = recorded?.compaction;
  let measure = recorded?.compactionMeasure;
  let compaction: CompactionUpdate;
  if (update.sessionUpdate === "compaction_summary_chunk") {
    if (previous?.status !== "in_progress") return true;
    const summary = [...(previous.summary ?? [])];
    const last = summary.at(-1);
    if (
      last?.type === "text" &&
      update.content.type === "text" &&
      JSON.stringify(last.annotations) ===
        JSON.stringify(update.content.annotations)
    ) {
      summary[summary.length - 1] = {
        ...last,
        text: last.text + update.content.text,
      };
    } else {
      summary.push(update.content);
    }
    compaction = { ...previous, summary };
  } else {
    const { sessionUpdate: _, ...patch } = update;
    const host = patch._meta?.distill;
    measure = measureCompaction(
      measure,
      update.status,
      isRecord(host) ? host.contextUsage : undefined,
      // A replayed update without the host's stamp has no time of its own.
      getReplayCreated(update) ?? (isReplay ? undefined : Date.now()),
    );
    if (isRecord(host) && isRecord(host.compactionMetaPatch)) {
      const original = host.compactionMetaPatch;
      if (original.value === null || isRecord(original.value))
        patch._meta = original.value;
      else delete patch._meta;
    }
    compaction = { ...previous, ...patch };
  }
  const message: Message = {
    ...(existing ?? {
      id,
      role: "assistant",
      created: getReplayCreated(update) ?? Date.now(),
    }),
    content: [
      {
        type: "systemNotification",
        notificationType: "compaction",
        text: "",
        compaction,
        ...(measure ? { compactionMeasure: measure } : {}),
      },
    ],
  };
  if (isReplay) {
    if (existing) messages[messages.indexOf(existing)] = message;
    else messages.push(message);
  } else if (existing) {
    store.updateMessage(sessionId, id, () => message);
  } else {
    store.addMessage(sessionId, message);
  }
  return true;
}
