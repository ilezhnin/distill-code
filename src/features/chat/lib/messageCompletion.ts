import type { Message } from "@/shared/types/messages";

export function completeAssistantMessage(message: Message): Message {
  if (
    message.role !== "assistant" ||
    message.metadata?.completionStatus !== "inProgress"
  ) {
    return message;
  }

  return {
    ...message,
    metadata: {
      ...message.metadata,
      completionStatus: "completed",
    },
  };
}

/**
 * A tool call still waiting or running once its run is over will never
 * finish: the run was stopped, failed, or died with the app under it, and
 * nothing is left to send the update that would close the call. Left alone it
 * renders as running for good, its elapsed time counting from a start that may
 * be hours old. A call that does get a late result is still closed by it; the
 * update finds its request by id and overwrites this status.
 *
 * Only for a run that is over. A message is also completed mid-run, when a
 * steer splits the reply, and the calls in it are still live then.
 */
export function settleAbandonedToolCalls(message: Message): Message {
  const answered = new Set<string>();
  for (const block of message.content) {
    if (block.type === "toolResponse") answered.add(block.id);
  }
  let settled = false;
  const content = message.content.map((block) => {
    if (
      block.type !== "toolRequest" ||
      (block.status !== "pending" && block.status !== "in_progress") ||
      answered.has(block.id)
    ) {
      return block;
    }
    settled = true;
    return { ...block, status: "stopped" as const };
  });
  return settled ? { ...message, content } : message;
}
