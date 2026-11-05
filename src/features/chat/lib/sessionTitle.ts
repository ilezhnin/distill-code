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

/**
 * A request too long for a name is named by its first sentence when that
 * says enough on its own, and is otherwise cut between words and marked as
 * cut. A cut never ends on the comma or colon it fell after: an agent started
 * from "Do X. Read a, b, c" was named "Do X. Read a," and its sisters
 * "Do X. Read a, 2", which reads as a broken name rather than a short one.
 */
function clipTitle(text: string): string {
  if (text.length <= MAX_DRAFT_TITLE_LENGTH) {
    return text;
  }
  const sentence = firstSentence(text);
  if (sentence) {
    return sentence;
  }
  const slice = text.slice(0, MAX_DRAFT_TITLE_LENGTH);
  const lastSpace = slice.lastIndexOf(" ");
  const cut =
    lastSpace >= MIN_WORD_BREAK_LENGTH ? slice.slice(0, lastSpace) : slice;
  const kept = cut.replace(DANGLING_TAIL, "");
  return `${kept || cut.trimEnd()}…`;
}

/** Punctuation a cut may leave hanging at its end. */
const DANGLING_TAIL = /[\s,;:\-–—/\\([{«"']+$/u;

/**
 * The text's first sentence without its full stop, if it has at least a few
 * words and fits a name. A sentence ends at `.`, `!` or `?` followed by a
 * space and a capital or a digit, so `index.md, …` or `e.g. the` do not end
 * one.
 */
function firstSentence(text: string): string | null {
  const end = /[.!?](?=\s+[\p{Lu}\p{N}])/u.exec(text);
  if (!end || end.index + 1 > MAX_DRAFT_TITLE_LENGTH) {
    return null;
  }
  const sentence = text
    .slice(0, end.index + 1)
    .replace(/\.$/, "")
    .trim();
  return sentence.split(" ").length >= MIN_LAST_LINE_WORDS ? sentence : null;
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
