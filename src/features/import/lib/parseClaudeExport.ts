/**
 * Reading the Claude web export (`conversations.json`, `projects.json`).
 *
 * Flat and friendly next to OpenAI's: a conversation is an array of messages
 * in order, no branch tree. The two things that need care are the message
 * body — older exports put it in `text`, newer ones in a `content` array of
 * blocks — and projects, which carry the operator's own instructions and
 * documents and are the part worth the most on the way in.
 *
 * Pure and total.
 */

import {
  emptyResult,
  hasContent,
  titleFrom,
  toEpochMs,
  type ImportedMessage,
  type ImportedProject,
  type ImportedRole,
  type ImportedTranscript,
  type ImportResult,
} from "./importedTranscript";

function roleOf(value: unknown): ImportedRole | null {
  if (value === "human" || value === "user") return "user";
  if (value === "assistant") return "assistant";
  return null;
}

function textOf(raw: { text?: unknown; content?: unknown }): string {
  if (Array.isArray(raw.content)) {
    const blocks = raw.content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const typed = block as { type?: unknown; text?: unknown };
        return typed.type === "text" && typeof typed.text === "string"
          ? typed.text
          : "";
      })
      .filter(Boolean);
    if (blocks.length > 0) return blocks.join("\n").trim();
  }
  return typeof raw.text === "string" ? raw.text.trim() : "";
}

function messageFrom(value: unknown): ImportedMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    sender?: unknown;
    role?: unknown;
    text?: unknown;
    content?: unknown;
    created_at?: unknown;
  };
  const role = roleOf(raw.sender ?? raw.role);
  if (!role) return null;
  const text = textOf(raw);
  if (!text) return null;
  return { role, text, createdAt: toEpochMs(raw.created_at) };
}

function transcriptFrom(value: unknown): ImportedTranscript | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    uuid?: unknown;
    name?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    chat_messages?: unknown;
    project?: { name?: unknown } | null;
  };
  if (typeof raw.uuid !== "string" || !raw.uuid) return null;
  const messages = Array.isArray(raw.chat_messages)
    ? raw.chat_messages
        .map(messageFrom)
        .filter((message): message is ImportedMessage => message !== null)
    : [];
  const projectName = raw.project?.name;
  return {
    sourceId: raw.uuid,
    source: "claude",
    title: titleFrom(raw.name, messages),
    createdAt: toEpochMs(raw.created_at),
    updatedAt: toEpochMs(raw.updated_at),
    ...(typeof projectName === "string" && projectName ? { projectName } : {}),
    messages,
  };
}

function projectFrom(value: unknown): ImportedProject | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    uuid?: unknown;
    name?: unknown;
    description?: unknown;
    prompt_template?: unknown;
    created_at?: unknown;
    docs?: unknown;
  };
  if (typeof raw.uuid !== "string" || !raw.uuid) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const documents = Array.isArray(raw.docs)
    ? raw.docs.flatMap((doc) => {
        if (!doc || typeof doc !== "object") return [];
        const typed = doc as { filename?: unknown; content?: unknown };
        const docName =
          typeof typed.filename === "string" ? typed.filename.trim() : "";
        const text = typeof typed.content === "string" ? typed.content : "";
        return docName && text ? [{ name: docName, text }] : [];
      })
    : [];
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  const instructions =
    typeof raw.prompt_template === "string" ? raw.prompt_template.trim() : "";
  return {
    sourceId: raw.uuid,
    source: "claude",
    name,
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
    createdAt: toEpochMs(raw.created_at),
    documents,
  };
}

export function parseClaudeExport(args: {
  conversations?: unknown;
  projects?: unknown;
}): ImportResult {
  const result = emptyResult("claude");
  if (Array.isArray(args.conversations)) {
    for (const entry of args.conversations) {
      const transcript = transcriptFrom(entry);
      if (!transcript || !hasContent(transcript)) {
        result.skipped += 1;
        continue;
      }
      result.transcripts.push(transcript);
    }
  }
  if (Array.isArray(args.projects)) {
    for (const entry of args.projects) {
      const project = projectFrom(entry);
      if (project) result.projects.push(project);
    }
  }
  return result;
}

export function looksLikeClaudeExport(value: unknown): boolean {
  const first = Array.isArray(value) ? value[0] : null;
  return Boolean(
    first &&
      typeof first === "object" &&
      ("chat_messages" in (first as object) ||
        ("uuid" in (first as object) && "docs" in (first as object))),
  );
}
