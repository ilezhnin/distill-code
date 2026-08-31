/**
 * The manual checklist's memory block (C.1-C.7), run as integration.
 *
 * `night_checklist_v2.md` section C is what an operator does by hand: type a
 * fact, restart the app, open a chat in another project, close the window a
 * second after remembering something. None of that can be clicked here, but
 * every step of it has an observable that can: what the store holds, what the
 * stored document says after a reload, and what the `<memory>` block a new
 * session receives actually contains. These cases walk the same sequence
 * through those observables, so a regression that would only show up on the
 * next night shift fails here instead.
 *
 * Not a substitute for the manual pass — nothing here proves the file lands
 * in the Distill folder or that the window close hook fires — and each case
 * names the checklist step it stands in for.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { flushDistillStores } from "@/features/settings/lib/distillStoreHydration";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import {
  archivedCountForProject,
  composeMemorySection,
  formatMemoryPrompt,
} from "../lib/memoryPrompt";
import { parseMemoryFences } from "../lib/memoryFence";
import type { ArchivedMemoryEntry, MemoryEntry } from "../lib/memoryEntry";
import {
  flushMemoryWrites,
  hydrateMemoryStore,
  MEMORY_STORAGE_KEY,
  parseArchivedMemoryEntries,
  parseMemoryEntries,
  useMemoryStore,
} from "../stores/memoryStore";

/** The sandbox project the checklist has the operator create for section C. */
const SANDBOX = "p-sandbox";
/** Any other project. C.3 is about what this one's sessions never see. */
const OTHER = "p-other";

const NOW = new Date(2026, 7, 31, 22, 0).getTime();

/**
 * The document the store writes.
 *
 * Outside the desktop runtime `distillDocument` falls back to the browser key
 * rather than `<Distill folder>/memory.json`, but it is the same serializer
 * and the same payload — which is the part these cases are about. Whether the
 * file exists on disk is C.1's manual half.
 */
function storedDocument(): unknown {
  const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function storedTexts(): string[] {
  const document = storedDocument();
  return document === null
    ? []
    : parseMemoryEntries(document).map((entry) => entry.text);
}

function storedArchivedTexts(): string[] {
  const document = storedDocument();
  return document === null
    ? []
    : parseArchivedMemoryEntries(document).map((entry) => entry.text);
}

function live(): MemoryEntry[] {
  return useMemoryStore.getState().entries;
}

function archive(): ArchivedMemoryEntry[] {
  return useMemoryStore.getState().archived;
}

/** What a session in `projectId` is told it already knows. */
function memoryBlockFor(projectId: string | null): string | undefined {
  const state = useMemoryStore.getState();
  return composeMemorySection(
    state.entries,
    archivedCountForProject(state.archived, projectId),
    projectId,
    true,
  );
}

function resetMemory(): void {
  useMemoryStore.setState({
    entries: [],
    archived: [],
    appliedMessageIds: [],
    recallAnsweredMessageIds: [],
    // Hydration is what unlocks writing; the cases that reload set it back.
    hydrated: true,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useProjectStore.setState({ projects: [], hasFetchedProjects: true });
  resetMemory();
});

afterEach(async () => {
  // Both the document and the project mirror debounce; draining them keeps a
  // late timer from writing into the next case's cleared storage.
  await flushMemoryWrites();
});

describe("C.1 — the operator remembers something, and it is a file", () => {
  it("keeps an everywhere fact in the global group and in the stored document", async () => {
    // Checklist C.1.1: type the fact, leave the scope selector on
    // "Everywhere", press Remember.
    const text = "Ivan pushes himself, the agents have no credentials";
    const id = useMemoryStore
      .getState()
      .remember({ text, scope: "global" }, NOW);
    expect(id).not.toBe("");

    // C.1.2: it belongs to the "Everywhere" group — global scope, no project,
    // and no agent provenance, because a person typed it.
    const kept = live().find((entry) => entry.id === id);
    expect(kept).toMatchObject({ text, scope: "global", projectId: null });
    expect(kept?.createdBySessionId).toBeUndefined();

    // C.1.3: and it is in the document, which is the move off localStorage.
    await flushMemoryWrites();
    expect(storedDocument()).toMatchObject({ version: 2 });
    expect(storedTexts()).toContain(text);
  });
});

describe("C.2 — the agent sees the memory", () => {
  it("carries an everywhere fact into a new session's memory block", () => {
    const text = "Ivan pushes himself, the agents have no credentials";
    useMemoryStore.getState().remember({ text, scope: "global" }, NOW);

    // Checklist C.2: a *new* chat is asked what it knows. A new chat has no
    // history, so the block is the whole of what it can answer from.
    const block = memoryBlockFor(null);
    expect(block).toContain("<memory>");
    expect(block).toContain(`- ${text}`);
    // And in the sandbox project too: global follows the operator everywhere.
    expect(memoryBlockFor(SANDBOX)).toContain(`- ${text}`);
  });
});

describe("C.3 — a fact added to one project by hand", () => {
  beforeEach(() => {
    useMemoryStore.getState().remember(
      {
        text: "Ivan pushes himself, the agents have no credentials",
        scope: "global",
      },
      NOW,
    );
  });

  it("lands in that project's group and reaches no other project's session", () => {
    const text = "The release branch here is release/2026.9";
    // Checklist C.3.1: the scope selector is set to the sandbox project.
    const id = useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: SANDBOX }, NOW + 1);

    // C.3.2: the row shows under the project's name, not under "Everywhere".
    expect(live().find((entry) => entry.id === id)).toMatchObject({
      scope: "project",
      projectId: SANDBOX,
    });

    // C.3.3: a chat in another project does not know it. This is the law, not
    // a preference (LAWS/MEMORY.md, Reading back).
    expect(memoryBlockFor(SANDBOX)).toContain(`- ${text}`);
    const elsewhere = memoryBlockFor(OTHER);
    expect(elsewhere).not.toContain(text);
    // Checked against the block alone as well: the write protocol that ships
    // beside it teaches the fence with a release-branch *example*, so a bare
    // substring search over the whole section would match the lesson rather
    // than the memory.
    const blockElsewhere = formatMemoryPrompt(live(), 0, OTHER);
    expect(blockElsewhere).not.toContain("release/2026.9");
    // The other project still gets the operator's global facts, so this is a
    // scoped block rather than a missing one.
    expect(blockElsewhere).toContain("no credentials");
  });

  it("writes the project's row even when the same line is already global", () => {
    // The operator types a fact they already keep everywhere, with the scope
    // selector on the sandbox project. Reinforcing the global row instead
    // clears the form and adds nothing — the click looks lost, and C.3.2
    // fails with no error to explain it.
    const text = "The release branch here is release/2026.9";
    const everywhere = useMemoryStore
      .getState()
      .remember({ text, scope: "global" }, NOW + 1);
    const inProject = useMemoryStore
      .getState()
      .remember({ text, scope: "project", projectId: SANDBOX }, NOW + 2);

    expect(inProject).not.toBe(everywhere);
    expect(live().find((entry) => entry.id === inProject)).toMatchObject({
      scope: "project",
      projectId: SANDBOX,
    });
  });
});

describe("C.4 — the agent remembers and corrects", () => {
  it("leaves one line with the new branch, agent-written, and archives the old one", async () => {
    const old = "The release branch here is release/2026.9";
    const corrected = "The release branch here is release/2026.10";
    const oldId = useMemoryStore
      .getState()
      .remember({ text: old, scope: "project", projectId: SANDBOX }, NOW);

    // Checklist C.4.1: said in a chat inside the sandbox project. The agent's
    // side of it is one `distill-memory` fence at the end of its reply.
    const reply = [
      "Noted — I will use the new branch from now on.",
      "```distill-memory",
      JSON.stringify({
        remember: [{ text: corrected, scope: "project" }],
        forget: [old],
      }),
      "```",
    ].join("\n");
    const request = parseMemoryFences(reply);
    if (!request)
      throw new Error("the reply's distill-memory fence did not parse");

    const applied = useMemoryStore
      .getState()
      // The project comes from the session, never from the agent.
      .applyAgentRequest("m-1", "s-agent", SANDBOX, request, NOW + 1);
    expect(applied).toEqual({ remembered: 1, forgotten: 1 });

    // C.4.2: one row under the project's name, with the new branch.
    const projectRows = live().filter((entry) => entry.projectId === SANDBOX);
    expect(projectRows.map((entry) => entry.text)).toEqual([corrected]);
    // And it carries the badge's fact: an agent put it there.
    expect(projectRows[0].createdBySessionId).toBe("s-agent");

    // The old line is gone from the panel but not destroyed — a correction is
    // a displacement (LAWS/MEMORY.md, Sovereignty).
    expect(archive().map((entry) => entry.text)).toEqual([old]);
    expect(archive()[0]).toMatchObject({
      id: oldId,
      archiveReason: "superseded",
      replacedById: projectRows[0].id,
    });

    await flushMemoryWrites();
    expect(storedTexts()).toContain(corrected);
    expect(storedTexts()).not.toContain(old);
    expect(storedArchivedTexts()).toContain(old);
  });

  it("keeps the old line when the same correction comes from a chat with no project", () => {
    // C.4 done in a chat outside any project. `project` is the fence's
    // default scope, so the replacement cannot be kept — and a correction is
    // one fact restated, so the retirement is refused with it. Applying only
    // the `forget` would archive the fact and store nothing in its place:
    // the operator loses it and is shown nothing that says so.
    const old = "The release branch here is release/2026.9";
    const corrected = "The release branch here is release/2026.10";
    useMemoryStore.getState().remember({ text: old, scope: "global" }, NOW);

    const request = parseMemoryFences(
      [
        "```distill-memory",
        JSON.stringify({
          remember: [{ text: corrected, scope: "project" }],
          forget: [old],
        }),
        "```",
      ].join("\n"),
    );
    if (!request)
      throw new Error("the reply's distill-memory fence did not parse");

    const applied = useMemoryStore
      .getState()
      .applyAgentRequest("m-1", "s-agent", null, request, NOW + 1);

    expect(applied).toEqual({ remembered: 0, forgotten: 0 });
    expect(live().map((entry) => entry.text)).toEqual([old]);
    expect(archive()).toEqual([]);
  });
});

describe("C.5 — the operator's delete is a real delete", () => {
  it("leaves no copy anywhere, and a reload does not bring it back", async () => {
    const text = "A fact typed by mistake";
    const id = useMemoryStore
      .getState()
      .remember({ text, scope: "global" }, NOW);
    const keeper = "The other fact, which must survive";
    useMemoryStore
      .getState()
      .remember({ text: keeper, scope: "global" }, NOW + 1);

    // Checklist C.5.3: the trash button, then "Forget this" in the dialog.
    // The confirmation itself is the panel's, covered in the UI cases.
    useMemoryStore.getState().forget(id);

    // Gone from the live list, and — unlike an agent's retraction — with no
    // archived copy: the archive binds the app, not the operator.
    expect(live().map((entry) => entry.text)).toEqual([keeper]);
    expect(archive()).toHaveLength(0);

    // C.5.4: restart the app. The store is refilled from the document alone.
    await flushMemoryWrites();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      recallAnsweredMessageIds: [],
      hydrated: false,
    });
    await hydrateMemoryStore();

    expect(live().map((entry) => entry.text)).toEqual([keeper]);
    expect(archive()).toHaveLength(0);
  });
});

describe("C.6 — forgetting a project that no longer exists", () => {
  it("sweeps that project's memories whole and touches nothing else", async () => {
    const globalText = "A fact that applies everywhere";
    const liveText = "A fact about the project that still exists";
    const orphanOne = "The temporary project used pnpm";
    const orphanTwo = "The temporary project was on Windows";
    useMemoryStore
      .getState()
      .remember({ text: globalText, scope: "global" }, NOW);
    useMemoryStore
      .getState()
      .remember(
        { text: liveText, scope: "project", projectId: SANDBOX },
        NOW + 1,
      );
    useMemoryStore
      .getState()
      .remember(
        { text: orphanOne, scope: "project", projectId: "p-gone" },
        NOW + 2,
      );
    useMemoryStore
      .getState()
      .remember(
        { text: orphanTwo, scope: "project", projectId: "p-gone" },
        NOW + 3,
      );

    // Checklist C.6.1: the project is deleted, its memories are not. They stay
    // in the store — dropping them at read time would be the app deleting the
    // operator's data — and the panel is where they are named and removed.
    expect(live().filter((entry) => entry.projectId === "p-gone")).toHaveLength(
      2,
    );

    // C.6.4: "Forget them". The panel's sweep is a replaceAll without that
    // project's rows.
    useMemoryStore
      .getState()
      .replaceAll(live().filter((entry) => entry.projectId !== "p-gone"));

    expect(live().map((entry) => entry.text)).toEqual([globalText, liveText]);

    await flushMemoryWrites();
    expect(storedTexts()).toEqual([globalText, liveText]);
  });
});

describe("C.7 — a fact written a second before the window closes", () => {
  it("reaches the document when the shutdown flush runs, debounce or not", async () => {
    const text = "Checking the flush on close";
    useMemoryStore.getState().remember({ text, scope: "global" }, NOW);

    // The write is debounced by 250ms, and the checklist's step 2 — close the
    // window immediately — happens inside that window. Nothing is stored yet.
    expect(storedTexts()).not.toContain(text);

    // What `pagehide` and a hide-to-tray `visibilitychange` call. Its wiring is
    // covered in `distillStoreHydration.test.ts`; what matters here is that
    // the memory store is one of the documents it actually pushes.
    flushDistillStores();
    await flushMemoryWrites();

    expect(storedTexts()).toContain(text);
  });
});
