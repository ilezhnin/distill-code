import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo } from "@/features/projects/api/projects";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";

import {
  formatProjectWikiPrompt,
  knownProjectWikiPresence,
  PROJECT_WIKI_DIR,
  PROJECT_WIKI_INDEX_DOCUMENT,
  PROJECT_WIKI_POINTER_PROMPT,
  projectWikiPromptForRoot,
  readProjectWikiPresence,
  refreshProjectWikiPresence,
  resetProjectWikiPresenceForTests,
  sessionProjectWikiPrompt,
} from "./projectWikiPrompt";

const listProjectDocuments = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/projectStore", () => ({
  listProjectDocuments,
  readProjectDocument: vi.fn(),
  writeProjectDocument: vi.fn(),
}));

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    path: "/projects/p1",
    name: "Quarp",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: ["/work/quarp"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectWikiPresenceForTests();
  listProjectDocuments.mockResolvedValue([]);
  useProjectStore.setState({ projects: [] });
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    activeWorkspaceBySession: {},
  });
});

describe("formatProjectWikiPrompt", () => {
  it("is the pointer and nothing else when the project has a wiki", () => {
    expect(formatProjectWikiPrompt(true)).toBe(
      "This project keeps a knowledge wiki at .distill/wiki/. Read .distill/wiki/index.md before re-exploring the repository. Only the conductor loop updates it.",
    );
  });

  it("says nothing when the project has no wiki", () => {
    expect(formatProjectWikiPrompt(false)).toBeUndefined();
  });

  // The line rides in the cached prefix of every prompt this project sends;
  // anything project-specific in it would bill the operator for a cache miss
  // per turn.
  it("is byte-for-byte the same string on every call", () => {
    const first = formatProjectWikiPrompt(true);
    const second = formatProjectWikiPrompt(true);
    expect(first).toBe(second);
    expect(first).toBe(PROJECT_WIKI_POINTER_PROMPT);
    expect(first).not.toMatch(/\n/);
  });

  // Only the pointer travels: a page or an index row in the prompt is the
  // budget problem this feature exists to avoid.
  it("carries no wiki content", () => {
    expect(PROJECT_WIKI_POINTER_PROMPT.length).toBeLessThan(200);
  });
});

describe("readProjectWikiPresence", () => {
  it("looks for the index in the project's own wiki folder", async () => {
    listProjectDocuments.mockResolvedValue(["index.md", "log.md"]);

    await expect(readProjectWikiPresence("/work/quarp")).resolves.toBe(true);
    expect(listProjectDocuments).toHaveBeenCalledWith(
      "/work/quarp",
      PROJECT_WIKI_DIR,
    );
  });

  it("reports no wiki when the folder holds no index", async () => {
    listProjectDocuments.mockResolvedValue(["log.md"]);

    await expect(readProjectWikiPresence("/work/quarp")).resolves.toBe(false);
  });

  it("reports no wiki when the folder cannot be listed", async () => {
    listProjectDocuments.mockRejectedValue(new Error("drive not mounted"));

    await expect(readProjectWikiPresence("/work/quarp")).resolves.toBe(false);
  });
});

describe("projectWikiPromptForRoot", () => {
  it("says nothing for a root nobody has asked about yet, and schedules the answer", async () => {
    listProjectDocuments.mockResolvedValue([PROJECT_WIKI_INDEX_DOCUMENT]);

    // The send path never waits: an unknown root costs a missing line this
    // turn, never a slower send.
    expect(projectWikiPromptForRoot("/work/quarp")).toBeUndefined();

    await vi.waitFor(() =>
      expect(listProjectDocuments).toHaveBeenCalledWith(
        "/work/quarp",
        PROJECT_WIKI_DIR,
      ),
    );
    await vi.waitFor(() =>
      expect(projectWikiPromptForRoot("/work/quarp")).toBe(
        PROJECT_WIKI_POINTER_PROMPT,
      ),
    );
  });

  it("keeps saying nothing for a project without a wiki", async () => {
    await refreshProjectWikiPresence("/work/quarp");

    expect(projectWikiPromptForRoot("/work/quarp")).toBeUndefined();
  });

  it("has nothing to point at without a root", () => {
    expect(projectWikiPromptForRoot(null)).toBeUndefined();
    expect(projectWikiPromptForRoot("   ")).toBeUndefined();
    expect(listProjectDocuments).not.toHaveBeenCalled();
  });

  it("coalesces concurrent refreshes of one root into a single listing", async () => {
    let release: (names: string[]) => void = () => {};
    listProjectDocuments.mockReturnValue(
      new Promise<string[]>((resolve) => {
        release = resolve;
      }),
    );

    const first = refreshProjectWikiPresence("/work/quarp");
    const second = refreshProjectWikiPresence("/work/quarp");
    release([PROJECT_WIKI_INDEX_DOCUMENT]);
    await Promise.all([first, second]);

    expect(listProjectDocuments).toHaveBeenCalledTimes(1);
  });

  // A wiki written mid-session must start being advertised without a restart.
  it("picks up a wiki that appears after the first look", async () => {
    await refreshProjectWikiPresence("/work/quarp");
    expect(projectWikiPromptForRoot("/work/quarp")).toBeUndefined();

    listProjectDocuments.mockResolvedValue([PROJECT_WIKI_INDEX_DOCUMENT]);

    // Every read schedules another look, so the next turn is the one that
    // starts advertising it.
    await vi.waitFor(() =>
      expect(projectWikiPromptForRoot("/work/quarp")).toBe(
        PROJECT_WIKI_POINTER_PROMPT,
      ),
    );
  });
});

describe("knownProjectWikiPresence", () => {
  it("answers from the cache without scheduling a listing of its own", () => {
    listProjectDocuments.mockResolvedValue([PROJECT_WIKI_INDEX_DOCUMENT]);

    // A caller that owns its own refresh (the open chat's controller) must be
    // able to read the cache during render without stealing that refresh:
    // a coalesced listing would resolve the owner's call with the stale answer.
    expect(knownProjectWikiPresence("/work/quarp")).toBe(false);
    expect(listProjectDocuments).not.toHaveBeenCalled();
  });

  it("reports the wiki once a refresh has recorded it", async () => {
    listProjectDocuments.mockResolvedValue([PROJECT_WIKI_INDEX_DOCUMENT]);
    await refreshProjectWikiPresence("/work/quarp");

    expect(knownProjectWikiPresence("/work/quarp")).toBe(true);
  });

  it("has nothing to report without a root", () => {
    expect(knownProjectWikiPresence(null)).toBe(false);
    expect(knownProjectWikiPresence("   ")).toBe(false);
  });
});

describe("sessionProjectWikiPrompt", () => {
  function seedSession(projectId: string | null): void {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s-1",
          title: "Session",
          projectId,
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
  }

  it("points a project session at its wiki", async () => {
    useProjectStore.setState({ projects: [project()] });
    seedSession("p1");
    listProjectDocuments.mockResolvedValue([PROJECT_WIKI_INDEX_DOCUMENT]);
    await refreshProjectWikiPresence("/work/quarp");

    expect(sessionProjectWikiPrompt("s-1")).toBe(PROJECT_WIKI_POINTER_PROMPT);
  });

  it("says nothing for a session with no project", () => {
    seedSession(null);

    expect(sessionProjectWikiPrompt("s-1")).toBeUndefined();
    expect(listProjectDocuments).not.toHaveBeenCalled();
  });

  it("says nothing for a session whose project the store does not hold", () => {
    seedSession("p-unknown");

    expect(sessionProjectWikiPrompt("s-1")).toBeUndefined();
  });

  it("says nothing for a project with no folder of its own", () => {
    useProjectStore.setState({ projects: [project({ workingDirs: [] })] });
    seedSession("p1");

    expect(sessionProjectWikiPrompt("s-1")).toBeUndefined();
  });
});
