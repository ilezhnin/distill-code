/**
 * The `distill-todo` fence: how an agent files work onto the operator's list.
 *
 * Same shape as the conductor's `distill-wave` / `distill-report` protocol,
 * and for the same reason — it is the only channel that works identically on
 * every harness we speak to. Goose could be given a real tool; the Claude,
 * Grok and Codex bridges could not, and a planner that only fills up under
 * one backend is a planner the operator cannot trust to be complete.
 *
 * Pure. Reading a fence is parsing; applying one is the store.
 */

import type { PlannerPriority, PlannerRepeat, Weekday } from "./plannerTask";
import { startOfLocalDay } from "./plannerTask";

export const TODO_FENCE_TAG = "distill-todo";

const TODO_FENCE_PATTERN = /```distill-todo\s*([\s\S]*?)```/gi;

export interface PlannerFenceAdd {
  title: string;
  dueAt: number | null;
  priority: PlannerPriority;
  repeat: PlannerRepeat | null;
  notes?: string;
}

export interface PlannerFenceRequest {
  add: PlannerFenceAdd[];
  /** Titles of open tasks the agent says are now done. */
  complete: string[];
}

/** A YYYY-MM-DD date as the start of that local day. Anything else is undated. */
export function parseFenceDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  // A model that writes 2026-02-31 means the end of February, not the third
  // of March: reject the roll-over rather than file a task on a wrong day.
  if (date.getMonth() !== Number(month) - 1) return null;
  return startOfLocalDay(date.getTime());
}

function parseFenceRepeat(value: unknown): PlannerRepeat | null {
  if (value === "daily") return { kind: "daily" };
  if (value === "weekly") return { kind: "weekly", days: [] };
  if (!value || typeof value !== "object") return null;
  const raw = value as { kind?: unknown; days?: unknown };
  if (raw.kind === "daily") return { kind: "daily" };
  if (raw.kind !== "weekly") return null;
  const days = Array.isArray(raw.days)
    ? raw.days.filter(
        (day): day is Weekday =>
          typeof day === "number" &&
          Number.isInteger(day) &&
          day >= 0 &&
          day <= 6,
      )
    : [];
  return { kind: "weekly", days };
}

function parseAdd(value: unknown): PlannerFenceAdd | null {
  // A bare string is the commonest thing a model writes when it is in a
  // hurry, and refusing it would lose the task over its packaging.
  if (typeof value === "string") {
    const title = value.trim();
    return title
      ? { title, dueAt: null, priority: "normal", repeat: null }
      : null;
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  return {
    title,
    dueAt: parseFenceDate(raw.due ?? raw.dueAt),
    priority: raw.priority === "high" ? "high" : "normal",
    repeat: parseFenceRepeat(raw.repeat),
    ...(notes ? { notes } : {}),
  };
}

function parseBody(body: string): PlannerFenceRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  // `{"add": [...]}`, or a bare array read as the add list.
  const source = Array.isArray(parsed)
    ? { add: parsed, complete: [] }
    : parsed && typeof parsed === "object"
      ? (parsed as { add?: unknown; complete?: unknown })
      : null;
  if (!source) return null;
  const add = Array.isArray(source.add)
    ? source.add
        .map(parseAdd)
        .filter((entry): entry is PlannerFenceAdd => entry !== null)
    : [];
  const complete = Array.isArray(source.complete)
    ? source.complete
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  if (add.length === 0 && complete.length === 0) return null;
  return { add, complete };
}

/**
 * Every `distill-todo` block in one message, merged.
 *
 * Merged rather than "first wins": an agent that files two tasks in two
 * blocks meant both, and dropping the second would be a silent loss — the
 * one failure mode a task list must not have.
 */
export function parsePlannerFences(text: string): PlannerFenceRequest | null {
  if (!text.includes(TODO_FENCE_TAG)) return null;
  const add: PlannerFenceAdd[] = [];
  const complete: string[] = [];
  TODO_FENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TODO_FENCE_PATTERN)) {
    const parsed = match[1] ? parseBody(match[1]) : null;
    if (!parsed) continue;
    add.push(...parsed.add);
    complete.push(...parsed.complete);
  }
  if (add.length === 0 && complete.length === 0) return null;
  return { add, complete };
}

/**
 * What the agent is told about the list.
 *
 * Deliberately short and deliberately fenced with the same tag the reader
 * looks for: the protocol is one paragraph and one example, because a
 * protocol that costs a page of context on every session is one the operator
 * ends up turning off.
 */
export const PLANNER_PROTOCOL_PROMPT = `<planner>
The operator keeps a task list in this app. You can put work on it, or tick work off it, by ending your reply with a fenced block:

\`\`\`${TODO_FENCE_TAG}
{"add": [{"title": "Renew the signing certificate", "due": "2026-09-01", "priority": "high"}], "complete": ["Draft the release notes"]}
\`\`\`

Only "title" is required; "due" is YYYY-MM-DD, "priority" is "normal" or "high", "repeat" is "daily" or "weekly". "complete" names open tasks by their exact title.

File only work the operator has to do or asked you to remember — never your own intermediate steps, and never a task you are about to do yourself in this same turn. The block is read once, when your turn ends, so writing it twice does not file it twice.
</planner>`;
