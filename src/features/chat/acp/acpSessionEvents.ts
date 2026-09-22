import type { CompactionUpdate, SessionUpdate } from "@agentclientprotocol/sdk";
import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { ensureReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { getReplayCreated } from "@/shared/api/acpReplayMetadata";
import { isRecord } from "@/shared/lib/isRecord";
import type {
  Message,
  SystemNotificationContent,
} from "@/shared/types/messages";

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
  const previous = existing?.content.find(
    (content): content is SystemNotificationContent =>
      content.type === "systemNotification",
  )?.compaction;
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
