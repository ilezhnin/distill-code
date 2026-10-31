/**
 * What became of one message's `distill-memory` block, read from the memory
 * as it stands now.
 *
 * The block is machine-facing: the transcript shows a compact record in its
 * place, and this is what that record says. It is derived rather than stored
 * because the truth the operator needs is the current one — a line the store
 * kept and the operator later deleted is not "saved" any more — and because
 * every input already exists: the fence itself, the applied tombstones, the
 * live list and the archive, the session's write access and the store's own
 * refusal verdict, which is exported so that this reports exactly what the
 * store acted on.
 *
 * Pure.
 */

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import { normalizeMemoryText, sameMemoryText } from "./memoryEntry";
import type { MemoryFenceRemember, MemoryFenceRequest } from "./memoryFence";
import type { MemoryWriteDenial } from "./memoryWriteAccess";
import type { MemoryRefusal } from "../stores/memoryStore";

/** Where one statement of the block stands. */
export type MemoryStatementState =
  /** The block has not been applied yet; it will be. */
  | "pending"
  /** Memory writing is switched off; the block waits in the transcript. */
  | "paused"
  /** In the live list now. */
  | "kept"
  /** Kept, and since displaced into the archive. */
  | "archived"
  /** Kept, and no longer anywhere: the operator removed it. */
  | "removed"
  /** Not kept: the store refused the statement or the session. */
  | "refused"
  /** A `forget` the store carried out: the line is out of the live list. */
  | "retired";

export interface MemoryStatementOutcome {
  /** Stable within one block: the statement’s kind and position in it. */
  key: string;
  kind: "remember" | "forget";
  text: string;
  /** Set for `remember`; a `forget` reaches whichever scope holds the line. */
  scope?: MemoryFenceRemember["scope"];
  state: MemoryStatementState;
  refusal?: MemoryRefusal;
}

export type MemoryFenceStatus =
  | "pending"
  | "paused"
  | "denied"
  | "saved"
  | "partial"
  | "refused";

export interface MemoryFenceOutcome {
  status: MemoryFenceStatus;
  /** Set when the session itself may not write to memory. */
  denial?: MemoryWriteDenial;
  statements: MemoryStatementOutcome[];
}

export interface MemoryFenceOutcomeInput {
  request: MemoryFenceRequest;
  /** True once the store has tombstoned this message, applied or dismissed. */
  handled: boolean;
  writeEnabled: boolean;
  denial: MemoryWriteDenial | null;
  projectId: string | null;
  entries: readonly MemoryEntry[];
  archived: readonly ArchivedMemoryEntry[];
  refusalOf: (
    item: MemoryFenceRemember,
    projectId: string | null,
  ) => MemoryRefusal | null;
}

function inScope(
  entry: MemoryEntry,
  text: string,
  projectId: string | null,
): boolean {
  return (
    sameMemoryText(entry.text, text) &&
    (entry.scope === "global" || entry.projectId === projectId)
  );
}

export function memoryFenceOutcome(
  input: MemoryFenceOutcomeInput,
): MemoryFenceOutcome {
  const { request, handled, projectId } = input;
  const waiting: MemoryStatementState | null = handled
    ? null
    : input.writeEnabled
      ? "pending"
      : "paused";

  const remembered = request.remember.map(
    (item, position): MemoryStatementOutcome => {
      const base = {
        key: `remember:${position}`,
        kind: "remember" as const,
        text: normalizeMemoryText(item.text),
        scope: item.scope,
      };
      if (input.denial) return { ...base, state: "refused" };
      const refusal = input.refusalOf(item, projectId);
      if (refusal) return { ...base, state: "refused", refusal };
      if (input.entries.some((entry) => inScope(entry, item.text, projectId))) {
        return { ...base, state: "kept" };
      }
      if (waiting) return { ...base, state: waiting };
      if (
        input.archived.some((entry) => inScope(entry, item.text, projectId))
      ) {
        return { ...base, state: "archived" };
      }
      return { ...base, state: "removed" };
    },
  );

  const forgotten = request.forget.map(
    (text, position): MemoryStatementOutcome => {
      const base = {
        key: `forget:${position}`,
        kind: "forget" as const,
        text: normalizeMemoryText(text),
      };
      if (input.denial) return { ...base, state: "refused" };
      if (waiting) return { ...base, state: waiting };
      return input.entries.some((entry) => inScope(entry, text, projectId))
        ? { ...base, state: "refused" }
        : { ...base, state: "retired" };
    },
  );

  const statements = [...remembered, ...forgotten];
  if (input.denial) {
    return { status: "denied", denial: input.denial, statements };
  }
  if (waiting) return { status: waiting, statements };
  const refused = statements.filter(
    (statement) => statement.state === "refused",
  ).length;
  const status: MemoryFenceStatus =
    refused === 0
      ? "saved"
      : refused === statements.length
        ? "refused"
        : "partial";
  return { status, statements };
}
