/**
 * A project's memories, in the project's own folder (P31).
 *
 * Memory has two scopes and only ever had one home. A fact about one
 * repository lived in the operator's global folder alongside facts about
 * every other one, so copying that repository to another machine — or handing
 * it to a colleague — carried the code and left behind everything the agents
 * had learned working on it. The scope said "this belongs to the project";
 * the storage said otherwise.
 *
 * Mirrored rather than moved, deliberately. The global document still holds
 * every entry, exactly as before, and each project's folder gets a copy of
 * its own. Nothing can be lost to a folder that is not there — an external
 * drive, a project on a machine this one has never seen — which a straight
 * move could not promise. The cost is a bounded duplicate (the store is
 * capped at three hundred short lines) and one honest limitation: a project
 * folder that has not been written since an entry was deleted still holds
 * that entry, and the next read of that folder brings it back. Rewriting the
 * file on every commit keeps that window to "the project was offline when
 * you deleted it".
 *
 * A folder is read before it is written, every time. The file may hold what
 * this process has never seen — the project was created after startup, its
 * drive was mounted after startup, a colleague's copy arrived with the
 * repository — and the only copy of those lines is the one about to be
 * replaced. So a folder that cannot be read is not written, and one that can
 * is written with what it held folded in (the store does the folding, since
 * it knows which lines the operator deleted this run).
 */

import type { ProjectInfo } from "@/features/projects/api/projects";
import {
  listProjectDocuments,
  readProjectDocument,
  writeProjectDocument,
} from "@/shared/api/projectStore";

import type { ArchivedMemoryEntry, MemoryEntry } from "./memoryEntry";
import { findSecret } from "./memoryRedaction";

/** Path inside a project's own `.distill` folder. */
export const PROJECT_MEMORY_DOCUMENT = "memory.json";

/**
 * The folder a project's documents live in, or `null` when it has none.
 *
 * The first working directory: a project with several is still one project,
 * and its memories belong with the folder the operator thinks of as the
 * project rather than being split across all of them.
 */
export function projectMemoryRoot(project: ProjectInfo): string | null {
  const root = project.workingDirs?.[0]?.trim();
  return root ? root : null;
}

interface StoredProjectMemory {
  version: 2;
  projectId: string;
  entries: MemoryEntry[];
  /** Displaced memories travel with the project too; see `LAWS/MEMORY.md`. */
  archived: ArchivedMemoryEntry[];
}

/** What one project's folder holds, both lists. */
export interface ProjectMemories {
  entries: MemoryEntry[];
  archived: ArchivedMemoryEntry[];
}

/** One folder's read: what it holds, and whether the file exists at all. */
export interface ProjectMemoryFolder extends ProjectMemories {
  hasFile: boolean;
}

/**
 * Several folders' reads, and which of them were actually read.
 *
 * A project is listed in `readProjectIds` when its folder answered — with a
 * file or without one. A project missing from it could not be read, and its
 * file (which may hold lines nothing else does) is not this run's to write.
 */
export interface ProjectMemoryRead extends ProjectMemories {
  readProjectIds: string[];
}

function serialize(
  projectId: string,
  entries: MemoryEntry[],
  archived: ArchivedMemoryEntry[],
): string {
  const payload: StoredProjectMemory = {
    version: 2,
    projectId,
    entries,
    archived,
  };
  return JSON.stringify(payload);
}

/**
 * Writes each project's own memories into its folder.
 *
 * Every project the operator has is written, including the ones whose entry
 * list is now empty: an empty file is how a deletion reaches the folder, and
 * skipping it would leave the last copy of a forgotten fact on disk.
 *
 * Best-effort per project. A folder that cannot be written — gone, read-only,
 * on a drive that is not mounted — costs that project's mirror and nothing
 * else; the global document is unaffected and still holds everything.
 *
 * The caller is expected to pass only projects whose folder it has read and
 * folded into `entries` (see the module comment): this writes what it is
 * given, and what it is given must already contain what the file held.
 * `hasFileByProjectId` is that read's answer to "is there a file", so the
 * empty-project rule below does not have to ask the folder a second time.
 */
export async function writeProjectMemories(
  projects: readonly ProjectInfo[],
  entries: readonly MemoryEntry[],
  archived: readonly ArchivedMemoryEntry[] = [],
  hasFileByProjectId: ReadonlyMap<string, boolean> = new Map(),
): Promise<void> {
  const byProject = bucketByProject(entries);
  const archivedByProject = bucketByProject(archived);

  await Promise.all(
    projects.map(async (project) => {
      const root = projectMemoryRoot(project);
      if (!root) return;
      const own = byProject.get(project.id) ?? [];
      const ownArchived = archivedByProject.get(project.id) ?? [];
      // A project that has never had a memory gets no file at all: creating
      // one would put a `.distill` folder into a repository for nothing.
      if (
        own.length === 0 &&
        ownArchived.length === 0 &&
        !(
          hasFileByProjectId.get(project.id) ??
          (await hasProjectMemoryFile(root))
        )
      ) {
        return;
      }
      try {
        await writeProjectDocument(
          root,
          PROJECT_MEMORY_DOCUMENT,
          serialize(project.id, own, ownArchived),
        );
      } catch (error) {
        console.error(
          `Failed to write memories into ${project.name}'s folder:`,
          error,
        );
      }
    }),
  );
}

function bucketByProject<T extends MemoryEntry>(
  entries: readonly T[],
): Map<string, T[]> {
  const byProject = new Map<string, T[]>();
  for (const entry of entries) {
    if (entry.scope !== "project" || !entry.projectId) continue;
    const bucket = byProject.get(entry.projectId);
    if (bucket) bucket.push(entry);
    else byProject.set(entry.projectId, [entry]);
  }
  return byProject;
}

async function hasProjectMemoryFile(root: string): Promise<boolean> {
  try {
    return (await listProjectDocuments(root, "")).includes(
      PROJECT_MEMORY_DOCUMENT,
    );
  } catch {
    return false;
  }
}

/**
 * Every memory a project's folder holds, for the projects that have one.
 *
 * The stored `projectId` is ignored in favour of the project this file was
 * read from: a folder copied from another machine carries that machine's
 * project id, and honouring it would file the memories under a project that
 * does not exist here — which `parseEntry` then drops as orphaned. The folder
 * the file was found in is the fact; the id inside it is a memento.
 *
 * A folder is an entrance, not a backup. The file may have been written by a
 * cloned repository, by a colleague's machine, by an older build with no
 * secret check at all — and everything read here goes straight into the
 * prompt block and back out into every other mirror. So each line answers to
 * the same rule a typed one does (LAWS/MEMORY.md, Writing), and it answers
 * line by line: one bad statement costs that statement, not the file, because
 * dropping the folder whole would lose a project's whole record over someone
 * else's mistake.
 */
export async function readProjectMemories(
  projects: readonly ProjectInfo[],
  parse: (raw: unknown) => MemoryEntry[],
  parseArchived: (raw: unknown) => ArchivedMemoryEntry[] = () => [],
): Promise<ProjectMemoryRead> {
  const reads = await Promise.all(
    projects.map(async (project) => ({
      project,
      folder: await readProjectMemoryFolder(project, parse, parseArchived),
    })),
  );
  return {
    entries: reads.flatMap(({ folder }) => folder?.entries ?? []),
    archived: reads.flatMap(({ folder }) => folder?.archived ?? []),
    readProjectIds: reads
      .filter(({ folder }) => folder !== null)
      .map(({ project }) => project.id),
  };
}

/**
 * One project's folder, or `null` when it could not be read.
 *
 * `null` is the answer for a folder on a drive that is not mounted, and for
 * a file that will not parse, and not for a folder that simply has no file:
 * the first two may be hiding lines this process has never seen, which is
 * exactly the case a caller about to write the file has to be told about.
 */
export async function readProjectMemoryFolder(
  project: ProjectInfo,
  parse: (raw: unknown) => MemoryEntry[],
  parseArchived: (raw: unknown) => ArchivedMemoryEntry[] = () => [],
): Promise<ProjectMemoryFolder | null> {
  const root = projectMemoryRoot(project);
  if (!root) return { entries: [], archived: [], hasFile: false };
  const own = <T extends MemoryEntry>(entry: T): T => ({
    ...entry,
    scope: "project" as const,
    projectId: project.id,
  });
  try {
    const raw = await readProjectDocument(root, PROJECT_MEMORY_DOCUMENT);
    if (!raw) return { entries: [], archived: [], hasFile: false };
    // A v1 file has no `archived` key, which reads as an empty archive.
    const parsed: unknown = JSON.parse(raw);
    return {
      entries: withoutSecrets(parse(parsed).map(own)),
      // The archive too: "Restore" is one click away from the prompts.
      archived: withoutSecrets(parseArchived(parsed).map(own)),
      hasFile: true,
    };
  } catch (error) {
    console.error(
      `Failed to read memories from ${project.name}'s folder:`,
      error,
    );
    return null;
  }
}

/** The lines of a folder's file that may be kept, in the file's own order. */
function withoutSecrets<T extends MemoryEntry>(entries: T[]): T[] {
  return entries.filter((entry) => {
    const shape = findSecret(entry.text);
    if (!shape) return true;
    // The shape and nothing else. The statement is what carries the key, so
    // logging it to explain the refusal would be the leak all over again.
    console.warn(
      `[memory] a line from a project folder was not read: ${shape}`,
    );
    return false;
  });
}

/**
 * The global list with the folders' entries folded in.
 *
 * Identity is the entry id, and what is already in memory wins: this runs
 * after the global document has been read, and an entry the operator edited
 * in this session must not be reverted by a copy on disk. An entry only the
 * folder knows about is new here — which is exactly the project that arrived
 * from somewhere else.
 */
export function mergeProjectMemories<T extends MemoryEntry>(
  base: readonly T[],
  fromFolders: readonly T[],
): T[] {
  const known = new Set(base.map((entry) => entry.id));
  const added = fromFolders.filter((entry) => !known.has(entry.id));
  return added.length === 0 ? [...base] : [...base, ...added];
}

/**
 * Both lists with the folders' folded in, by id across the two.
 *
 * `mergeProjectMemories` for a store that has an archive: an id the store
 * holds in either list is the store's, whichever list the folder shows it
 * in. A line the store archived and the folder still shows live is the
 * folder lagging behind the store, not a second memory — merging the lists
 * one at a time put such a line in both. `excluded` are the ids the operator
 * deleted this run, which no copy on disk may bring back.
 */
export function foldProjectMemories(
  base: ProjectMemories,
  fromFolders: ProjectMemories,
  excluded: ReadonlySet<string> = new Set(),
): ProjectMemories & { added: number } {
  const known = new Set<string>();
  for (const entry of base.entries) known.add(entry.id);
  for (const entry of base.archived) known.add(entry.id);
  const fresh = <T extends MemoryEntry>(entry: T): boolean => {
    if (known.has(entry.id) || excluded.has(entry.id)) return false;
    known.add(entry.id);
    return true;
  };
  const entries = fromFolders.entries.filter(fresh);
  const archived = fromFolders.archived.filter(fresh);
  return {
    entries:
      entries.length === 0 ? base.entries : [...base.entries, ...entries],
    archived:
      archived.length === 0 ? base.archived : [...base.archived, ...archived],
    added: entries.length + archived.length,
  };
}
