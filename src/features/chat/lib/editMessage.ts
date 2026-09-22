import type { QueryClient } from "@tanstack/react-query";
import {
  removeSessionMessagePart,
  updateSessionMessageText,
} from "@/shared/api/acpApi";
import { evictSessionSearchCorpus } from "@/shared/api/sessionSearch";
import {
  findMessagePartSpan,
  isReasoningBlock,
  isShownToUser,
  isToolBlock,
  type MessagePart,
} from "@/shared/types/messageParts";
import {
  isTextContent,
  type Message,
  type MessageContent,
} from "@/shared/types/messages";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";

export type EditableMessageRole = "user" | "assistant";

export type EditableMessage = Message & { role: EditableMessageRole };

/** A block the transcript shows as the agent's work: a tool call or reasoning. */
function isWorkBlock(block: MessageContent): boolean {
  return isToolBlock(block) || isReasoningBlock(block);
}

/** A block that carries editable text: a text block, or reasoning with words. */
function hasEditableText(block: MessageContent): boolean {
  return (
    isTextContent(block) ||
    block.type === "thinking" ||
    block.type === "reasoning"
  );
}

/**
 * The indexes of the blocks an edit of `message` replaces: the text the
 * transcript shows as one piece, which the composer takes over whole.
 *
 * Without a part:
 * - A user message: every text block the user can see. A skill's or persona's
 *   instructions, addressed to the agent alone, are not the user's words.
 * - An agent reply that did work (tool calls, reasoning): its answer — the run
 *   of adjacent text blocks after the last step, which the transcript shows as
 *   the answer bubble below the steps (`buildAgentWorkItems`). The text between
 *   steps stays with the steps. Reasoning and companion blocks (images, apps)
 *   trailing the answer do not hide it; a reply that ended on a step has no
 *   answer and nothing to edit.
 * - An agent reply without work: every text block.
 *
 * With a part (`messageParts.ts`): that step's blocks — a run of text, or of
 * reasoning with words. A tool call has no text to edit.
 */
export function editableTextIndexes(
  message: Message,
  part?: MessagePart,
): number[] {
  if (message.role !== "user" && message.role !== "assistant") {
    return [];
  }
  if (part) {
    if (part.kind === "tool") {
      return [];
    }
    const span = findMessagePartSpan(message, part);
    return (
      span?.indexes.filter((index) => {
        const block = message.content[index];
        return block !== undefined && hasEditableText(block);
      }) ?? []
    );
  }
  const visible = message.content.flatMap((block, index) =>
    isShownToUser(block) ? [{ block, index }] : [],
  );
  const textIndexes = visible.flatMap(({ block, index }) =>
    isTextContent(block) ? [index] : [],
  );
  if (
    message.role === "user" ||
    !visible.some(({ block }) => isWorkBlock(block))
  ) {
    return textIndexes;
  }
  let end = visible.length - 1;
  while (
    end >= 0 &&
    !isTextContent(visible[end]?.block as MessageContent) &&
    !isWorkBlock(visible[end]?.block as MessageContent)
  ) {
    end -= 1;
  }
  while (end >= 0 && isReasoningBlock(visible[end]?.block as MessageContent)) {
    end -= 1;
  }
  if (end < 0 || !isTextContent(visible[end]?.block as MessageContent)) {
    return [];
  }
  let start = end;
  while (
    start > 0 &&
    isTextContent(visible[start - 1]?.block as MessageContent)
  ) {
    start -= 1;
  }
  return visible.slice(start, end + 1).map(({ index }) => index);
}

/**
 * The text an edit of `message` starts from: its editable blocks as the
 * transcript joins them — an agent's answer or step as one piece with a blank
 * line between its blocks (`compactTextContent`), a user message line by line.
 */
export function getEditableText(message: Message, part?: MessagePart): string {
  const texts = editableTextIndexes(message, part).flatMap((index) => {
    const block = message.content[index];
    return block && "text" in block && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  if (message.role === "assistant") {
    return texts
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
  return texts.join("\n");
}

/**
 * A message the pencil applies to: one of the two sides of the conversation,
 * with text to put in the composer. System notices are the renderer's own
 * and never reach the host; a message of images or tool calls alone, or a
 * reply that ended on a step, has no text to edit.
 */
export function isEditableMessage(
  message: Message,
  part?: MessagePart,
): message is EditableMessage {
  return (
    (message.role === "user" || message.role === "assistant") &&
    getEditableText(message, part).trim().length > 0
  );
}

/**
 * `message` with `text` as its editable text (`editableTextIndexes`): the
 * first of those blocks carries it, the others are dropped, and everything
 * else — the other steps, images, tool calls, what the agent alone was told —
 * keeps its place. The same thing the host does to the stored chunks, so the
 * transcript on screen and the one a reload replays agree.
 */
export function replaceMessageText(
  message: Message,
  text: string,
  part?: MessagePart,
): Message {
  const targets = editableTextIndexes(message, part);
  if (targets.length === 0) {
    if (part) {
      return message;
    }
    return {
      ...message,
      content: [...message.content, { type: "text", text }],
    };
  }
  const first = targets[0];
  const dropped = new Set(targets.slice(1));
  const content: MessageContent[] = [];
  message.content.forEach((block, index) => {
    if (index === first) {
      content.push({ ...block, text } as MessageContent);
    } else if (!dropped.has(index)) {
      content.push(block);
    }
  });
  return { ...message, content };
}

/**
 * `message` without the blocks of `part`: a step of the agent's work taken
 * out — a run of text, a run of reasoning, or a tool call with its result.
 * The message itself when it holds no such part.
 */
export function removeMessagePart(
  message: Message,
  part: MessagePart,
): Message {
  const span = findMessagePartSpan(message, part);
  if (!span || span.indexes.length === 0) {
    return message;
  }
  const removed = new Set(span.indexes);
  return {
    ...message,
    content: message.content.filter((_, index) => !removed.has(index)),
  };
}

export interface UpdateTranscriptMessageOptions {
  /** Where the session search corpora are cached, so the edit is searchable. */
  queryClient?: QueryClient;
  /** The step being edited; the whole message (its answer) when absent. */
  part?: MessagePart;
}

/**
 * Rewrite a transcript message's text on the host and, once it is stored,
 * everywhere the renderer shows it: the transcript, the chat's list snippet
 * when the message is the chat's last word, and the cached search corpus.
 *
 * Resolves `false` without touching anything for a message that cannot be
 * edited or an empty text; rejects with the host's error when the host
 * refuses the edit, so the caller can say why.
 */
export async function updateTranscriptMessageText(
  sessionId: string,
  message: Message,
  text: string,
  options: UpdateTranscriptMessageOptions = {},
): Promise<boolean> {
  if (message.role !== "user" && message.role !== "assistant") {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const response = await updateSessionMessageText(
    sessionId,
    message.id,
    message.role,
    trimmed,
    options.part,
  );
  useChatStore
    .getState()
    .updateMessage(sessionId, message.id, (current) =>
      replaceMessageText(current, trimmed, options.part),
    );
  if (response.lastMessage) {
    useChatSessionStore
      .getState()
      .updateSessionSubtitleFromText(sessionId, trimmed);
  }
  if (options.queryClient) {
    evictSessionSearchCorpus(options.queryClient, sessionId);
  }
  return true;
}

export interface RemoveTranscriptMessagePartOptions {
  queryClient?: QueryClient;
}

/**
 * Take a step out of an agent's reply on the host and, once it is gone,
 * everywhere the renderer shows it. When the step held the chat's last text,
 * the list snippet moves to whatever text the chat ends on now.
 *
 * Resolves `false` without touching anything for a message that is not the
 * agent's; rejects with the host's error when the host knows no such step.
 */
export async function removeTranscriptMessagePart(
  sessionId: string,
  message: Message,
  part: MessagePart,
  options: RemoveTranscriptMessagePartOptions = {},
): Promise<boolean> {
  if (message.role !== "assistant") {
    return false;
  }
  const response = await removeSessionMessagePart(
    sessionId,
    message.id,
    message.role,
    part,
  );
  useChatStore
    .getState()
    .updateMessage(sessionId, message.id, (current) =>
      removeMessagePart(current, part),
    );
  if (response.lastMessage && response.snippet) {
    useChatSessionStore
      .getState()
      .updateSessionSubtitleFromText(sessionId, response.snippet);
  }
  if (options.queryClient) {
    evictSessionSearchCorpus(options.queryClient, sessionId);
  }
  return true;
}
