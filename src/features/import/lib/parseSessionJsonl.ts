/**
 * Reading the two CLI session formats: Codex rollouts and Claude Code sessions.
 *
 * Both are append-only JSONL and neither is a documented format, so both are
 * read the same way: line by line, ignoring every line that does not look like
 * something a person said or an agent answered. A line the reader does not
 * understand is a line the file gained in a version we have not seen — it must
 * cost nothing.
 *
 * Tool calls and their results are deliberately dropped. They are most of the
 * bytes in these files (a Codex rollout runs to hundreds of megabytes for this
 * reason) and none of the value on the way into a chat history: what the
 * operator wants back is the conversation, not the shell output.
 *
 * Pure and total.
 */

import {
  hasContent,
  titleFrom,
  toEpochMs,
  type ImportedMessage,
  type ImportedRole,
  type ImportedTranscript,
  type ImportSource,
} from "./importedTranscript";

function readLines(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A truncated last line is normal in an append-only file that was
      // still being written when it was copied.
    }
  }
  return rows;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const typed = part as { type?: unknown; text?: unknown };
        return (typed.type === "text" || typed.type === "input_text") &&
          typeof typed.text === "string"
          ? typed.text
          : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") {
    const typed = value as { text?: unknown; content?: unknown };
    if (typeof typed.text === "string") return typed.text.trim();
    if (typed.content !== undefined) return stringifyContent(typed.content);
  }
  return "";
}

/** Codex writes `{"type": "...", "item": {...}}`; a meta line opens the file. */
function codexMessage(row: unknown): ImportedMessage | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as { type?: unknown; item?: unknown };
  const role: ImportedRole | null =
    raw.type === "user_message"
      ? "user"
      : raw.type === "assistant_message"
        ? "assistant"
        : null;
  if (!role) return null;
  const item = (raw.item ?? {}) as {
    content?: unknown;
    text?: unknown;
    timestamp?: unknown;
  };
  const text = stringifyContent(item.content ?? item.text);
  if (!text) return null;
  return { role, text, createdAt: toEpochMs(item.timestamp) };
}

function codexMeta(rows: readonly unknown[]): {
  sessionId: string;
  timestamp: number | null;
  cwd?: string;
} {
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const raw = row as { type?: unknown; item?: unknown };
    if (raw.type !== "session_meta") continue;
    const item = (raw.item ?? {}) as {
      session_id?: unknown;
      id?: unknown;
      timestamp?: unknown;
      cwd?: unknown;
    };
    const sessionId =
      (typeof item.session_id === "string" && item.session_id) ||
      (typeof item.id === "string" && item.id) ||
      "";
    return {
      sessionId,
      timestamp: toEpochMs(item.timestamp),
      ...(typeof item.cwd === "string" && item.cwd ? { cwd: item.cwd } : {}),
    };
  }
  return { sessionId: "", timestamp: null };
}

/** Claude Code writes one object per turn with `type` and a `message` payload. */
function claudeCodeMessage(row: unknown): ImportedMessage | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as {
    type?: unknown;
    message?: unknown;
    text?: unknown;
    timestamp?: unknown;
    isMeta?: unknown;
  };
  if (raw.isMeta === true) return null;
  const role: ImportedRole | null =
    raw.type === "user" || raw.type === "human"
      ? "user"
      : raw.type === "assistant"
        ? "assistant"
        : null;
  if (!role) return null;
  const payload = (raw.message ?? {}) as { content?: unknown };
  const text = stringifyContent(payload.content ?? raw.text);
  if (!text) return null;
  return { role, text, createdAt: toEpochMs(raw.timestamp) };
}

/**
 * Reads one session file.
 *
 * `fallbackId` is the file's own name: both formats can be missing the id
 * their own tooling would use, and a transcript with no stable id cannot be
 * recognised on a second import.
 */
export function parseSessionJsonl(
  source: Extract<ImportSource, "codex" | "claude-code">,
  text: string,
  fallbackId: string,
): ImportedTranscript | null {
  const rows = readLines(text);
  if (rows.length === 0) return null;

  const read = source === "codex" ? codexMessage : claudeCodeMessage;
  const messages = rows
    .map(read)
    .filter((message): message is ImportedMessage => message !== null);

  const meta =
    source === "codex" ? codexMeta(rows) : { sessionId: "", timestamp: null };
  const createdAt =
    meta.timestamp ??
    messages.find((message) => message.createdAt !== null)?.createdAt ??
    null;
  const updatedAt =
    [...messages].reverse().find((message) => message.createdAt !== null)
      ?.createdAt ?? createdAt;

  const transcript: ImportedTranscript = {
    sourceId: meta.sessionId || fallbackId,
    source,
    title: titleFrom(undefined, messages),
    createdAt,
    updatedAt,
    ...("cwd" in meta && meta.cwd ? { cwd: meta.cwd } : {}),
    messages,
  };
  return hasContent(transcript) ? transcript : null;
}

/**
 * Which CLI wrote this file.
 *
 * Codex announces itself with a `session_meta` line and wraps every event in
 * `item`; Claude Code names its turns `user`/`assistant` and carries a
 * `message` payload. A file matching neither is left for the caller to reject
 * rather than guessed at.
 */
export function detectSessionSource(
  text: string,
): "codex" | "claude-code" | null {
  const rows = readLines(text.split("\n").slice(0, 40).join("\n"));
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const raw = row as { type?: unknown; item?: unknown; message?: unknown };
    if (raw.type === "session_meta" || raw.item !== undefined) return "codex";
    if (
      raw.message !== undefined &&
      (raw.type === "user" || raw.type === "assistant")
    ) {
      return "claude-code";
    }
  }
  return null;
}
