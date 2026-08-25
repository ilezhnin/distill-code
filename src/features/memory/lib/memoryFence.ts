/**
 * The `distill-memory` fence: how an agent keeps something across sessions.
 *
 * Same channel as `distill-todo`, for the same reason — it is the only one
 * that works identically on goose and on the Claude, Grok and Codex bridges,
 * and a memory that only forms under one backend is a memory the operator
 * cannot rely on.
 *
 * Pure. Applying a fence is the store's job.
 */

import type { MemoryScope } from "./memoryEntry";
import { normalizeMemoryText } from "./memoryEntry";

export const MEMORY_FENCE_TAG = "distill-memory";

const MEMORY_FENCE_PATTERN = /```distill-memory\s*([\s\S]*?)```/gi;

export interface MemoryFenceRemember {
  text: string;
  scope: MemoryScope;
}

export interface MemoryFenceRequest {
  remember: MemoryFenceRemember[];
  /** Statements to drop, matched the way a person reads them. */
  forget: string[];
}

/**
 * How many memories one turn may add.
 *
 * Not a storage bound — that is the store's — but a bound on enthusiasm: a
 * model that decides to "remember the whole conversation" would otherwise
 * fill the operator's list in a single reply, and every later prompt pays
 * for it. Extras are cut, and the store still holds the real cap.
 */
export const MAX_REMEMBER_PER_TURN = 5;

function parseScope(value: unknown): MemoryScope {
  // Project scope is the default on purpose: a fact learned inside a piece of
  // work is about that work until someone says otherwise, and a wrong global
  // memory follows the operator into every unrelated chat.
  return value === "global" ? "global" : "project";
}

function parseRemember(value: unknown): MemoryFenceRemember | null {
  if (typeof value === "string") {
    const text = normalizeMemoryText(value);
    return text ? { text, scope: "project" } : null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const source = typeof raw.text === "string" ? raw.text : "";
  const text = normalizeMemoryText(source);
  if (!text) return null;
  return { text, scope: parseScope(raw.scope) };
}

function parseBody(body: string): MemoryFenceRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const source = Array.isArray(parsed)
    ? { remember: parsed, forget: [] }
    : parsed && typeof parsed === "object"
      ? (parsed as { remember?: unknown; forget?: unknown })
      : null;
  if (!source) return null;
  const remember = Array.isArray(source.remember)
    ? source.remember
        .map(parseRemember)
        .filter((entry): entry is MemoryFenceRemember => entry !== null)
    : [];
  const forget = Array.isArray(source.forget)
    ? source.forget
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeMemoryText)
        .filter(Boolean)
    : [];
  if (remember.length === 0 && forget.length === 0) return null;
  return { remember, forget };
}

/** Every `distill-memory` block in one message, merged and bounded. */
export function parseMemoryFences(text: string): MemoryFenceRequest | null {
  if (!text.includes(MEMORY_FENCE_TAG)) return null;
  const remember: MemoryFenceRemember[] = [];
  const forget: string[] = [];
  MEMORY_FENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MEMORY_FENCE_PATTERN)) {
    const parsed = match[1] ? parseBody(match[1]) : null;
    if (!parsed) continue;
    remember.push(...parsed.remember);
    forget.push(...parsed.forget);
  }
  if (remember.length === 0 && forget.length === 0) return null;
  return { remember: remember.slice(0, MAX_REMEMBER_PER_TURN), forget };
}

export const MEMORY_PROTOCOL_PROMPT = `<memory-protocol>
Anything you want to still know in a later session must be written down here — the conversation itself does not carry over. Keep something by ending your reply with a fenced block:

\`\`\`${MEMORY_FENCE_TAG}
{"remember": [{"text": "The release branch is release/2026.9", "scope": "project"}], "forget": ["The release branch is release/2026.8"]}
\`\`\`

"scope" is "project" (this project only, the default) or "global" (everywhere). "forget" quotes a remembered line to drop it; correcting a fact means forgetting the old line and remembering the new one in the same block.

Remember standing facts and decisions — how this project is built, what the operator has settled, what surprised you and would surprise you again. Never remember what is already in the files, what you can look up, or what was only true for this one turn. At most ${MAX_REMEMBER_PER_TURN} per reply, one short sentence each: everything here is re-read on every future turn, so a memory that is not worth that cost is not worth keeping.
</memory-protocol>`;
