import { beforeEach, describe, expect, it, vi } from "vitest";

const chatState = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: string;
    title?: string;
    archivedAt?: string;
    creationState?: "pending" | "failed";
    creationError?: string;
    clientSessionId?: string;
    intent?: "build-agent" | null;
    agentBuilderOpen?: boolean;
    targetAgentPath?: string | null;
    targetAgentSlug?: string | null;
    targetAgentDraftState?: "preparing" | "failed" | null;
    targetAgentDraftSaved?: boolean;
    updatedAt?: string;
  }>,
  hasHydratedSessions: true,
  hasMoreSessions: false,
  messagesBySession: {} as Record<string, unknown[]>,
  draftsBySession: {} as Record<string, string>,
  queuedMessageBySession: {} as Record<string, { text: string }>,
}));

const mocks = vi.hoisted(() => ({
  patchSession: vi.fn(),
  setSkillDrafts: vi.fn(),
  createPersonaSource: vi.fn(),
  deletePersonaSource: vi.fn(),
  promotePersonaSource: vi.fn(),
  listPersonaSources: vi.fn(),
  readAgentSourceFile: vi.fn(),
}));

const sessionListeners = new Set<() => void>();

function notifySessionListeners() {
  for (const listener of sessionListeners) {
    listener();
  }
}

const createNewTab = vi.fn(async (_title?: string) => {
  const session = { id: "sess-1", title: "New agent" };
  chatState.sessions = [session, ...chatState.sessions];
  notifySessionListeners();
  return { id: session.id };
});
const closeSession = vi.fn();
const navigateChat = vi.fn();
const deps = { createNewTab, closeSession, navigateChat };

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: {
    getState: () => ({
      sessions: chatState.sessions,
      hasHydratedSessions: chatState.hasHydratedSessions,
      hasMoreSessions: chatState.hasMoreSessions,
      getSession: (id: string) =>
        chatState.sessions.find((session) => session.id === id),
      patchSession: mocks.patchSession,
    }),
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  },
}));

vi.mock("@/features/chat/stores/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      skillDraftsBySession: {
        "sess-1": [
          { id: "builtin:agent-builder", name: "agent-builder" },
          { id: "skill-1", name: "code-review" },
        ],
      },
      messagesBySession: chatState.messagesBySession,
      draftsBySession: chatState.draftsBySession,
      queuedMessageBySession: chatState.queuedMessageBySession,
      setSkillDrafts: mocks.setSkillDrafts,
    }),
  },
}));

vi.mock("@/shared/api/agents", () => ({
  createPersonaSource: mocks.createPersonaSource,
  deletePersonaSource: mocks.deletePersonaSource,
  promotePersonaSource: mocks.promotePersonaSource,
  listPersonaSources: mocks.listPersonaSources,
  readAgentSourceFile: mocks.readAgentSourceFile,
}));

vi.mock("@/features/runtime-config/defaults", () => ({
  getDefaultGooseModelId: () => "goose-gpt-5-5",
  getDefaultGooseModelProviderId: () => "databricks_v2",
}));

import {
  deleteDraftAgentSession,
  hasAgentBuilderSessionUserContent,
  isEmptyDraftAgentSession,
  promoteDraft,
  reconcileAgentBuilderSessions,
  saveDraftAgentSession,
  setAgentBuilderSessionLocalEdits,
  setAgentBuilderSessionSaveHandler,
  startAgentBuilderSession,
} from "../agentBuilderSession";
import { resetAgentBuilderSourceLifecycleForTests } from "../agentBuilderSourceLifecycle";
import { useAgentStore } from "@/features/agents/stores/agentStore";

const draftSource = {
  type: "agent",
  path: "/Users/x/.agents/agents/draft-sess-1.md",
  name: "Untitled agent sess-1",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true, builderSessionId: "sess-1" },
  writable: true,
};

function patchSessionState(
  id: string,
  patch: Partial<(typeof chatState.sessions)[number]>,
) {
  chatState.sessions = chatState.sessions.map((session) =>
    session.id === id ? { ...session, ...patch } : session,
  );
  notifySessionListeners();
}

function addBuilderSession(
  patch: Partial<(typeof chatState.sessions)[number]> = {},
) {
  chatState.sessions = [
    {
      id: "sess-1",
      title: "New agent",
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: draftSource.path,
      targetAgentSlug: "draft-sess-1",
      ...patch,
    },
  ];
}

async function flushDraftPreparation() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("agentBuilderSession", () => {
  beforeEach(() => {
    sessionListeners.clear();
    chatState.sessions = [];
    chatState.hasHydratedSessions = true;
    chatState.hasMoreSessions = false;
    chatState.messagesBySession = {};
    chatState.draftsBySession = {};
    chatState.queuedMessageBySession = {};
    mocks.createPersonaSource.mockReset();
    mocks.deletePersonaSource.mockReset();
    mocks.promotePersonaSource.mockReset();
    mocks.listPersonaSources.mockReset();
    mocks.readAgentSourceFile.mockReset();
    mocks.readAgentSourceFile.mockImplementation(
      async (_path: string, fallback: unknown) => fallback,
    );
    mocks.patchSession.mockReset();
    mocks.patchSession.mockImplementation(patchSessionState);
    mocks.setSkillDrafts.mockReset();
    createNewTab.mockClear();
    closeSession.mockClear();
    navigateChat.mockClear();
    resetAgentBuilderSourceLifecycleForTests();
    setAgentBuilderSessionLocalEdits("sess-1", false);
    window.localStorage.clear();
    useAgentStore.getState().setProviders([], false);
  });

  it("creates the draft source after an optimistic session promotes", async () => {
    createNewTab.mockImplementationOnce(async () => {
      chatState.sessions = [
        {
          id: "local-session",
          title: "New agent",
          creationState: "pending",
          clientSessionId: "local-session",
        },
      ];
      notifySessionListeners();
      return { id: "local-session" };
    });
    mocks.createPersonaSource.mockResolvedValue({
      ...draftSource,
      path: "/Users/x/.agents/agents/draft-backend-session.md",
      properties: { draft: true, builderSessionId: "backend-session" },
    });

    const id = await startAgentBuilderSession({}, deps);

    expect(id).toBe("local-session");
    expect(mocks.createPersonaSource).not.toHaveBeenCalled();
    expect(chatState.sessions[0]).toMatchObject({
      id: "local-session",
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentDraftState: "preparing",
    });

    chatState.sessions = [
      {
        id: "backend-session",
        title: "New agent",
        clientSessionId: "local-session",
        intent: "build-agent",
        agentBuilderOpen: true,
        targetAgentPath: null,
        targetAgentSlug: null,
        targetAgentDraftState: "preparing",
      },
    ];
    notifySessionListeners();
    await flushDraftPreparation();

    expect(mocks.createPersonaSource).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          builderSessionId: "backend-session",
        }),
      }),
    );
    expect(mocks.patchSession).toHaveBeenCalledWith("backend-session", {
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: "/Users/x/.agents/agents/draft-backend-session.md",
      targetAgentSlug: "draft-backend-session",
      targetAgentDraftState: null,
      targetAgentDraftSaved: false,
    });
  });

  it("saveDraftAgentSession keeps failed local edits queued", async () => {
    addBuilderSession();
    setAgentBuilderSessionSaveHandler("sess-1", () => false);

    await expect(saveDraftAgentSession("sess-1")).rejects.toThrow(
      "Failed to save local agent draft edits.",
    );

    expect(mocks.listPersonaSources).not.toHaveBeenCalled();
  });

  it("deleteDraftAgentSession fails before closing when the draft cannot be deleted", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.readAgentSourceFile.mockResolvedValue(draftSource);
    mocks.deletePersonaSource.mockRejectedValue(new Error("disk locked"));

    await expect(
      deleteDraftAgentSession("sess-1", { closeSession }),
    ).rejects.toThrow("disk locked");

    expect(closeSession).not.toHaveBeenCalled();
    expect(mocks.patchSession).not.toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ intent: null }),
    );
  });

  it("promoteDraft promotes the current draft source and clears builder mode", async () => {
    addBuilderSession();
    const editedDraft = {
      ...draftSource,
      name: "Code reviewer",
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        provider: "openai",
      },
    };
    mocks.listPersonaSources.mockResolvedValue([editedDraft]);
    mocks.promotePersonaSource.mockResolvedValue({
      ...editedDraft,
      path: "/Users/x/.agents/agents/code-reviewer.md",
      properties: { provider: "openai" },
    });

    const promoted = await promoteDraft("sess-1");

    expect(promoted).toMatchObject({
      path: "/Users/x/.agents/agents/code-reviewer.md",
    });
    expect(mocks.promotePersonaSource).toHaveBeenCalledWith(
      draftSource.path,
      expect.objectContaining({
        name: "Code reviewer",
        properties: {
          draft: true,
          builderSessionId: "sess-1",
          provider: "openai",
        },
      }),
    );
    expect(chatState.sessions[0]).toMatchObject({
      intent: null,
      targetAgentPath: null,
      targetAgentSlug: null,
    });
  });

  it("isEmptyDraftAgentSession checks fresh file contents before returning true", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.readAgentSourceFile.mockResolvedValue({
      ...draftSource,
      name: "Constructive Critic",
      content: "Give useful critique.",
    });

    await expect(isEmptyDraftAgentSession("sess-1")).resolves.toBe(false);
    expect(mocks.readAgentSourceFile).toHaveBeenCalledWith(
      draftSource.path,
      draftSource,
    );
  });

  it("isEmptyDraftAgentSession is conservative when the draft file cannot be read", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.readAgentSourceFile.mockRejectedValue(new Error("unavailable"));

    await expect(isEmptyDraftAgentSession("sess-1")).resolves.toBe(false);
  });

  it("treats unsaved local edits as agent builder user content", async () => {
    addBuilderSession();
    mocks.listPersonaSources.mockResolvedValue([draftSource]);
    mocks.readAgentSourceFile.mockResolvedValue(draftSource);
    setAgentBuilderSessionLocalEdits("sess-1", true);

    await expect(hasAgentBuilderSessionUserContent("sess-1")).resolves.toBe(
      true,
    );
  });

  it("delayed reconciliation does not reopen a builder closed in the meantime", async () => {
    let resolveSources!: (sources: (typeof draftSource)[]) => void;
    mocks.listPersonaSources.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSources = resolve;
        }),
    );
    chatState.sessions = [
      { id: "sess-1", intent: "build-agent", agentBuilderOpen: true },
    ];

    const reconciliation = reconcileAgentBuilderSessions();
    patchSessionState("sess-1", { agentBuilderOpen: false });
    resolveSources([draftSource]);
    await reconciliation;

    expect(chatState.sessions[0]).toMatchObject({
      agentBuilderOpen: false,
      targetAgentPath: draftSource.path,
    });
  });

  it("startup cleanup deletes only unchanged placeholder drafts for known-dead sessions", async () => {
    const realDraft = {
      ...draftSource,
      path: "/Users/x/.agents/agents/real-draft.md",
      name: "Constructive Critic",
      content: "Push back constructively.",
      properties: { draft: true, builderSessionId: "dead-real" },
    };
    mocks.listPersonaSources.mockResolvedValue([draftSource, realDraft]);
    mocks.readAgentSourceFile.mockResolvedValue(draftSource);

    await reconcileAgentBuilderSessions();

    expect(mocks.deletePersonaSource).toHaveBeenCalledTimes(1);
    expect(mocks.deletePersonaSource).toHaveBeenCalledWith(draftSource.path);
    expect(mocks.deletePersonaSource).not.toHaveBeenCalledWith(realDraft.path);
  });

  it("startup cleanup waits until session hydration proves a session is dead", async () => {
    chatState.hasMoreSessions = true;
    mocks.listPersonaSources.mockResolvedValue([draftSource]);

    await reconcileAgentBuilderSessions();

    expect(mocks.deletePersonaSource).not.toHaveBeenCalled();
  });
});
