import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAppNavigationController,
  registerAppNavigationController,
} from "@/features/distillctl/bridge/appNavigationController";
import {
  dispatchCommand,
  TOOL_GROUPS,
} from "@/features/distillctl/commands/registry";
import {
  CommandError,
  type AppCommand,
} from "@/features/distillctl/commands/types";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import {
  applyPendingSessionWorkspaceActivation,
  getPendingSessionWorkspaceActivation,
  queueSessionWorkspaceActivation,
} from "@/features/chat/lib/sessionWorkspaceActivation";
import {
  useChatSessionStore,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { ModelOption } from "@/features/chat/types";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { DEFAULT_PROJECT_COLOR } from "@/features/projects/lib/projectDefaults";
import { DEFAULT_PROJECT_ICON } from "@/features/projects/lib/projectIcons";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import { createUserMessage } from "@/shared/types/messages";

const mocks = vi.hoisted(() => ({
  acpCreateSession: vi.fn(),
  acpDuplicateSession: vi.fn(),
  acpGetSessionInfo: vi.fn(),
  acpListSessionsPage: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSendMessage: vi.fn(),
  loadSessionMessages: vi.fn(),
  acpSteerMessage: vi.fn(),
  discoverAcpProviders: vi.fn(),
  runDoctor: vi.fn(),
  readinessFromReport: vi.fn(),
  lastSessionMessages: vi.fn(),
  updateSessionTitle: vi.fn(),
  moveSessionToProject: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  archiveProject: vi.fn(),
  updateProject: vi.fn(),
  resolveSessionCwd: vi.fn(),
  planProjectChatWorkspaces: vi.fn(),
  planProjectChatWorkspacesAsIs: vi.fn(),
  projectRequiresStartupWorkspaceName: vi.fn(),
  rollbackProjectChatWorkspacePlan: vi.fn(),
  resolvePath: vi.fn(),
  checkDirectoriesExist: vi.fn(),
  canonicalizeAuthorizedWorkspaceDirectory: vi.fn(),
  getGitState: vi.fn(),
  getHomeDir: vi.fn(),
  updateWorkingDir: vi.fn(),
  createPersona: vi.fn(),
  listPersonas: vi.fn(),
  createSkill: vi.fn(),
  listSkills: vi.fn(),
  terminalChatSessionIds: new Set<string>(),
}));

vi.mock("@/features/terminal/lib/terminalSessionManager", () => ({
  getChatSessionIdsWithTerminals: () => mocks.terminalChatSessionIds,
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mocks.acpCreateSession(...args),
  acpDuplicateSession: (...args: unknown[]) =>
    mocks.acpDuplicateSession(...args),
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
  acpSendMessage: (...args: unknown[]) => {
    const result = mocks.acpSendMessage(...args);
    const options = args[2] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    options?.onPromptDispatching?.();
    options?.onPromptDispatched?.();
    return result;
  },
  acpSteerMessage: (...args: unknown[]) => mocks.acpSteerMessage(...args),
  discoverAcpProviders: (...args: unknown[]) =>
    mocks.discoverAcpProviders(...args),
}));

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  loadSessionMessages: (...args: unknown[]) =>
    mocks.loadSessionMessages(...args),
}));

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  renameSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
  updateWorkingDir: (
    sessionId: string,
    path: string,
    beforeUpdate?: () => void,
  ) => {
    beforeUpdate?.();
    return mocks.updateWorkingDir(sessionId, path);
  },
}));

vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
}));

vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    getHomeDir: (...args: unknown[]) => mocks.getHomeDir(...args),
  };
});

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: (...args: unknown[]) => mocks.resolvePath(...args),
  checkDirectoriesExist: (...args: unknown[]) =>
    mocks.checkDirectoriesExist(...args),
  canonicalizeAuthorizedWorkspaceDirectory: (...args: unknown[]) =>
    mocks.canonicalizeAuthorizedWorkspaceDirectory(...args),
}));

vi.mock("@/shared/api/sessionSearch", () => ({
  lastSessionMessages: (...args: unknown[]) =>
    mocks.lastSessionMessages(...args),
}));

vi.mock("@/shared/api/doctor", () => ({
  runDoctor: (...args: unknown[]) => mocks.runDoctor(...args),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  readinessFromReport: (...args: unknown[]) =>
    mocks.readinessFromReport(...args),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: (...args: unknown[]) => mocks.updateSessionTitle(...args),
  moveSessionToProject: (...args: unknown[]) =>
    mocks.moveSessionToProject(...args),
}));

vi.mock("@/features/projects/api/projects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/projects/api/projects")>();
  return {
    normalizeProjectWorkspaces: actual.normalizeProjectWorkspaces,
    projectWorkspaceFromDirectory: actual.projectWorkspaceFromDirectory,
    listProjects: (...args: unknown[]) => mocks.listProjects(...args),
    createProject: (...args: unknown[]) => mocks.createProject(...args),
    archiveProject: (...args: unknown[]) => mocks.archiveProject(...args),
    updateProject: (...args: unknown[]) => mocks.updateProject(...args),
    deleteProject: vi.fn(),
    reorderProjects: vi.fn(),
  };
});

vi.mock("@/features/projects/lib/sessionCwdSelection", () => ({
  resolveSessionCwd: (...args: unknown[]) => mocks.resolveSessionCwd(...args),
}));

vi.mock("@/features/projects/lib/projectChatWorkspaces", () => ({
  planProjectChatWorkspaces: (...args: unknown[]) =>
    mocks.planProjectChatWorkspaces(...args),
  planProjectChatWorkspacesAsIs: (...args: unknown[]) =>
    mocks.planProjectChatWorkspacesAsIs(...args),
  projectRequiresStartupWorkspaceName: (...args: unknown[]) =>
    mocks.projectRequiresStartupWorkspaceName(...args),
  rollbackProjectChatWorkspacePlan: (...args: unknown[]) =>
    mocks.rollbackProjectChatWorkspacePlan(...args),
}));

vi.mock("@/shared/api/agents", () => ({
  createPersona: (...args: unknown[]) => mocks.createPersona(...args),
  listPersonas: (...args: unknown[]) => mocks.listPersonas(...args),
}));

vi.mock("@/features/skills/api/skills", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/skills/api/skills")>();
  return {
    // Real predicate: the skills feature owns the id encoding.
    isProjectSkillId: actual.isProjectSkillId,
    createSkill: (...args: unknown[]) => mocks.createSkill(...args),
    listSkills: (...args: unknown[]) => mocks.listSkills(...args),
  };
});

const ctx = {};

const controller = {
  openSession: vi.fn(),
  archiveSession: vi.fn(),
  getAppContext: vi.fn(),
};

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 2,
    ...overrides,
  };
}

function makeAcpSession(
  overrides: Partial<AcpSessionInfo> = {},
): AcpSessionInfo {
  return {
    sessionId: "session-1",
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 2,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...overrides,
  };
}

function mockSessionPages(...pages: AcpSessionsPage[]): void {
  mocks.acpListSessionsPage.mockReset();
  for (const page of pages) {
    mocks.acpListSessionsPage.mockResolvedValueOnce(page);
  }
  mocks.acpListSessionsPage.mockResolvedValue({
    sessions: [],
    nextCursor: null,
  });
}

function mockSessionFound(overrides: Partial<AcpSessionInfo> = {}): void {
  const session = makeAcpSession({ sessionId: "session-1", ...overrides });
  mocks.acpGetSessionInfo.mockResolvedValue(session);
  mockSessionPages({ sessions: [session], nextCursor: null });
}

function seedSessions(...sessions: ChatSession[]): void {
  useChatSessionStore.setState({ sessions, hasHydratedSessions: true });
}

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/sources/project-1",
    name: "Project One",
    description: "A test project",
    prompt: "",
    icon: DEFAULT_PROJECT_ICON,
    color: DEFAULT_PROJECT_COLOR,
    projectWorkspaces: [],
    workingDirs: ["/projects/one"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

/** Seed a fresh (non-stale) model cache entry so list/validate paths never
 *  reach the network; merges with the entries seeded in beforeEach. */
function seedModelCache(cacheKey: string, modelIds: string[]): void {
  useProviderModelCacheStore.setState((state) => {
    const providers = new Map(state.providers);
    providers.set(cacheKey, {
      providerId: cacheKey,
      models: modelIds.map((id) => ({ id, name: id })),
      fetchedAt: Date.now(),
    });
    return { providers };
  });
}

/** Seed inventory rows that carry what each model offers, the shape the
 *  host inventory maps to. */
function seedModelRows(cacheKey: string, rows: ModelOption[]): void {
  useProviderModelCacheStore.setState((state) => {
    const providers = new Map(state.providers);
    providers.set(cacheKey, {
      providerId: cacheKey,
      models: rows,
      fetchedAt: Date.now(),
    });
    return { providers };
  });
}

const CODEX_ROWS: ModelOption[] = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    group: "main",
    efforts: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
      { id: "xhigh", name: "Extra High" },
    ],
    defaultEffort: "high",
    supportsFast: true,
    capabilitySource: "probed",
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3-Codex-Spark",
    group: "main",
    efforts: [],
    supportsFast: false,
    capabilitySource: "probed",
  },
];

async function expectCommandError(
  promise: Promise<unknown>,
  code: string,
): Promise<CommandError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected rejection with code "${code}"`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).code).toBe(code);
  return error as CommandError;
}

beforeEach(() => {
  resetSessionTargetCoordinatorsForTests();
  mocks.terminalChatSessionIds.clear();
  localStorage.removeItem("distill:chat-workspace-metadata");
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
  });
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
    draftsBySession: {},
    skillDraftsBySession: {},
    activeSessionId: null,
    isViewingActiveSession: false,
    isConnected: false,
    loadingSessionIds: new Set(),
    scrollTargetMessageBySession: {},
  });
  useProjectStore.setState({
    projects: [],
    loading: false,
    hasFetchedProjects: false,
  });
  useAgentStore.setState({ personas: [], agents: [], activeAgentId: null });
  useProviderModelCacheStore.setState({
    providers: new Map(),
    refreshingProviderIds: new Set(),
  });

  window.localStorage.clear();
  setMultiWorkspaceEnabled(true);
  vi.clearAllMocks();
  mocks.acpGetSessionInfo.mockReset();
  mocks.acpListSessionsPage.mockReset();
  mocks.resolveSessionCwd.mockResolvedValue("/resolved/cwd");
  mocks.projectRequiresStartupWorkspaceName.mockReturnValue(false);
  mocks.planProjectChatWorkspaces.mockResolvedValue(null);
  mocks.planProjectChatWorkspacesAsIs.mockReturnValue(null);
  mocks.rollbackProjectChatWorkspacePlan.mockResolvedValue(undefined);
  mocks.acpCreateSession.mockResolvedValue({ sessionId: "session-new" });
  mocks.acpGetSessionInfo.mockRejectedValue(
    Object.assign(new Error("Resource not found"), { code: -32002 }),
  );
  mocks.acpPrepareSession.mockResolvedValue(undefined);
  mocks.acpSendMessage.mockResolvedValue(undefined);
  mocks.loadSessionMessages.mockResolvedValue(true);
  mocks.acpSteerMessage.mockResolvedValue({
    runId: "run-steered",
    messageId: "steer-message",
  });
  mocks.discoverAcpProviders.mockResolvedValue([
    { id: "claude-acp", label: "Claude Code" },
    { id: "codex-acp", label: "Codex" },
  ]);
  mocks.runDoctor.mockResolvedValue({ checks: [] });
  mocks.readinessFromReport.mockReturnValue(
    new Map([
      ["claude-acp", "ready"],
      ["codex-acp", "ready"],
    ]),
  );
  mocks.lastSessionMessages.mockResolvedValue([]);
  mocks.acpListSessionsPage.mockResolvedValue({
    sessions: [],
    nextCursor: null,
  });
  mocks.listProjects.mockResolvedValue([]);
  mocks.listPersonas.mockResolvedValue([]);
  mocks.listSkills.mockResolvedValue([]);
  mocks.updateSessionTitle.mockResolvedValue(undefined);
  mocks.moveSessionToProject.mockResolvedValue(undefined);
  mocks.updateProject.mockImplementation(
    async (project: ProjectInfo, updates: Partial<ProjectInfo>) => ({
      ...project,
      ...updates,
    }),
  );
  mocks.resolvePath.mockImplementation(
    async ({ parts }: { parts: string[] }) => ({ path: parts[0] }),
  );
  mocks.checkDirectoriesExist.mockResolvedValue([]);
  mocks.getHomeDir.mockReset().mockResolvedValue("/Users/me");
  mocks.getGitState.mockResolvedValue({
    isGitRepo: true,
    currentBranch: "main",
    dirtyFileCount: 0,
    incomingCommitCount: 0,
    worktrees: [],
    isWorktree: false,
    mainWorktreePath: null,
    localBranches: ["main"],
  });
  mocks.updateWorkingDir.mockImplementation(
    async (
      _sessionId: string,
      _workingDir: string,
      beforeUpdate?: () => void,
    ) => {
      beforeUpdate?.();
    },
  );

  controller.openSession.mockResolvedValue({ ok: true });
  controller.archiveSession.mockResolvedValue({ ok: true });
  controller.getAppContext.mockReturnValue({
    view: "home",
    activeSessionId: null,
    activeProjectId: null,
  });
  registerAppNavigationController(controller);
});

afterEach(() => {
  clearAppNavigationController();
});

describe("dispatchCommand", () => {
  it("rejects prototype-chain keys at both group and action level", async () => {
    // TOOL_GROUPS and the action maps are plain objects: these names resolve
    // to inherited members and must not bypass the unknown checks.
    for (const name of ["constructor", "__proto__", "toString"]) {
      await expectCommandError(
        dispatchCommand(name, { action: "list" }, ctx),
        "unknown_command",
      );
    }
    for (const action of ["constructor", "__proto__", "toString"]) {
      await expectCommandError(
        dispatchCommand("sessions", { action }, ctx),
        "unknown_action",
      );
    }
  });

  it("prefers the broker-resolved deadline from ctx over the static timeout", async () => {
    // A request timeout_ms override changes the broker deadline; dispatch
    // must honor the forwarded value instead of recomputing its own.
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi" },
        { deadlineMs: now + 1_000 },
      ),
      "timed_out",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe("action schemas", () => {
  it("every action schema rejects unknown keys (derived from the registry)", () => {
    const validArgs: Record<string, Record<string, unknown>> = {
      "sessions.create": { prompt: "hi" },
      "sessions.send": { session_id: "s1", prompt: "hi" },
      "sessions.open": { session_id: "s1" },
      "sessions.list": {},
      "sessions.get": { session_id: "s1" },
      "sessions.rename": { session_id: "s1", title: "Title" },
      "sessions.move": { session_id: "s1", project_id: "p1" },
      "sessions.clear_project": { session_id: "s1" },
      "folders.attach": { session_id: "s1", path: "/tmp/wt" },
      "folders.detach": { session_id: "s1", path: "/tmp/wt" },
      "folders.replace": {
        session_id: "s1",
        old_path: "/tmp/old",
        new_path: "/tmp/new",
      },
      "folders.set_cwd": { session_id: "s1", path: "/tmp/wt" },
      "folders.list": { session_id: "s1" },
      "sessions.fork": { session_id: "s1" },
      "sessions.archive": { session_id: "s1" },
      "projects.create": { name: "Project" },
      "projects.list": {},
      "projects.get": { project_id: "p1" },
      "projects.set_startup_mode": { project_id: "p1", mode: "worktree" },
      "projects.archive": { project_id: "p1" },
      "agents.create": { name: "Agent", system_prompt: "Be helpful" },
      "agents.list": {},
      "skills.create": { name: "Skill", description: "Does X", content: "#" },
      "skills.list": {},
      "skills.get": { skill_id: "global:/skills/x" },
      "info.list_harnesses": {},
      "info.list_models": {},
      "info.get_context": {},
    };

    for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
      for (const [actionName, command] of Object.entries(group.actions)) {
        const key = `${groupName}.${actionName}`;
        const args = validArgs[key];
        // A missing fixture fails loudly instead of skipping coverage.
        expect(args, `missing valid-args fixture for ${key}`).toBeDefined();
        const schema = (command as AppCommand<unknown, unknown>).schema;
        expect(schema.safeParse(args).success, `${key} valid args`).toBe(true);
        expect(
          schema.safeParse({ ...args, unexpected: true }).success,
          `${key} unknown key`,
        ).toBe(false);
      }
    }
  });
});

describe("command safety metadata", () => {
  it("keeps mutations visible and marks no command destructive", () => {
    // v1 has no auth: the broker accepts any same-user process, so no
    // command may carry a destructive escape hatch (session archive lost
    // its --discard-changes effect for exactly that reason).
    for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
      for (const [actionName, command] of Object.entries(group.actions)) {
        const key = `${groupName}.${actionName}`;
        const metadata = command as AppCommand<unknown, unknown>;

        expect(metadata.destructive, `${key} destructive`).toBe(false);
        expect(
          ["read", "create", "update", "archive"],
          `${key} effect`,
        ).toContain(metadata.effect);
        expect(
          ["none", "immediate", "discoverable"],
          `${key} visibility`,
        ).toContain(metadata.visibility);
        if (metadata.effect !== "read") {
          expect(metadata.visibility, `${key} mutation visibility`).not.toBe(
            "none",
          );
        }
      }
    }
  });
});

describe("sessions.create", () => {
  it("creates the session and leaves the accepted first prompt in the shared queue", async () => {
    seedModelCache("databricks_v2", ["model-9"]);
    mocks.listPersonas.mockResolvedValue([
      {
        id: "agent-7",
        displayName: "Reviewer",
        systemPrompt: "Review the work carefully.",
        isBuiltin: false,
        writable: true,
      },
    ]);
    // A foreground agent on another provider must not leak into the
    // background send's pending-assistant hint.
    useAgentStore.setState({
      agents: [
        {
          id: "fg-agent",
          name: "Foreground",
          provider: "claude-acp",
          model: "claude",
          connectionType: "acp",
          status: "online",
          isBuiltin: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      activeAgentId: "fg-agent",
    });

    const result = await dispatchCommand(
      "sessions",
      {
        action: "create",
        prompt: "what is 1+1",
        agent_id: "agent-7",
        model_id: "model-9",
        from: "the test orchestrator",
      },
      ctx,
    );

    expect(mocks.resolveSessionCwd).toHaveBeenCalledWith(null);
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "claude-acp",
      "/resolved/cwd",
      {
        personaId: "agent-7",
        modelId: "model-9",
        projectId: undefined,
      },
    );
    expect(result).toEqual({
      session_id: "session-new",
      title: DEFAULT_CHAT_TITLE,
      harness_id: "claude-acp",
      model_id: "model-9",
      effort: null,
      fast_mode: null,
      send_status: "dispatched",
    });

    const queued =
      useChatStore.getState().queuedMessageBySession["session-new"];
    expect(queued?.[0]).toMatchObject({
      kind: "transport-ready",
      payload: {
        text: "what is 1+1",
        sendOptions: {
          userMessageMetadata: {
            origin: "distillctl_cross_session",
            distillSenderLabel: "the test orchestrator",
          },
          acpPromptMetadata: {
            origin: "distillctl_cross_session",
            distillSenderLabel: "the test orchestrator",
          },
        },
      },
    });
    expect(controller.openSession).not.toHaveBeenCalled();
  });

  it("rejects a harness that is installed but not ready", async () => {
    mocks.readinessFromReport.mockReturnValue(
      new Map([["codex-acp", "not_installed"]]),
    );

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", harness_id: "codex-acp" },
        ctx,
      ),
      "harness_not_ready",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("rejects a model the harness does not list with model_not_found", async () => {
    seedModelCache("codex-acp", ["gpt-6"]);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "create",
          prompt: "hi",
          harness_id: "codex-acp",
          model_id: "nope",
        },
        ctx,
      ),
      "model_not_found",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();

    // A listed model passes.
    await dispatchCommand(
      "sessions",
      {
        action: "create",
        prompt: "hi",
        harness_id: "codex-acp",
        model_id: "gpt-6",
      },
      ctx,
    );
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "codex-acp",
      "/resolved/cwd",
      expect.objectContaining({ modelId: "gpt-6" }),
    );
  });

  it("refuses an effort the chosen model does not offer and names what it does", async () => {
    seedModelRows("codex-acp", CODEX_ROWS);

    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "create",
          prompt: "hi",
          harness_id: "codex-acp",
          model_id: "gpt-5.6-sol",
          effort: "ultra",
        },
        ctx,
      ),
      "effort_not_available",
    );
    expect(error.message).toContain("low, high, xhigh");
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("refuses fast mode on a model without it with fast_not_supported", async () => {
    seedModelRows("codex-acp", CODEX_ROWS);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "create",
          prompt: "hi",
          harness_id: "codex-acp",
          model_id: "gpt-5.3-codex-spark",
          fast_mode: true,
        },
        ctx,
      ),
      "fast_not_supported",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("hands an offered effort and fast mode to session creation instead of patching them on afterwards", async () => {
    seedModelRows("codex-acp", CODEX_ROWS);
    const store = useChatSessionStore.getState();
    const createSession = vi.fn(store.createSession);
    const patchSession = vi.fn(store.patchSession);
    useChatSessionStore.setState({ createSession, patchSession });

    let result: unknown;
    try {
      result = await dispatchCommand(
        "sessions",
        {
          action: "create",
          prompt: "hi",
          harness_id: "codex-acp",
          model_id: "gpt-5.6-sol",
          effort: "xhigh",
          fast_mode: true,
        },
        ctx,
      );
    } finally {
      useChatSessionStore.setState({
        createSession: store.createSession,
        patchSession: store.patchSession,
      });
    }

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runSettings: { effort: "xhigh", fast: true },
      }),
    );
    // The first turn runs on them because they travel in `session/new`.
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "codex-acp",
      "/resolved/cwd",
      expect.objectContaining({
        modelId: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
    expect(
      patchSession.mock.calls.some(
        ([, patch]) => patch && "desiredRunSettings" in patch,
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      model_id: "gpt-5.6-sol",
      effort: "xhigh",
      fast_mode: true,
    });
    expect(result).not.toHaveProperty("deprecated");
    expect(
      useChatSessionStore.getState().getSession("session-new")
        ?.desiredRunSettings,
    ).toEqual({ effort: "xhigh", fast: true });
  });

  it("splits a legacy folded model id and answers with a deprecated note", async () => {
    seedModelRows("codex-acp", CODEX_ROWS);

    const result = (await dispatchCommand(
      "sessions",
      {
        action: "create",
        prompt: "hi",
        harness_id: "codex-acp",
        model_id: "gpt-5.6-sol[xhigh]",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "codex-acp",
      "/resolved/cwd",
      expect.objectContaining({ modelId: "gpt-5.6-sol" }),
    );
    expect(result).toMatchObject({
      model_id: "gpt-5.6-sol",
      effort: "xhigh",
      fast_mode: null,
    });
    expect(result.deprecated).toContain(
      "--model-id gpt-5.6-sol --effort xhigh",
    );
    expect(
      useChatSessionStore.getState().getSession("session-new")
        ?.desiredRunSettings,
    ).toEqual({ effort: "xhigh" });
  });

  it("requires startup_name for a project with branch/worktree startup", async () => {
    const project = makeProject({ id: "project-1" });
    useProjectStore.setState({ projects: [project], hasFetchedProjects: true });
    mocks.listProjects.mockResolvedValue([project]);
    mocks.projectRequiresStartupWorkspaceName.mockReturnValue(true);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", project_id: "project-1" },
        ctx,
      ),
      "workspace_name_required",
    );
    expect(mocks.planProjectChatWorkspaces).not.toHaveBeenCalled();
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("does not create when validation stalls past the broker deadline", async () => {
    // findReadyHarnessOrThrow consults the doctor; stall it past the deadline.
    const start = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(start);
    mocks.runDoctor.mockImplementation(async () => {
      nowSpy.mockReturnValue(start + 901_000);
      return { checks: [] };
    });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", harness_id: "codex-acp" },
        ctx,
      ),
      "timed_out",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe("sessions.send", () => {
  it("does not inject a prompt when history hydration fails", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockResolvedValueOnce(false);

    await expect(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "what changed in ci?",
        },
        ctx,
      ),
    ).rejects.toThrow("Failed to load the target session before sending.");

    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
  });

  it.each([
    { chatState: "streaming" as const, cancellationPending: false },
    { chatState: "idle" as const, cancellationPending: true },
  ])("refuses a target with chat=$chatState cancellation=$cancellationPending by default", async ({
    chatState,
    cancellationPending,
  }) => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", chatState);
    useChatStore
      .getState()
      .setRunCancellationPending("session-1", cancellationPending);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "follow up",
        },
        ctx,
      ),
      "target_session_running",
    );

    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("queues exactly once if the target acquires a run before commit", async () => {
    let newerOwnerRuntime: unknown;
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      return true;
    });
    mocks.acpSendMessage.mockImplementationOnce(() => {
      useChatStore.getState().setError("session-1", "newer owner error");
      useChatStore.getState().setChatState("session-1", "streaming");
      useChatStore
        .getState()
        .setPendingAssistantProvider("session-1", "newer-provider");
      useChatStore.getState().setActiveRunId("session-1", "racing-run");
      useChatStore.getState().setRunCancellationPending("session-1", true);
      newerOwnerRuntime = structuredClone(
        useChatStore.getState().getSessionRuntime("session-1"),
      );
      return Promise.resolve();
    });

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "preserve this prompt",
        if_running: "queue",
      },
      ctx,
    );

    expect(result).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["preserve this prompt"]);
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
    expect(useChatStore.getState().getSessionRuntime("session-1")).toEqual(
      newerOwnerRuntime,
    );
  });

  it("truthfully refuses if a composer message takes queue ownership before commit", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      return true;
    });
    mocks.acpSendMessage.mockImplementationOnce(() => {
      useChatStore.getState().enqueueTransportReadyMessage("session-1", {
        persona: { kind: "inherit" },
        text: "composer head",
      });
      return Promise.resolve();
    });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "do not jump the head",
        },
        ctx,
      ),
      "target_session_running",
    );

    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["composer head"]);
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
  });

  it("accepts a repeated delivery id without queueing another user turn", async () => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", "streaming");

    const first = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "monitor event",
        if_running: "queue",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );
    const duplicate = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "monitor event retried",
        if_running: "queue",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );

    expect(first).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(duplicate).toEqual({
      session_id: "session-1",
      send_status: "deduplicated",
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toHaveLength(1);
  });

  it("serializes concurrent admission of the same delivery id", async () => {
    const session = makeAcpSession({
      sessionId: "session-1",
      providerId: "codex-acp",
    });
    let releaseLoads: (() => void) | undefined;
    const loadsReleased = new Promise<void>((resolve) => {
      releaseLoads = resolve;
    });
    let loadCount = 0;
    mocks.acpGetSessionInfo.mockImplementation(async () => {
      loadCount += 1;
      await loadsReleased;
      return session;
    });

    const send = (prompt: string) =>
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt,
          if_running: "queue",
          delivery_id: "monitor-event-1",
        },
        ctx,
      );
    const first = send("monitor event");
    const retry = send("monitor event retried concurrently");
    await vi.waitFor(() => expect(loadCount).toBe(2));
    releaseLoads?.();

    await expect(Promise.all([first, retry])).resolves.toEqual([
      { session_id: "session-1", send_status: "dispatched" },
      { session_id: "session-1", send_status: "deduplicated" },
    ]);
    expect(
      (useChatStore.getState().messagesBySession["session-1"] ?? []).length +
        (useChatStore.getState().queuedMessageBySession["session-1"]?.length ??
          0),
    ).toBe(1);
  });

  it("deduplicates a delivery id restored while hydrating a cold transcript", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      const accepted = createUserMessage("monitor event");
      accepted.metadata = {
        origin: "distillctl_cross_session",
        distillDeliveryId: "monitor-event-1",
      };
      useChatStore.getState().addMessage("session-1", accepted);
      return true;
    });

    const duplicate = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "monitor event retried after restart",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );

    expect(duplicate).toEqual({
      session_id: "session-1",
      send_status: "deduplicated",
    });
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      1,
    );
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(mocks.acpSteerMessage).not.toHaveBeenCalled();
  });

  it("rejects multiline sender labels before dispatch", async () => {
    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "monitor update",
          if_running: "queue",
          from: "first line\nsecond line",
        },
        ctx,
      ),
      "invalid_args",
    );

    expect(error.message).toContain("single line");
  });
});

describe("sessions.list", () => {
  it("exhausts paginated backend results before filtering", async () => {
    mockSessionPages(
      {
        sessions: [makeAcpSession({ sessionId: "s-1", title: "Build docs" })],
        nextCursor: "page-2",
      },
      {
        sessions: [
          makeAcpSession({
            sessionId: "s-2",
            title: "Fix login bug",
            updatedAt: "2026-04-02T00:00:00.000Z",
          }),
        ],
        nextCursor: null,
      },
    );

    const result = (await dispatchCommand(
      "sessions",
      { action: "list", query: "LOGIN" },
      ctx,
    )) as { sessions: Array<{ session_id: string }> };

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
    expect(result.sessions.map((s) => s.session_id)).toEqual(["s-2"]);
  });
});

describe("sessions.get", () => {
  it("does not validate a target from stale cache unless the targeted read confirms it", async () => {
    seedSessions(makeSession({ id: "session-1", title: "Stale Session" }));

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "get", session_id: "session-1" },
        ctx,
      ),
      "session_not_found",
    );
    expect(mocks.acpGetSessionInfo).toHaveBeenCalledWith("session-1");
    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
  });

  it("includes the last N messages with long texts truncated", async () => {
    mockSessionFound();
    mocks.lastSessionMessages.mockResolvedValue([
      { role: "user", text: "summarize the repo" },
      { role: "assistant", text: "x".repeat(3000) },
    ]);

    const result = (await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1", messages: 2 },
      ctx,
    )) as { messages: Array<{ role: string; text: string }> };

    expect(mocks.lastSessionMessages).toHaveBeenCalledWith("session-1", 2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      role: "user",
      text: "summarize the repo",
    });
    expect(result.messages[1].text).toHaveLength(2001); // 2000 + ellipsis
  });
});

describe("sessions.fork", () => {
  it("refuses a running session before forking", async () => {
    seedSessions(makeSession({ id: "session-1" }));
    useChatStore.getState().setChatState("session-1", "streaming");

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "fork", session_id: "session-1" },
        ctx,
      ),
      "target_session_running",
    );
    expect(mocks.acpDuplicateSession).not.toHaveBeenCalled();
  });
});

describe("sessions.archive", () => {
  it("never hands the facade the discard policy, even when --discard-changes is set", async () => {
    // The broker is unauthenticated: any same-user process can reach this
    // command, so distillctl must not be able to force-remove a dirty worktree.
    // The flag stays on the wire for CLI compatibility and has no effect.
    mockSessionFound();
    const deadlineMs = Date.now() + 5_000;

    await dispatchCommand(
      "sessions",
      {
        action: "archive",
        session_id: "session-1",
        discard_changes: true,
      },
      { deadlineMs },
    );

    expect(controller.archiveSession).toHaveBeenCalledWith(
      "session-1",
      "reject",
      deadlineMs,
    );
    expect(controller.archiveSession).not.toHaveBeenCalledWith(
      expect.anything(),
      "discard",
      expect.anything(),
    );
  });

  it("refuses cleanup that would discard changes and points the caller at the app", async () => {
    mockSessionFound();
    controller.archiveSession.mockResolvedValue({
      ok: false,
      reason: "cleanup_requires_discard",
    });

    for (const discardChanges of [undefined, true]) {
      const error = await expectCommandError(
        dispatchCommand(
          "sessions",
          {
            action: "archive",
            session_id: "session-1",
            ...(discardChanges === undefined
              ? {}
              : { discard_changes: discardChanges }),
          },
          ctx,
        ),
        "cleanup_requires_discard",
      );
      expect(error.message).toContain("in the app");
      expect(error.message).not.toContain("--discard-changes");
    }
  });

  it("refuses a chat with running terminals before touching the controller", async () => {
    // Archiving in the app stops that chat's shells, and the archive reaches
    // the same function distillctl does. Ending a dev server, a build or a
    // migration is an unrecoverable loss nothing restores on unarchive, so
    // distillctl refuses rather than causing it silently.
    seedSessions(makeSession({ id: "session-1" }));
    mocks.terminalChatSessionIds.add("session-1");

    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "archive", session_id: "session-1" },
        ctx,
      ),
      "session_has_terminals",
    );

    expect(error.message).toContain("running terminals");
    expect(error.message).toContain("in the app");
    expect(controller.archiveSession).not.toHaveBeenCalled();
  });

  it("returns a failure after archival when Git cleanup is incomplete", async () => {
    mockSessionFound();
    controller.archiveSession.mockResolvedValue({
      ok: true,
      cleanupIncomplete: "workspace_cleanup_failed",
    });

    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "archive", session_id: "session-1" },
        ctx,
      ),
      "workspace_cleanup_failed",
    );

    expect(error.message).toContain("was archived");
  });
});

describe("sessions.move", () => {
  it("moves the session into an existing project", async () => {
    const project = makeProject({ id: "p-1" });
    mockSessionFound();
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);

    await dispatchCommand(
      "sessions",
      { action: "move", session_id: "session-1", project_id: "p-1" },
      ctx,
    );
    expect(mocks.moveSessionToProject).toHaveBeenCalledWith("session-1", "p-1");
  });
});

describe("folders.attach", () => {
  it("does not attach an unverifiable path", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockRejectedValue(
      new Error("outside allowed filesystem"),
    );

    await expectCommandError(
      dispatchCommand(
        "folders",
        {
          action: "attach",
          session_id: "session-1",
          path: "/private",
        },
        ctx,
      ),
      "invalid_args",
    );
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/private",
        ),
    ).toBe(false);
  });

  it("rolls back a newly attached folder when immediate set-cwd fails", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.updateWorkingDir.mockRejectedValueOnce(
      new Error("backend rejected cwd"),
    );

    await expect(
      dispatchCommand(
        "folders",
        { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
        ctx,
      ),
    ).rejects.toThrow("backend rejected cwd");

    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo-wt",
        ),
    ).not.toBe(true);
  });

  it("preserves a newer set-cwd attachment when an older activation fails", async () => {
    setMultiWorkspaceEnabled(false);
    seedSessions({
      ...makeSession({ workingDir: "/repo" }),
      workspaceAttachments: [
        {
          id: "path:/repo",
          path: "/repo",
          kind: "git-main-worktree",
          source: "selected",
          branch: "main",
          usedByAgent: true,
        },
      ],
      activeWorkspaceId: "path:/repo",
    });
    useChatSessionStore.getState().setActiveWorkspace("session-1", {
      path: "/repo",
      branch: "main",
    });
    mockSessionFound({ workingDir: "/repo" });
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/older",
      branch: "older",
    });
    let rejectOlder: ((error: Error) => void) | undefined;
    mocks.updateWorkingDir.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOlder = reject;
        }),
    );
    const olderActivation = applyPendingSessionWorkspaceActivation("session-1");
    await vi.waitFor(() => expect(rejectOlder).toBeTypeOf("function"));
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });

    const newerSetCwd = dispatchCommand(
      "folders",
      { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
      ctx,
    );
    await vi.waitFor(() =>
      expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
        path: "/repo-wt",
      }),
    );
    rejectOlder?.(new Error("older activation failed"));

    await expect(olderActivation).rejects.toThrow("older activation failed");
    await expect(newerSetCwd).rejects.toThrow("older activation failed");
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/repo-wt",
    });
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo-wt",
        ),
    ).toBe(true);
    expect(
      useChatSessionStore.getState().activeWorkspaceBySession["session-1"],
    ).toMatchObject({ path: "/repo-wt" });
  });

  it("set-cwd queues safely while the chat is running", async () => {
    mockSessionFound({ workingDir: "/repo" });
    useChatStore.getState().setChatState("session-1", "streaming");
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    });

    await expect(
      dispatchCommand(
        "folders",
        { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
        ctx,
      ),
    ).resolves.toMatchObject({ status: "pending" });
    expect(mocks.updateWorkingDir).not.toHaveBeenCalled();
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/repo-wt",
    });
  });
});

describe("projects", () => {
  describe("set_startup_mode", () => {
    const mainWorkspace = {
      id: "ws-main",
      path: "/projects/repo",
      kind: "git-main-worktree" as const,
      source: "selected" as const,
      branch: "main",
      usedByAgent: false,
      startupMode: "none" as const,
      repositoryPath: "/projects/repo",
      worktreePath: "/projects/repo",
    };
    const docsWorkspace = {
      id: "ws-docs",
      path: "/projects/docs",
      kind: "non-git-directory" as const,
      source: "selected" as const,
      branch: null,
      usedByAgent: false,
      startupMode: "none" as const,
    };

    it("rejects branch/worktree mode when the project has no Git workspaces", async () => {
      const project = makeProject({
        id: "p-1",
        workingDirs: [docsWorkspace.path],
        projectWorkspaces: [docsWorkspace],
      });
      useProjectStore.setState({
        projects: [project],
        hasFetchedProjects: true,
      });
      mocks.listProjects.mockResolvedValue([project]);
      mocks.getGitState.mockResolvedValue({
        isGitRepo: false,
        currentBranch: null,
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: [],
      });

      await expectCommandError(
        dispatchCommand(
          "projects",
          { action: "set_startup_mode", project_id: "p-1", mode: "worktree" },
          ctx,
        ),
        "invalid_args",
      );
      expect(mocks.updateProject).not.toHaveBeenCalled();
    });

    it("does not overwrite a project whose folders change during Git inspection", async () => {
      const project = makeProject({
        id: "p-1",
        workingDirs: [mainWorkspace.path],
        projectWorkspaces: [mainWorkspace],
      });
      useProjectStore.setState({
        projects: [project],
        hasFetchedProjects: true,
      });
      mocks.listProjects.mockResolvedValue([project]);
      mocks.getGitState.mockImplementationOnce(async () => {
        useProjectStore.setState({
          projects: [
            makeProject({
              id: "p-1",
              workingDirs: [mainWorkspace.path, docsWorkspace.path],
              projectWorkspaces: [mainWorkspace, docsWorkspace],
            }),
          ],
        });
        return {
          isGitRepo: true,
          currentBranch: "main",
          dirtyFileCount: 0,
          incomingCommitCount: 0,
          worktrees: [],
          isWorktree: false,
          mainWorktreePath: mainWorkspace.path,
          localBranches: ["main"],
        };
      });

      await expectCommandError(
        dispatchCommand(
          "projects",
          { action: "set_startup_mode", project_id: "p-1", mode: "worktree" },
          ctx,
        ),
        "internal_error",
      );
      expect(mocks.updateProject).not.toHaveBeenCalled();
    });
  });
});

describe("agents", () => {
  it("create stores an offered effort and fast mode on the persona", async () => {
    seedModelRows("codex-acp", CODEX_ROWS);
    mocks.createPersona.mockResolvedValue({
      id: "/agents/planner.md",
      displayName: "Planner",
      systemPrompt: "Plan migrations",
      isBuiltin: false,
      writable: true,
    });

    const result = await dispatchCommand(
      "agents",
      {
        action: "create",
        name: "Planner",
        system_prompt: "Plan migrations",
        provider: "codex-acp",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        fast_mode: true,
      },
      ctx,
    );

    expect(mocks.createPersona).toHaveBeenCalledWith({
      displayName: "Planner",
      systemPrompt: "Plan migrations",
      provider: "codex-acp",
      modelProviderId: "codex-acp",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      fastMode: true,
    });
    expect(result).toEqual({ agent_id: "/agents/planner.md" });
  });
});

describe("skills", () => {
  it("list scopes project skills to the given project's working dirs", async () => {
    const project = makeProject({ id: "p-1", workingDirs: ["/projects/one"] });
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);

    await dispatchCommand("skills", { action: "list", project_id: "p-1" }, ctx);
    expect(mocks.listSkills).toHaveBeenCalledWith(["/projects/one"]);
  });
});

describe("info", () => {
  it("list_models reports a harness that manages its model outside the app as empty with a warning", async () => {
    // amp-acp's catalog entry has supportsModelList: false, so it exposes no
    // model list; the hint surfaces through `warning` instead of an error.
    mocks.discoverAcpProviders.mockResolvedValue([
      { id: "claude-acp", label: "Claude Code" },
      { id: "amp-acp", label: "Amp" },
    ]);
    mocks.readinessFromReport.mockReturnValue(
      new Map([
        ["claude-acp", "ready"],
        ["amp-acp", "ready"],
      ]),
    );

    const result = await dispatchCommand(
      "info",
      { action: "list_models", harness_id: "amp-acp" },
      ctx,
    );

    expect(result).toEqual({
      harnesses: [
        {
          harness_id: "amp-acp",
          models: [],
          warning: "Use the Amp CLI to configure the model.",
        },
      ],
    });
  });
});
