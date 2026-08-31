/**
 * The pointer to a project's own wiki (M12; `LAWS/MEMORY.md`, "Project
 * knowledge").
 *
 * A project that has compiled what it knows into `.distill/wiki/` has already
 * paid for that knowledge once. Every session that re-reads the repository
 * from scratch pays for it again, and the operator watches the same
 * exploration happen a third time. One sentence in the workspace context is
 * the whole fix: where the wiki is, and that reading it comes before
 * re-exploring.
 *
 * Only the pointer. The wiki's content stays on disk where the agent can open
 * the pages its zone actually touches — inlining an index (let alone pages)
 * would spend the context budget this feature exists to save, and would push
 * out the instructions and memory that share the same prompt.
 *
 * Unlike the memory block, this reaches wave children too. A memory is the
 * operator's record and belongs to the conductor's loop; a wiki page is what
 * the project knows, and an executor sent to change a module benefits from it
 * exactly as much as the chat that dispatched it. Writing is still the
 * conductor's alone — which is why the sentence says so.
 *
 * ## Why the presence check is a cache and not an await
 *
 * "Does this project have a wiki?" is a directory listing over the Tauri
 * bridge, and the prompt is composed on the send path, after the dispatch
 * target has been leased. Awaiting an answer there would put an IPC round
 * trip between the operator pressing enter and the turn leaving — for a line
 * that is optional by construction. So the compose step reads what is already
 * known and never blocks: a root nobody has asked about yet gets no line this
 * turn and a refresh scheduled for the next one. A missing pointer costs one
 * turn of re-exploration; a slower send costs every turn.
 *
 * The refresh is scheduled on every read, not only the first, so a wiki
 * created mid-session is picked up on the turn after it appears, and one
 * deleted stops being advertised.
 */

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { listProjectDocuments } from "@/shared/api/projectStore";

import { projectMemoryRoot } from "./projectMemoryDocuments";

/** The wiki's folder, relative to the project's `.distill` store. */
export const PROJECT_WIKI_DIR = "wiki";

/** The catalogue every wiki has; its absence is the absence of a wiki. */
export const PROJECT_WIKI_INDEX_DOCUMENT = "index.md";

/**
 * The sentence itself, fixed.
 *
 * Byte-for-byte stable on purpose: it sits in the cached prefix of every
 * prompt this project sends, and a line that varies — by root, by page count,
 * by date — would invalidate that cache on every turn and charge the operator
 * for it. Nothing about the project may leak into it.
 */
export const PROJECT_WIKI_POINTER_PROMPT =
  "This project keeps a knowledge wiki at .distill/wiki/. Read .distill/wiki/index.md before re-exploring the repository. Only the conductor loop updates it.";

/** The pointer, or nothing. The whole formatter. */
export function formatProjectWikiPrompt(hasWiki: boolean): string | undefined {
  return hasWiki ? PROJECT_WIKI_POINTER_PROMPT : undefined;
}

/**
 * Whether one project folder holds a wiki index.
 *
 * The same path `projectMemoryDocuments` takes to ask whether a project has a
 * memory file: list the store folder and look for the name. A folder that
 * cannot be listed — gone, unmounted, no desktop runtime at all — has no
 * wiki as far as the prompt is concerned.
 */
export async function readProjectWikiPresence(root: string): Promise<boolean> {
  try {
    return (await listProjectDocuments(root, PROJECT_WIKI_DIR)).includes(
      PROJECT_WIKI_INDEX_DOCUMENT,
    );
  } catch {
    return false;
  }
}

const presenceByRoot = new Map<string, boolean>();
const inFlightRoots = new Set<string>();

/**
 * Re-reads one project folder and records the answer for the send path.
 *
 * Coalesced per root: a burst of sends into the same project schedules one
 * listing, not one each. Awaiting this is how a caller that genuinely wants
 * the answer now (a test, a warm-up) gets it.
 */
export async function refreshProjectWikiPresence(
  root: string,
): Promise<boolean> {
  const key = root.trim();
  if (!key) return false;
  if (inFlightRoots.has(key)) return presenceByRoot.get(key) ?? false;
  inFlightRoots.add(key);
  try {
    const present = await readProjectWikiPresence(key);
    presenceByRoot.set(key, present);
    return present;
  } finally {
    inFlightRoots.delete(key);
  }
}

/**
 * The pointer for a project folder, from what is already known.
 *
 * Synchronous by contract — see the header. An unknown root answers "no line"
 * and leaves a refresh running behind it.
 */
export function projectWikiPromptForRoot(
  root: string | null | undefined,
): string | undefined {
  const key = root?.trim();
  if (!key) return undefined;
  const known = presenceByRoot.get(key);
  // Never rejects: the listing's own failure is recorded as "no wiki".
  void refreshProjectWikiPresence(key);
  return formatProjectWikiPrompt(known ?? false);
}

/**
 * What is already known about a root, without asking about it.
 *
 * The synchronous half of the contract above, for a caller that schedules its
 * own refresh — the open chat's controller does it from an effect, once per
 * turn, and must not have that listing coalesced away by a read that happened
 * to run first during render.
 */
export function knownProjectWikiPresence(
  root: string | null | undefined,
): boolean {
  const key = root?.trim();
  return key ? (presenceByRoot.get(key) ?? false) : false;
}

/**
 * The pointer for a session, wired to the stores the send paths run outside
 * React. A session with no project has no wiki to point at.
 */
export function sessionProjectWikiPrompt(
  sessionId: string,
): string | undefined {
  const projectId = useChatSessionStore
    .getState()
    .getSession(sessionId)?.projectId;
  if (!projectId) return undefined;
  const project = useProjectStore
    .getState()
    .projects.find((candidate) => candidate.id === projectId);
  return project
    ? projectWikiPromptForRoot(projectMemoryRoot(project))
    : undefined;
}

/** Clears what has been learned about every root. Tests only. */
export function resetProjectWikiPresenceForTests(): void {
  presenceByRoot.clear();
  inFlightRoots.clear();
}
