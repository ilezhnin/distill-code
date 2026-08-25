/**
 * One shape for every transcript we can read from somewhere else.
 *
 * Four sources today — the ChatGPT/Codex web export, the Claude web export,
 * the Codex CLI's rollout files and Claude Code's session files — and they
 * agree on almost nothing: a tree keyed by node id, a flat array, two flavours
 * of JSONL. Everything downstream (preview, search, turning one into a chat)
 * should see one shape, so the per-source readers are the only code that ever
 * knows the difference.
 *
 * Pure and total: a reader never throws. An export is the operator's only
 * copy of years of conversation, and a parser that dies on the first
 * unexpected field would hand back nothing for a file that is 99% readable.
 * Unreadable conversations are counted and reported, never fatal.
 */

export type ImportSource = "chatgpt" | "claude" | "codex" | "claude-code";

export type ImportedRole = "user" | "assistant" | "system" | "tool";

export interface ImportedMessage {
  role: ImportedRole;
  text: string;
  /** Epoch ms, or null when the source did not record one. */
  createdAt: number | null;
  /** Model that produced an assistant turn, when the source names it. */
  model?: string;
}

export interface ImportedTranscript {
  /** The id the source gave it. Stable, so a re-import can recognise it. */
  sourceId: string;
  source: ImportSource;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  /** Project/folder the source filed it under, when it had one. */
  projectName?: string;
  /** Working directory, for the two CLI sources. */
  cwd?: string;
  messages: ImportedMessage[];
}

export interface ImportedProject {
  sourceId: string;
  source: ImportSource;
  name: string;
  description?: string;
  createdAt: number | null;
  /** Project instructions, where the source has such a thing. */
  instructions?: string;
  /** Files attached to the project, as text where the export carries it. */
  documents: { name: string; text: string }[];
}

export interface ImportResult {
  source: ImportSource;
  transcripts: ImportedTranscript[];
  projects: ImportedProject[];
  /**
   * Conversations the reader could not make sense of.
   *
   * Reported rather than thrown: the operator needs to know the import was
   * not complete, and still wants the part that worked.
   */
  skipped: number;
}

export function emptyResult(source: ImportSource): ImportResult {
  return { source, transcripts: [], projects: [], skipped: 0 };
}

/** Seconds-since-epoch (both web exports) or an ISO string, to epoch ms. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Both web exports write seconds; anything already in ms is left alone.
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** A readable title, falling back to the first thing the operator said. */
export function titleFrom(
  candidate: unknown,
  messages: readonly ImportedMessage[],
): string {
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  const firstUser = messages.find((message) => message.role === "user");
  const text = firstUser?.text.trim() ?? "";
  if (!text) return "Untitled conversation";
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/** True when a transcript carries anything worth importing. */
export function hasContent(transcript: ImportedTranscript): boolean {
  return transcript.messages.some((message) => message.text.trim().length > 0);
}
