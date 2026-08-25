/**
 * Reading the OpenAI export (`conversations.json` from ChatGPT / Codex web).
 *
 * The awkward part is that a conversation is not a list. It is a tree: a
 * `mapping` of node id → `{ id, message, parent, children }`, because every
 * edit and regeneration forks a new branch. `current_node` names the leaf of
 * the branch that was actually on screen when the operator left, so the
 * transcript worth importing is that leaf walked back to the root — not the
 * mapping in key order, which interleaves abandoned branches into nonsense.
 *
 * Pure and total.
 */

import {
  emptyResult,
  hasContent,
  titleFrom,
  toEpochMs,
  type ImportedMessage,
  type ImportedRole,
  type ImportedTranscript,
  type ImportResult,
} from "./importedTranscript";

interface RawNode {
  id?: unknown;
  message?: unknown;
  parent?: unknown;
}

function roleOf(value: unknown): ImportedRole | null {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "system") return "system";
  if (value === "tool") return "tool";
  return null;
}

/**
 * The text of one message.
 *
 * `content.parts` holds strings for plain text and objects for images and
 * other attachments; the objects have no text to keep, so they are dropped
 * rather than stringified into `[object Object]`.
 */
function textOf(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const raw = content as { parts?: unknown; text?: unknown };
  if (Array.isArray(raw.parts)) {
    return raw.parts
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();
  }
  return typeof raw.text === "string" ? raw.text.trim() : "";
}

function messageFrom(value: unknown): ImportedMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    author?: { role?: unknown };
    content?: unknown;
    create_time?: unknown;
    metadata?: {
      model_slug?: unknown;
      is_visually_hidden_from_conversation?: unknown;
    };
  };
  const role = roleOf(raw.author?.role);
  if (!role) return null;
  // The system turns the export carries are ChatGPT's own scaffolding
  // ("user context" blobs, hidden tool preambles), not anything the operator
  // wrote — importing them would put someone else's prompt in their history.
  if (raw.metadata?.is_visually_hidden_from_conversation === true) return null;
  const text = textOf(raw.content);
  if (!text) return null;
  const model = raw.metadata?.model_slug;
  return {
    role,
    text,
    createdAt: toEpochMs(raw.create_time),
    ...(typeof model === "string" && model ? { model } : {}),
  };
}

/** The branch that was on screen: `current_node` walked back to the root. */
function activeBranch(
  mapping: Record<string, RawNode>,
  currentNode: unknown,
): ImportedMessage[] {
  const ordered: ImportedMessage[] = [];
  const seen = new Set<string>();
  let cursor = typeof currentNode === "string" ? currentNode : null;
  if (!cursor) {
    // No leaf recorded (older exports): fall back to the mapping's own order,
    // which is right for any conversation that was never branched.
    for (const node of Object.values(mapping)) {
      const message = messageFrom(node.message);
      if (message) ordered.push(message);
    }
    return ordered;
  }
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: RawNode | undefined = mapping[cursor];
    if (!node) break;
    const message = messageFrom(node.message);
    if (message) ordered.push(message);
    cursor = typeof node.parent === "string" ? node.parent : null;
  }
  return ordered.reverse();
}

function transcriptFrom(value: unknown): ImportedTranscript | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    id?: unknown;
    conversation_id?: unknown;
    title?: unknown;
    create_time?: unknown;
    update_time?: unknown;
    mapping?: unknown;
    current_node?: unknown;
  };
  if (!raw.mapping || typeof raw.mapping !== "object") return null;
  const messages = activeBranch(
    raw.mapping as Record<string, RawNode>,
    raw.current_node,
  );
  const sourceId =
    (typeof raw.conversation_id === "string" && raw.conversation_id) ||
    (typeof raw.id === "string" && raw.id) ||
    "";
  if (!sourceId) return null;
  return {
    sourceId,
    source: "chatgpt",
    title: titleFrom(raw.title, messages),
    createdAt: toEpochMs(raw.create_time),
    updatedAt: toEpochMs(raw.update_time),
    messages,
  };
}

export function parseChatgptExport(value: unknown): ImportResult {
  const result = emptyResult("chatgpt");
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { conversations?: unknown })?.conversations)
      ? (value as { conversations: unknown[] }).conversations
      : null;
  if (!list) return result;
  for (const entry of list) {
    const transcript = transcriptFrom(entry);
    if (!transcript || !hasContent(transcript)) {
      result.skipped += 1;
      continue;
    }
    result.transcripts.push(transcript);
  }
  return result;
}

/** Cheap shape test, so a dropped file can be routed without asking. */
export function looksLikeChatgptExport(value: unknown): boolean {
  const first = Array.isArray(value) ? value[0] : null;
  return Boolean(
    first && typeof first === "object" && "mapping" in (first as object),
  );
}
