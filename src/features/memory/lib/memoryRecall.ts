/**
 * The `distill-recall` fence: how an agent asks for a memory the prompt did
 * not carry.
 *
 * The `<memory>` block is budgeted and capped, which is right for something
 * repeated on every turn and wrong as the only way to reach the store. What
 * fell out of the block, and what the cap displaced into the archive, is
 * still the operator's and still true — but for the model it does not exist.
 * This is the read channel that closes that hole (LAWS/MEMORY.md, Reading
 * back), on the same fence mechanism the write side already uses, because it
 * is the only one that behaves identically on goose and on the Claude, Grok
 * and Codex bridges.
 *
 * Pure. Searching is `memorySearch`, delivering the answer is
 * `useMemoryRecallSync`.
 */

import { getTextContent, type Message } from "@/shared/types/messages";

import { appliesToProject, type MemoryEntry } from "./memoryEntry";
import type { MemorySearchHit } from "./memorySearch";

export const RECALL_FENCE_TAG = "distill-recall";

/** The tag the answer comes back under. Not a fence: the model reads it. */
export const RECALL_ANSWER_TAG = "memory-recall";

const RECALL_FENCE_PATTERN = /```distill-recall\s*([\s\S]*?)```/gi;

export type MemoryRecallScope = "project" | "global" | "all";

export interface MemoryRecallRequest {
  /** Non-empty after trimming; a fence without one is not a question. */
  query: string;
  scope: MemoryRecallScope;
  limit: number;
}

/** How many memories one unqualified question gets back. */
export const DEFAULT_RECALL_LIMIT = 5;

/**
 * Ceiling on one answer.
 *
 * The answer is delivered as a message into the session, so it costs context
 * exactly like the block it supplements. Ten short lines is an answer; a
 * hundred is the store dumped back into the prompt, which is the thing the
 * budget exists to prevent.
 */
export const MAX_RECALL_LIMIT = 10;

/** Longest query echoed back in the answer header. */
const MAX_ECHOED_QUERY = 120;

function parseScope(value: unknown): MemoryRecallScope {
  // "all" is the default because the agent asking cannot know which scope a
  // fact was filed under — the operator's project/global split is the app's
  // bookkeeping, not something the question should have to guess right.
  return value === "project" || value === "global" ? value : "all";
}

function parseLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RECALL_LIMIT;
  }
  const asked = Math.floor(value);
  if (asked < 1) return DEFAULT_RECALL_LIMIT;
  return Math.min(asked, MAX_RECALL_LIMIT);
}

function parseBody(body: string): MemoryRecallRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  // A bare string is the shorthand the write fence already accepts for a
  // single statement; here it is the whole question.
  const source =
    typeof parsed === "string"
      ? { query: parsed }
      : parsed && typeof parsed === "object"
        ? (parsed as { query?: unknown; scope?: unknown; limit?: unknown })
        : null;
  if (!source) return null;
  const query = typeof source.query === "string" ? source.query.trim() : "";
  if (!query) return null;
  return {
    query,
    scope: parseScope(source.scope),
    limit: parseLimit(source.limit),
  };
}

/**
 * The first readable `distill-recall` block of a message.
 *
 * One question per reply, unlike the write fence which merges every block it
 * finds: each answer is a message delivered back into the session, and a
 * reply carrying four questions would wake the model four times over.
 */
export function parseRecallFence(text: string): MemoryRecallRequest | null {
  if (!text.includes(RECALL_FENCE_TAG)) return null;
  RECALL_FENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(RECALL_FENCE_PATTERN)) {
    const parsed = match[1] ? parseBody(match[1]) : null;
    if (parsed) return parsed;
  }
  return null;
}

function matchesScope(entry: MemoryEntry, scope: MemoryRecallScope): boolean {
  return scope === "all" || entry.scope === scope;
}

/**
 * The memories one session is allowed to be told about.
 *
 * The project filter is a law, not a preference: a memory scoped to one
 * project must not reach a session working in another (LAWS/MEMORY.md,
 * Reading back). Reaching across projects is the operator's search in the
 * panel, and the agent has no equivalent. Generic over the entry so the
 * archive passes through the same gate as the live list — an archived
 * project memory is still that project's.
 */
export function recallReachable<Entry extends MemoryEntry>(
  entries: readonly Entry[],
  projectId: string | null,
  scope: MemoryRecallScope,
): Entry[] {
  return entries.filter(
    (entry) => appliesToProject(entry, projectId) && matchesScope(entry, scope),
  );
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function echoQuery(query: string): string {
  // The header is an attribute the model reads back; a quote inside it would
  // make the line unparseable to anything that treats it as markup.
  const flat = query.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return flat.length > MAX_ECHOED_QUERY
    ? `${flat.slice(0, MAX_ECHOED_QUERY - 1)}…`
    : flat;
}

function hitLine(
  hit: MemorySearchHit,
  projectNameOf: (id: string | null) => string,
): string {
  const facts = [
    hit.entry.scope === "global"
      ? "global"
      : `project ${projectNameOf(hit.entry.projectId)}`,
    `created ${day(hit.entry.createdAt)}`,
    ...(hit.entry.reinforcedAt
      ? [`confirmed ${day(hit.entry.reinforcedAt)}`]
      : []),
    // Marked, always: an answer that handed back a displaced line as if the
    // app still stood behind it would be the archive lying (LAWS/MEMORY.md).
    ...(hit.archived ? ["archived"] : []),
  ];
  return `- ${hit.entry.text} (${facts.join("; ")})`;
}

/**
 * One answer, ready to deliver.
 *
 * Ends by telling the model not to ask again. Without it the same thin block
 * that prompted the question is still thin on the next turn, and the cheapest
 * thing a model can do is ask once more.
 */
export function formatRecallAnswer(
  hits: readonly MemorySearchHit[],
  projectNameOf: (id: string | null) => string,
  query: string,
): string {
  return [
    `<${RECALL_ANSWER_TAG} query="${echoQuery(query)}">`,
    ...hits.map((hit) => hitLine(hit, projectNameOf)),
    hits.length > 0 ? "No more matches." : "Nothing found.",
    `</${RECALL_ANSWER_TAG}>`,
    "Do not repeat this recall for the same question.",
  ].join("\n");
}

/** What a session gets instead of a search once it has asked too often. */
export const RECALL_LIMIT_REACHED_TEXT =
  "Recall limit reached for this turn; ask the operator.";

/** How far back the loop guard looks. */
export const RECALL_LOOP_WINDOW = 6;

/** How many answers that window may hold before the next one is refused. */
export const MAX_RECALL_ANSWERS_PER_WINDOW = 3;

/** True for a message this feature delivered, of either kind. */
export function isRecallAnswerText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(`<${RECALL_ANSWER_TAG}`) ||
    trimmed.startsWith(RECALL_LIMIT_REACHED_TEXT)
  );
}

/**
 * Has this session spent its recall budget for now?
 *
 * Every answer is a real message that makes the model run again, and the
 * model that runs sees a block still missing whatever it wanted — a shape
 * that can ask, be answered, and ask again without ever stopping. So the
 * window is counted rather than trusted: past three answers in six messages
 * the app stops searching and says so, which ends the loop with a sentence
 * the model can act on instead of silence it will retry.
 */
export function recallBudgetSpent(recentTexts: readonly string[]): boolean {
  return (
    recentTexts.filter(isRecallAnswerText).length >=
    MAX_RECALL_ANSWERS_PER_WINDOW
  );
}

export interface MemoryRecallCandidate {
  sessionId: string;
  messageId: string;
  request: MemoryRecallRequest;
  /** The session's tail, for the loop guard above. */
  recentTexts: string[];
}

/**
 * How far back a scan reads. The subscription fires on every streamed token.
 *
 * Tail only, and deliberately no deep first pass like the write scan's: a
 * fence applied late still files a fact the operator wanted, while a question
 * answered late wakes a session over something asked in another sitting.
 */
export const RECALL_SCAN_TAIL = 20;

function isSettledAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.completionStatus !== "inProgress"
  );
}

/**
 * The messages asking a question nobody has answered yet.
 *
 * Only settled assistant messages: a fence half-written mid-stream is not a
 * question yet, and answering it would deliver into a session still holding
 * the turn.
 */
export function detectRecallFenceCandidates(args: {
  messagesBySession: Readonly<Record<string, readonly Message[] | undefined>>;
  isAnswered: (messageId: string) => boolean;
}): MemoryRecallCandidate[] {
  const candidates: MemoryRecallCandidate[] = [];
  for (const [sessionId, messages] of Object.entries(args.messagesBySession)) {
    if (!messages?.length) continue;
    const tail = messages.slice(-RECALL_SCAN_TAIL);
    let recentTexts: string[] | null = null;
    for (const message of tail) {
      if (!isSettledAssistantMessage(message)) continue;
      if (args.isAnswered(message.id)) continue;
      const text = getTextContent(message);
      if (!text.includes(RECALL_FENCE_TAG)) continue;
      const request = parseRecallFence(text);
      if (!request) continue;
      recentTexts ??= messages
        .slice(-RECALL_LOOP_WINDOW)
        .map((entry) => getTextContent(entry));
      candidates.push({
        sessionId,
        messageId: message.id,
        request,
        recentTexts,
      });
    }
  }
  return candidates;
}

export const MEMORY_RECALL_PROMPT = `<memory-recall-protocol>
The block above carries only what fits in it. Older memories, and ones the app has displaced into its archive, are still stored — ask for them with a fenced block anywhere in your reply:

\`\`\`${RECALL_FENCE_TAG}
{"query": "release branch", "scope": "project", "limit": ${DEFAULT_RECALL_LIMIT}}
\`\`\`

Only "query" is required. "scope" is "all" (everything you may see, the default), "project" (this project only) or "global"; "limit" is at most ${MAX_RECALL_LIMIT}. The answer comes back as a message in this conversation; the first block of a reply is answered and the rest are ignored.

Ask when the block above is thin and what you get back would change what you do — a decision you half-remember, something the operator settled in another session. Never ask for a line that is already in the block, and never ask the same question twice: the answer will not have changed.
</memory-recall-protocol>`;
