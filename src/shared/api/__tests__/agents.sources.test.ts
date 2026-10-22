import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGooseSourcesCreate = vi.fn();
const mockGooseSourcesList = vi.fn();
const mockGooseSourcesUpdate = vi.fn();
const mockGooseSourcesDelete = vi.fn();

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    host: {
      sourcesCreate: mockGooseSourcesCreate,
      sourcesList: mockGooseSourcesList,
      sourcesUpdate: mockGooseSourcesUpdate,
      sourcesDelete: mockGooseSourcesDelete,
    },
  }),
}));

import {
  BUNDLED_AGENT_MARKER_KEYS,
  agentSourceToPersona,
  promotePersonaSource,
  updatePersonaSource,
} from "@/shared/api/agents";

const draftEntry = {
  type: "agent",
  path: "/Users/x/.agents/agents/draft-abc.md",
  name: "Untitled agent",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true, builderSessionId: "abc" },
  writable: true,
};

describe("persona source helpers", () => {
  beforeEach(() => {
    mockGooseSourcesCreate.mockReset();
    mockGooseSourcesList.mockReset();
    mockGooseSourcesUpdate.mockReset();
    mockGooseSourcesDelete.mockReset();
    vi.restoreAllMocks();
  });

  it("a saved edit to a seeded bundled agent survives the next launch", async () => {
    // Full circle of the operator's lost-ranking bug: the installed bundled
    // file carries `metadata.flockBundled: true`; the startup reseeder
    // overwrites any marked file whose bytes differ from the shipped copy
    // (src-tauri bundled_agents.rs, should_install_agent). Saving an edit
    // must therefore (1) keep the edit and (2) drop the ownership marker so
    // the reseeder treats the file as user-owned and leaves it alone.
    const bundledEntry = {
      ...draftEntry,
      path: "/Users/x/.agents/agents/acceptor.md",
      name: "Acceptor",
      description: "Verifies everything personally.",
      properties: {
        avatar: "app-avatar:gloopies-1",
        good_for: "proving the claim yourself",
        metadata: { flockBundled: true, flockBundledSource: "acceptor" },
      },
    };
    const ranking = JSON.stringify({
      version: 1,
      entries: [
        { platform: "claude-acp", modelId: "claude-fable-5", label: "Fable 5" },
      ],
    });
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [bundledEntry] });
    mockGooseSourcesUpdate.mockImplementationOnce(
      (request: { properties?: Record<string, unknown> }) =>
        Promise.resolve({ source: { ...bundledEntry, ...request } }),
    );

    const saved = await updatePersonaSource(bundledEntry.path, {
      properties: { model_ranking: ranking },
    });

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: {
          avatar: "app-avatar:gloopies-1",
          good_for: "proving the claim yourself",
          // The ownership flag is gone; the role attribution survives — the
          // conductor still resolves this file as the acceptor role.
          metadata: { flockBundledSource: "acceptor" },
          model_ranking: ranking,
        },
      }),
    );

    // Hydration after "restart": the persona built from the stored source
    // still carries the ranking.
    expect(agentSourceToPersona(saved).modelRanking).toBe(ranking);
  });

  it("keeps the previous builds' marker names beside the current one", () => {
    // The app wrote the ownership marker under two earlier names. A mechanical
    // rename that touched them would collapse the list into one repeated key
    // and silently stop releasing files marked by an earlier build.
    expect(BUNDLED_AGENT_MARKER_KEYS[0]).toBe("flockBundled");
    expect(BUNDLED_AGENT_MARKER_KEYS).toHaveLength(3);
    expect(new Set(BUNDLED_AGENT_MARKER_KEYS).size).toBe(
      BUNDLED_AGENT_MARKER_KEYS.length,
    );
  });

  it("a saved edit to a file still marked by an earlier build also takes ownership", async () => {
    // A copy the startup rewrite has not reached (a project-local one, or a
    // root whose rewrite failed) carries the marker under an earlier name.
    // The reseeder recognises that marker too, so the edit has to strip it
    // the same way — while the source attribution survives, under whatever
    // name it was written.
    for (const key of BUNDLED_AGENT_MARKER_KEYS.slice(1)) {
      mockGooseSourcesList.mockReset();
      mockGooseSourcesUpdate.mockReset();
      const bundledEntry = {
        ...draftEntry,
        path: "/Users/x/.agents/agents/acceptor.md",
        name: "Acceptor",
        description: "Verifies everything personally.",
        properties: {
          metadata: { [key]: true, [`${key}Source`]: "acceptor" },
        },
      };
      mockGooseSourcesList.mockResolvedValueOnce({ sources: [bundledEntry] });
      mockGooseSourcesUpdate.mockImplementationOnce(
        (request: { properties?: Record<string, unknown> }) =>
          Promise.resolve({ source: { ...bundledEntry, ...request } }),
      );

      await updatePersonaSource(bundledEntry.path, {
        properties: { good_for: "proving the claim yourself" },
      });

      expect(mockGooseSourcesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: {
            metadata: { [`${key}Source`]: "acceptor" },
            good_for: "proving the claim yourself",
          },
        }),
      );
    }
  });

  it("promotePersonaSource does not delete the draft when final source creation fails", async () => {
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });
    mockGooseSourcesCreate.mockRejectedValueOnce(new Error("create failed"));

    await expect(
      promotePersonaSource(draftEntry.path, {
        name: "Snark",
        properties: {},
      }),
    ).rejects.toThrow("create failed");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Snark",
      description: "Draft",
      content: "Draft in progress.",
      target: { scope: "global" },
      properties: {},
    });
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
    expect(mockGooseSourcesDelete).not.toHaveBeenCalled();
  });

  it("promotePersonaSource returns the promoted source when draft cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const promoted = {
      ...draftEntry,
      path: "/Users/x/.agents/agents/snark.md",
      name: "Snark",
      properties: {},
    };
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });
    mockGooseSourcesCreate.mockResolvedValueOnce({ source: promoted });
    mockGooseSourcesDelete.mockRejectedValueOnce(new Error("delete failed"));

    await expect(
      promotePersonaSource(draftEntry.path, {
        name: "Snark",
        properties: {},
      }),
    ).resolves.toEqual(promoted);

    expect(mockGooseSourcesDelete).toHaveBeenCalledWith({
      type: "agent",
      path: draftEntry.path,
    });
    expect(warn).toHaveBeenCalledWith(
      "Failed to delete promoted agent draft:",
      expect.any(Error),
    );
  });

  it("promotePersonaSource does not delete when create returns the original path", async () => {
    const promoted = {
      ...draftEntry,
      name: "Snark",
      properties: {},
    };
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });
    mockGooseSourcesCreate.mockResolvedValueOnce({ source: promoted });

    await expect(
      promotePersonaSource(draftEntry.path, {
        name: "Snark",
        properties: {},
      }),
    ).resolves.toEqual(promoted);

    expect(mockGooseSourcesDelete).not.toHaveBeenCalled();
  });
});
