import type { ChatAttachmentDraft } from "@/shared/types/messages";

export const DEFAULT_CHAT_TITLE = "New chat";
const ACP_DEFAULT_CHAT_TITLE = "New Chat";
const MAX_DRAFT_TITLE_LENGTH = 100;
const MIN_LAST_LINE_WORDS = 3;
const MIN_WORD_BREAK_LENGTH = 40;

export function isDefaultChatTitle(title: string): boolean {
  return title === DEFAULT_CHAT_TITLE || title === ACP_DEFAULT_CHAT_TITLE;
}

function attachmentKindLabel(kind: ChatAttachmentDraft["kind"], count: number) {
  switch (kind) {
    case "image":
      return count === 1 ? "image" : "images";
    case "directory":
      return count === 1 ? "folder" : "folders";
    default:
      return count === 1 ? "file" : "files";
  }
}

// The goose ACP backend uses "New Chat" (title case) as its default — normalize to ours.
export function normalizeAcpTitle(
  title: string | null | undefined,
): string | undefined {
  if (!title) return undefined;
  return title === ACP_DEFAULT_CHAT_TITLE ? DEFAULT_CHAT_TITLE : title;
}

/**
 * Immediate list title from the user's first message. The agent host then
 * stores a few-word summary in its place (agent_host/session_title.rs) unless
 * the operator renamed the chat. Prefer the actual request over a long
 * preamble; never treat the first 100 characters of a pasted brief as the name.
 */
export function titleFromUserText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  return clipTitle(preferRequestFromPrompt(text, collapsed));
}

function preferRequestFromPrompt(raw: string, collapsed: string): string {
  const lines = raw
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine && lines.length > 1) {
    const lastCollapsed = lastLine.replace(/\s+/g, " ");
    if (lastCollapsed.split(" ").length >= MIN_LAST_LINE_WORDS) {
      return lastCollapsed;
    }
  }

  const questions = collapsed.match(/[^.!?][^.!?]*\?/g);
  const lastQuestion = questions?.at(-1)?.trim();
  if (lastQuestion && lastQuestion.split(" ").length >= MIN_LAST_LINE_WORDS) {
    return lastQuestion;
  }

  return collapsed;
}

function clipTitle(text: string): string {
  if (text.length <= MAX_DRAFT_TITLE_LENGTH) {
    return text;
  }
  const slice = text.slice(0, MAX_DRAFT_TITLE_LENGTH);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= MIN_WORD_BREAK_LENGTH) {
    return slice.slice(0, lastSpace).trimEnd();
  }
  return slice.trimEnd();
}

export function getSessionTitleFromDraft(
  text: string,
  attachments?: ChatAttachmentDraft[],
): string {
  const fromText = titleFromUserText(text);
  if (fromText) {
    return fromText;
  }

  if (!attachments || attachments.length === 0) {
    return DEFAULT_CHAT_TITLE;
  }

  const firstKind = attachments[0]?.kind;
  const sameKind = attachments.every(
    (attachment) => attachment.kind === firstKind,
  );
  const kindLabel = sameKind
    ? attachmentKindLabel(firstKind, attachments.length)
    : "files";

  return `Attached ${kindLabel}`;
}

export function getDisplaySessionTitle(
  title: string,
  defaultTitle: string,
): string {
  return isDefaultChatTitle(title) ? defaultTitle : title;
}

export function getEditableSessionTitle(
  title: string,
  defaultTitle: string,
): string {
  return getDisplaySessionTitle(title, defaultTitle);
}

export function isSessionTitleUnchanged(
  nextTitle: string,
  currentTitle: string,
  defaultTitle: string,
): boolean {
  return nextTitle === getEditableSessionTitle(currentTitle, defaultTitle);
}
