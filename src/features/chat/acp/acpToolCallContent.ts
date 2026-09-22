import {
  getReplayBuffer,
  type getBufferedMessage,
} from "@/features/chat/hooks/replayBuffer";
import type { ImageContent } from "@/shared/types/messages";
import { isRecord } from "@/shared/lib/isRecord";

export function findReplayMessageWithToolCall(
  sessionId: string,
  toolCallId: string,
): ReturnType<typeof getBufferedMessage> {
  const buffer = getReplayBuffer(sessionId);
  if (!buffer) {
    return undefined;
  }
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const message = buffer[index];
    if (
      message.content.some(
        (content) =>
          content.type === "toolRequest" && content.id === toolCallId,
      )
    ) {
      return message;
    }
  }
  return undefined;
}

export function extractToolResultText(update: {
  // biome-ignore lint/suspicious/noExplicitAny: ACP SDK ToolCallContent type is complex
  content?: Array<any> | null;
  rawOutput?: unknown;
}): string {
  if (update.content && update.content.length > 0) {
    const texts: string[] = [];
    for (const item of update.content) {
      if (item.type === "content" && item.content?.type === "text") {
        texts.push(item.content.text);
      }
    }
    if (texts.length) return texts.join("\n");
  }
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return typeof update.rawOutput === "string"
      ? update.rawOutput
      : JSON.stringify(update.rawOutput);
  }
  return "";
}

export function extractToolResultImages(update: {
  // biome-ignore lint/suspicious/noExplicitAny: ACP SDK ToolCallContent type is complex
  content?: Array<any> | null;
}): ImageContent[] {
  if (!update.content || update.content.length === 0) {
    return [];
  }
  const images: ImageContent[] = [];
  for (const item of update.content) {
    // ACP tool results wrap each block as { type: "content", content: <ContentBlock> }.
    // An image-producing MCP (e.g. imagegenerator) emits an image ContentBlock here;
    // pull it out so it renders inline instead of being dropped (text-only before).
    if (item?.type === "content" && item.content?.type === "image") {
      const { data, mimeType, uri, annotations } = item.content;
      images.push({
        type: "image",
        data,
        mimeType,
        ...(uri !== undefined ? { uri } : {}),
        ...(annotations !== undefined ? { annotations } : {}),
      });
    }
  }
  return images;
}

export function extractToolStructuredContent(update: {
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
}): unknown | undefined {
  if (Object.hasOwn(update, "rawOutput")) {
    return update.rawOutput;
  }

  const exit = update._meta?.terminal_exit;
  if (isRecord(exit)) return { ...exit };

  return undefined;
}
