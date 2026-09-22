/**
 * The pointer to a project's own decision records.
 *
 * Same shape as the wiki pointer (`projectWikiPrompt.ts`): one sentence,
 * presence from a directory listing, never the records themselves. A wave
 * child still gets this — it is what the project has already decided, not
 * the operator's record.
 */

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { listProjectDocuments } from "@/shared/api/projectStore";

import { projectMemoryRoot } from "./projectMemoryDocuments";

/** The research folder, relative to the project's `.distill` store. */
export const PROJECT_RESEARCH_DIR = "research";

/** The catalogue every research folder has; its absence is the absence of records. */
export const PROJECT_RESEARCH_INDEX_DOCUMENT = "index.md";

/**
 * The sentence itself, fixed.
 *
 * Byte-for-byte stable on purpose: it sits in the cached prefix of every
 * prompt this project sends, and a line that varies would invalidate that
 * cache on every turn.
 */
export const PROJECT_RESEARCH_POINTER_PROMPT =
  "This project keeps decision records at .distill/research/. Read .distill/research/index.md before revisiting a settled question. One record per decision; the operator or the conductor loop writes them.";

export function formatProjectResearchPrompt(
  hasResearch: boolean,
): string | undefined {
  return hasResearch ? PROJECT_RESEARCH_POINTER_PROMPT : undefined;
}

export async function readProjectResearchPresence(
  root: string,
): Promise<boolean> {
  try {
    return (await listProjectDocuments(root, PROJECT_RESEARCH_DIR)).includes(
      PROJECT_RESEARCH_INDEX_DOCUMENT,
    );
  } catch {
    return false;
  }
}

const presenceByRoot = new Map<string, boolean>();
const inFlightRoots = new Map<string, Promise<boolean>>();

export async function refreshProjectResearchPresence(
  root: string,
): Promise<boolean> {
  const key = root.trim();
  if (!key) return false;
  const pending = inFlightRoots.get(key);
  if (pending) return pending;
  const refresh = readProjectResearchPresence(key).then((present) => {
    presenceByRoot.set(key, present);
    return present;
  });
  inFlightRoots.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (inFlightRoots.get(key) === refresh) inFlightRoots.delete(key);
  }
}

export function projectResearchPromptForRoot(
  root: string | null | undefined,
): string | undefined {
  const key = root?.trim();
  if (!key) return undefined;
  const known = presenceByRoot.get(key);
  void refreshProjectResearchPresence(key);
  return formatProjectResearchPrompt(known ?? false);
}

export function knownProjectResearchPresence(
  root: string | null | undefined,
): boolean {
  const key = root?.trim();
  return key ? (presenceByRoot.get(key) ?? false) : false;
}

export function sessionProjectResearchPrompt(
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
    ? projectResearchPromptForRoot(projectMemoryRoot(project))
    : undefined;
}

/** The send boundary waits for presence, including an already-running listing. */
export async function loadSessionProjectResearchPrompt(
  sessionId: string,
): Promise<string | undefined> {
  const projectId = useChatSessionStore
    .getState()
    .getSession(sessionId)?.projectId;
  const project = projectId
    ? useProjectStore
        .getState()
        .projects.find((candidate) => candidate.id === projectId)
    : undefined;
  const root = project ? projectMemoryRoot(project) : null;
  return root
    ? formatProjectResearchPrompt(await refreshProjectResearchPresence(root))
    : undefined;
}

/** Clears what has been learned about every root. Tests only. */
export function resetProjectResearchPresenceForTests(): void {
  presenceByRoot.clear();
  inFlightRoots.clear();
}
