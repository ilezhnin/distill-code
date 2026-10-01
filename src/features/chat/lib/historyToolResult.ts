import { getClient } from "@/shared/api/acpConnection";
import type { ToolResponseContent } from "@/shared/types/messages";
import { useChatStore } from "../stores/chatStore";
import { appendTerminalOutput } from "../acp/acpTerminalOutput";
import {
  extractToolResultText,
  extractToolStructuredContent,
  extractToolResultImages,
  hydrateToolResultImages,
} from "../acp/acpToolCallContent";

const inFlight = new Map<string, Promise<void>>();

export function loadHistoryToolResult(
  ref: NonNullable<ToolResponseContent["historyResult"]>,
): Promise<void> {
  const key = `${ref.sessionId}:${ref.eventId}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const operation = (async () => {
    const event = await (await getClient()).host.sessionHistoryResult(ref);
    const update = event.update;
    if (
      event.sessionId !== ref.sessionId ||
      update.sessionUpdate !== "tool_call_update"
    )
      throw new Error("The saved tool result does not match this chat");
    const images = await hydrateToolResultImages(
      extractToolResultImages(update),
    );
    const store = useChatStore.getState();
    for (const message of store.messagesBySession[ref.sessionId] ?? []) {
      if (
        !message.content.some(
          (content) =>
            content.type === "toolResponse" &&
            content.historyResult?.eventId === ref.eventId,
        )
      )
        continue;
      store.updateMessage(ref.sessionId, message.id, (current) => {
        const hydrated = appendTerminalOutput(current, update);
        const tool = hydrated.content.find(
          (content) =>
            content.type === "toolRequest" && content.id === update.toolCallId,
        );
        return {
          ...hydrated,
          content: [
            ...hydrated.content.map((content) => {
              if (
                content.type !== "toolResponse" ||
                content.historyResult?.eventId !== ref.eventId
              )
                return content;
              const { historyResult: _, ...response } = content;
              return {
                ...response,
                result:
                  extractToolResultText(update) ||
                  (tool?.type === "toolRequest"
                    ? (tool.terminalOutput ?? "")
                    : ""),
                structuredContent: extractToolStructuredContent(update),
              };
            }),
            ...images,
          ],
        };
      });
    }
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, operation);
  return operation;
}

export async function loadHistoryToolResults(sessionId: string): Promise<void> {
  const refs = (
    useChatStore.getState().messagesBySession[sessionId] ?? []
  ).flatMap((message) =>
    message.content.flatMap((content) =>
      content.type === "toolResponse" && content.historyResult
        ? [content.historyResult]
        : [],
    ),
  );
  for (let index = 0; index < refs.length; index += 4)
    await Promise.all(refs.slice(index, index + 4).map(loadHistoryToolResult));
}
