import { getModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import { beginModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { getAppNavigationController } from "@/features/distillctl/navigation";
import { resetAgentBuilderSourceLifecycleForTests } from "@/features/agents/lib/agentBuilderSourceLifecycle";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { replaceSessionTargetAfterDispatch } from "@/features/chat/lib/sessionTargetCoordinator";
import { retryDraftSessionCreation } from "@/features/chat/lib/draftSessionRetry";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { Message } from "@/shared/types/messages";
import type { GitState } from "@/shared/types/git";
import { useShortcutsDialogStore } from "@/features/shortcuts/stores/shortcutsDialogStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { hostSelectionFromExecutionTarget } from "@/features/chat/lib/hostExecutionTarget";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import { AppShell } from "./AppShell";
import type { NavigationPanesViewProps } from "@/app/views/NavigationPanesView";
import type { AppShellContent as AppShellContentType } from "./ui/AppShellContent";

const mockAcpCreateSession = vi.hoisted(() => vi.fn());
const mockAcpPrepareSession = vi.hoisted(() => vi.fn());
const mockAcpSetSessionConfigOption = vi.hoisted(() => vi.fn());
const mockAcpListSessionsPage = vi.hoisted(() => vi.fn());
const mockAcpArchiveSession = vi.hoisted(() => vi.fn());
const mockAcpGetSessionInfo = vi.hoisted(() => vi.fn());
const mockAcpLoadSession = vi.hoisted(() => vi.fn());
const mockRenameTerminalSessionPrefix = vi.hoisted(() => vi.fn());
const mockStopTerminalSessionsForChat = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => 0),
);
const mockListExtensions = vi.hoisted(() => vi.fn());
const mockCheckDirectoriesExist = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());
const mockCheckAllProviderStatus = vi.hoisted(() => vi.fn());
const mockRepairManagedGooseModelSelection = vi.hoisted(() => vi.fn());
const gitMocks = vi.hoisted(() => ({
  countBranchCommitsNotInBase: vi.fn(),
  hasIgnoredFiles: vi.fn(),
  createBranch: vi.fn(),
  createWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  getGitState: vi.fn(),
  removeWorktree: vi.fn(),
}));
const mockAgentStatus = vi.hoisted(() => ({
  readyAgentIds: new Set<string>(["claude-acp"]),
}));
const mockCreatePersonaSource = vi.hoisted(() => vi.fn());
const mockListPersonaSources = vi.hoisted(() => vi.fn());
const mockReadAgentSourceFile = vi.hoisted(() => vi.fn());
const mockDeletePersonaSource = vi.hoisted(() => vi.fn());
const mockListPersonas = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockListenSessionDeepLinkErrors = vi.hoisted(() => vi.fn());
const mockAfterNextPaint = vi.hoisted(() => ({
  callbacks: [] as Array<{ callback: () => void; cancelled: boolean }>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function appShellWithTheme(children?: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppShell>{children}</AppShell>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function renderAppShell(children?: ReactNode) {
  return render(appShellWithTheme(children));
}

function managedWorktreeGitState(
  branch: string,
  worktreePath = `/repo-worktrees/${branch}`,
): GitState {
  return {
    isGitRepo: true,
    currentBranch: branch,
    dirtyFileCount: 0,
    incomingCommitCount: 0,
    worktrees: [
      { path: "/repo", branch: "main", isMain: true },
      { path: worktreePath, branch, isMain: false },
    ],
    isWorktree: true,
    mainWorktreePath: "/repo",
    localBranches: ["main", branch],
  };
}

function makeManagedWorktreeSession(
  branch: string,
  worktreePath = `/repo-worktrees/${branch}`,
): ChatSession {
  return {
    id: "session-1",
    title: branch,
    executionTarget: { harnessId: "claude-acp" },
    workingDir: worktreePath,
    workspaceAttachments: [
      {
        id: `path:${worktreePath}`,
        path: worktreePath,
        kind: "git-linked-worktree",
        source: "created",
        branch,
        repositoryPath: "/repo",
        worktreePath,
        usedByAgent: true,
        lifecycle: {
          owner: "distill",
          cleanup: "worktree",
          branch,
          baseBranch: "main",
          repositoryPath: "/repo",
          worktreePath,
          createdBranch: true,
        },
      },
    ],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    messageCount: 1,
  };
}

async function waitForCreatedAgentBuilderTarget() {
  await waitFor(() => {
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "created-session",
      intent: "build-agent",
      targetAgentPath:
        "/Users/test/.agents/agents/untitled-agent-created-session.md",
      targetAgentDraftState: null,
    });
  });
}

function setReadyRuntimeConfig(config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG) {
  useRuntimeConfigStore.setState({
    loaded: true,
    result: {
      status: "ready",
      source: "fakeEndpoint",
      config,
    },
    config,
  });
}

const mockGetPlatform = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: mockGetPlatform,
}));

const mockDesignSystemExplorerEnabled = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/features/design-system/lib/designSystemEnabled", () => ({
  isDesignSystemExplorerEnabled: mockDesignSystemExplorerEnabled,
}));

vi.mock("./hooks/useAppStartup", () => ({
  useAppStartup: () => ({ ready: true }),
}));

vi.mock("@/features/migration/hooks/useMigrationGate", () => ({
  useMigrationGate: () => ({ status: "ready", retry: vi.fn() }),
}));

vi.mock("@/features/migration/hooks/useDefaultModelGate", () => ({
  useDefaultModelGate: () => ({ status: "ok", retry: vi.fn() }),
}));

vi.mock("@/app/views/NavigationPanesView", () => ({
  NavigationPanesView: ({
    collapsed,
    onNavigate,
    onNewChat,
    onNewChatInProject,
    onSettingsClick,
    onSettingsSectionChange,
    width,
  }: NavigationPanesViewProps) => (
    <nav aria-label="mock sidebar">
      <div data-testid="mock-sidebar-collapsed">{String(collapsed)}</div>
      <div data-testid="mock-sidebar-width">{String(width)}</div>
      <button type="button" onClick={onNewChat}>
        Sidebar new chat
      </button>
      <button type="button" onClick={() => onNewChatInProject?.("project-2")}>
        Sidebar new project 2 chat
      </button>
      <button type="button" onClick={() => onNavigate?.("skills")}>
        Sidebar skills
      </button>
      <button type="button" onClick={() => onNavigate?.("agents")}>
        Sidebar agents
      </button>
      <button type="button" onClick={onSettingsClick}>
        Sidebar settings
      </button>
      <button type="button" onClick={() => onNavigate?.("design-system")}>
        Sidebar design system
      </button>
      <button
        type="button"
        onClick={() => onSettingsSectionChange?.("providers")}
      >
        Sidebar providers
      </button>
    </nav>
  ),
}));

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: (...args: unknown[]) => mockListExtensions(...args),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: (...args: unknown[]) =>
    mockCheckAllProviderStatus(...args),
}));

vi.mock("@/features/providers/lib/managedModelSelectionRepair", () => ({
  repairManagedGooseModelSelection: (...args: unknown[]) =>
    mockRepairManagedGooseModelSelection(...args),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mockAcpCreateSession(...args),
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
  acpSetSessionConfigOption: (...args: unknown[]) =>
    mockAcpSetSessionConfigOption(...args),
  acpGetSessionInfo: (...args: unknown[]) => mockAcpGetSessionInfo(...args),
  acpListSessionsPage: (...args: unknown[]) => mockAcpListSessionsPage(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  discoverAcpProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/features/terminal/lib/terminalSessionManager", async () => ({
  ...(await vi.importActual<
    typeof import("@/features/terminal/lib/terminalSessionManager")
  >("@/features/terminal/lib/terminalSessionManager")),
  renameTerminalSessionPrefix: (...args: unknown[]) =>
    mockRenameTerminalSessionPrefix(...args),
  stopTerminalSessionsForChat: (...args: unknown[]) =>
    mockStopTerminalSessionsForChat(...args),
}));

vi.mock("@/shared/api/acpApi", () => ({
  DEFAULT_PROVIDER: { id: "claude-acp", label: "Claude Code" },
  archiveSession: (...args: unknown[]) => mockAcpArchiveSession(...args),
  renameSession: vi.fn().mockResolvedValue(undefined),
  unarchiveSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/git", () => ({
  countBranchCommitsNotInBase: (...args: unknown[]) =>
    gitMocks.countBranchCommitsNotInBase(...args),
  hasIgnoredFiles: (...args: unknown[]) => gitMocks.hasIgnoredFiles(...args),
  createBranch: (...args: unknown[]) => gitMocks.createBranch(...args),
  createWorktree: (...args: unknown[]) => gitMocks.createWorktree(...args),
  deleteBranch: (...args: unknown[]) => gitMocks.deleteBranch(...args),
  getGitState: (...args: unknown[]) => gitMocks.getGitState(...args),
  removeWorktree: (...args: unknown[]) => gitMocks.removeWorktree(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    info: vi.fn(),
  },
}));

vi.mock("./lib/sessionDeepLinkErrors", () => ({
  listenSessionDeepLinkErrors: (...args: unknown[]) =>
    mockListenSessionDeepLinkErrors(...args),
}));

vi.mock("@/shared/api/agents", () => ({
  createPersonaSource: (...args: unknown[]) => mockCreatePersonaSource(...args),
  listPersonaSources: (...args: unknown[]) => mockListPersonaSources(...args),
  listPersonas: (...args: unknown[]) => mockListPersonas(...args),
  readAgentSourceFile: (...args: unknown[]) => mockReadAgentSourceFile(...args),
  deletePersonaSource: (...args: unknown[]) => mockDeletePersonaSource(...args),
  promotePersonaSource: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: async ({ parts }: { parts: string[] }) => ({
    path: parts.join("/") || "/tmp",
  }),
  checkDirectoriesExist: (...args: unknown[]) =>
    mockCheckDirectoriesExist(...args),
}));

vi.mock("@/features/chat/hooks/useMentionHandlers", () => ({
  useMentionHandlers: () => ({
    mentionOpen: false,
    atMentionCategory: "agents",
    mentionSelectedIndex: 0,
    filteredPersonas: [],
    filteredSkills: [],
    filteredFiles: [],
    fileMentionsLoading: false,
    fileMentionsError: null,
    detectMention: vi.fn(),
    closeMention: vi.fn(),
    navigateMention: vi.fn(),
    setAtMentionCategory: vi.fn(),
    handleMentionCategoryKey: vi.fn(),
    confirmMention: vi.fn(),
    handleMentionConfirm: vi.fn(),
  }),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/Users/test"),
  pathExists: (...args: unknown[]) => mockPathExists(...args),
}));

vi.mock("@/features/status/ui/StatusBar", () => ({
  StatusBar: () => null,
}));

vi.mock("@/features/updates/ui/UpdateButton", () => ({
  UpdateButton: () => null,
}));

vi.mock("@/features/updates/ui/ChannelSwitchDialog", () => ({
  ChannelSwitchDialog: () => null,
}));

vi.mock("@/features/updates/ui/BetaBadge", () => ({
  BetaBadge: () => null,
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: mockAgentStatus.readyAgentIds,
    agentReadiness: new Map(
      [...mockAgentStatus.readyAgentIds].map((providerId) => [
        providerId,
        "ready" as const,
      ]),
    ),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./lib/scheduleAfterNextPaint", () => ({
  scheduleAfterNextPaint: (callback: () => void) => {
    const entry = { callback, cancelled: false };
    mockAfterNextPaint.callbacks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  },
}));

vi.mock("./ui/AppShellContent", () => ({
  AppShellContent: (({
    targetLocation,
    renderedLocation,
    isPreparingContent,
    renderedSession,
    onCloseDesignSystem,
    onNavigateSkills,
    onNavigateAgents,
    onSkillsBreadcrumbLabelChange,
    onAgentsBreadcrumbLabelChange,
    onCreatePersona,
    onAgentBuilderCompleted,
    onExitSearch,
    onArchiveChat,
    onOpenAgent,
    onSelectSession,
  }) => {
    const activeView = targetLocation.view;
    const activeSettingsSection =
      targetLocation.view === "settings"
        ? targetLocation.settingsSection
        : "general";
    const activeSkillsSkillId =
      targetLocation.view === "skills" ? targetLocation.skillId : null;
    const activeAgentsPersonaId =
      targetLocation.view === "agents" ? targetLocation.personaId : null;

    return (
      <section>
        <div data-testid="active-view">{activeView}</div>
        <div data-testid="rendered-view">{renderedLocation.view}</div>
        <div data-testid="preparing-content">{String(isPreparingContent)}</div>
        <div data-testid="rendered-session-id">
          {renderedSession?.id ?? "none"}
        </div>
        <div data-testid="settings-section">{activeSettingsSection}</div>
        <div data-testid="skill-route">{activeSkillsSkillId ?? "list"}</div>
        <div data-testid="agent-route">{activeAgentsPersonaId ?? "list"}</div>
        <button
          type="button"
          onClick={() => {
            onSkillsBreadcrumbLabelChange?.("Code Review");
            onNavigateSkills("skill-1");
          }}
        >
          Open skill detail
        </button>
        <button
          type="button"
          onClick={() => {
            onAgentsBreadcrumbLabelChange?.("Reviewer");
            onNavigateAgents("persona-1");
          }}
        >
          Open agent detail
        </button>
        <button type="button" onClick={() => onOpenAgent?.("persona-resolves")}>
          Start chat with resolving agent
        </button>
        <button
          type="button"
          onClick={() => onOpenAgent?.("persona-unresolved")}
        >
          Start chat with unresolved agent
        </button>
        <button
          type="button"
          onClick={() => onSelectSession?.("missing-session")}
        >
          Open missing session
        </button>
        <button type="button" onClick={() => onSelectSession?.("session-1")}>
          Open session 1
        </button>
        <button type="button" onClick={() => onCloseDesignSystem?.()}>
          Close design system
        </button>
        <button type="button" onClick={() => onSelectSession?.("session-2")}>
          Open session 2
        </button>
        <button type="button" onClick={() => onArchiveChat("session-1")}>
          Archive session 1
        </button>
        {activeView === "agents" ? (
          <button type="button" onClick={onCreatePersona}>
            Create agent
          </button>
        ) : null}
        {activeView === "chat" ? (
          <button
            type="button"
            onClick={() => onAgentBuilderCompleted?.("/saved-agent.md")}
          >
            Complete agent builder
          </button>
        ) : null}
        {activeView === "search" ? (
          <button type="button" onClick={onExitSearch}>
            Exit search
          </button>
        ) : null}
        <input aria-label="Mock search input" />
      </section>
    );
  }) satisfies typeof AppShellContentType,
}));

describe("AppShell global navigation", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockRepairManagedGooseModelSelection.mockReset();
    mockRepairManagedGooseModelSelection.mockImplementation(
      async (selection: unknown) => selection,
    );
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    mockGetPlatform.mockReturnValue("mac");
    mockDesignSystemExplorerEnabled.mockReturnValue(false);
    mockAfterNextPaint.callbacks = [];
    resetAgentBuilderSourceLifecycleForTests();
    useShortcutsDialogStore.setState({ open: false });
    mockListExtensions.mockReset();
    mockListExtensions.mockResolvedValue([]);
    mockAcpCreateSession.mockReset();
    mockAcpCreateSession.mockResolvedValue({ sessionId: "created-session" });
    mockRenameTerminalSessionPrefix.mockReset();
    mockStopTerminalSessionsForChat.mockReset();
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession.mockResolvedValue({});
    mockAcpSetSessionConfigOption.mockReset();
    mockAcpSetSessionConfigOption.mockResolvedValue({});
    mockAcpListSessionsPage.mockReset();
    mockAcpListSessionsPage.mockImplementation(async () => ({
      sessions: useChatSessionStore.getState().sessions.map((session) => {
        const selection = hostSelectionFromExecutionTarget(
          session.executionTarget,
        );
        return {
          sessionId: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
          lastMessageAt: session.lastMessageAt ?? null,
          archivedAt: session.archivedAt ?? null,
          userSetName: session.userSetName ?? false,
          messageCount: session.messageCount,
          subtitle: session.subtitle ?? null,
          workingDir: session.workingDir ?? null,
          projectId: session.projectId ?? null,
          providerId: selection.providerId ?? null,
          modelId: selection.modelId ?? null,
          personaId: session.personaId ?? null,
        };
      }),
      nextCursor: null,
    }));
    mockAcpArchiveSession.mockReset();
    mockAcpArchiveSession.mockResolvedValue(undefined);
    mockAcpGetSessionInfo.mockReset();
    mockAcpGetSessionInfo.mockResolvedValue(null);
    mockAcpLoadSession.mockReset();
    mockAcpLoadSession.mockResolvedValue(undefined);
    mockToastError.mockReset();
    mockListenSessionDeepLinkErrors.mockReset();
    mockListenSessionDeepLinkErrors.mockResolvedValue(vi.fn());
    gitMocks.getGitState.mockReset();
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [{ path: "/repo", branch: "main", isMain: true }],
      isWorktree: false,
      mainWorktreePath: "/repo",
      localBranches: ["main"],
    });
    gitMocks.createBranch.mockReset();
    gitMocks.createBranch.mockResolvedValue(undefined);
    gitMocks.createWorktree.mockReset();
    gitMocks.createWorktree.mockResolvedValue({
      path: "/repo-worktrees/chat-123",
      branch: "chat-123",
    });
    gitMocks.countBranchCommitsNotInBase.mockReset();
    gitMocks.countBranchCommitsNotInBase.mockResolvedValue(0);
    gitMocks.hasIgnoredFiles.mockReset();
    gitMocks.hasIgnoredFiles.mockResolvedValue(false);
    gitMocks.deleteBranch.mockReset();
    gitMocks.deleteBranch.mockResolvedValue(undefined);
    gitMocks.removeWorktree.mockReset();
    gitMocks.removeWorktree.mockResolvedValue(undefined);
    mockPathExists.mockReset();
    mockPathExists.mockResolvedValue(false);
    mockCheckDirectoriesExist.mockReset();
    mockCheckDirectoriesExist.mockResolvedValue([]);
    mockCheckAllProviderStatus.mockReset();
    mockCheckAllProviderStatus.mockResolvedValue([]);
    mockAgentStatus.readyAgentIds = new Set(["claude-acp"]);
    mockCreatePersonaSource.mockReset();
    mockCreatePersonaSource.mockResolvedValue({
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Untitled agent created-sess",
      description: "Draft",
      content: "Draft in progress.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    });
    mockListPersonaSources.mockReset();
    mockListPersonaSources.mockResolvedValue([]);
    mockListPersonas.mockReset();
    mockListPersonas.mockResolvedValue([]);
    mockReadAgentSourceFile.mockReset();
    mockReadAgentSourceFile.mockRejectedValue(new Error("not found"));
    mockDeletePersonaSource.mockReset();
    mockDeletePersonaSource.mockResolvedValue(undefined);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      queuedMessageBySession: {},
      scrollTargetMessageBySession: {},
      activeSessionId: null,
      isConnected: true,
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
      archiveMutationBySessionId: {},
    });
    useAgentStore.setState({
      selectedProvider: "claude-acp",
    });
    useProjectStore.setState({
      projects: [],
      loading: false,
      activeProjectId: null,
    });
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
    useProviderCatalogStore.getState().reset();
    setReadyRuntimeConfig();
  });

  it("keeps archive UI active until the backend succeeds and rolls back archivedAt on failure", async () => {
    const user = userEvent.setup();
    const archive = deferred<void>();
    mockAcpArchiveSession.mockReturnValueOnce(archive.promise);
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      executionTarget: { harnessId: "claude-acp" },
      workingDir: "~/.distill/artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    const message: Message = {
      id: "message-1",
      role: "user",
      created: Date.now(),
      content: [{ type: "text", text: "hello" }],
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });
    useChatStore.setState({
      messagesBySession: { "session-1": [message] },
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
    expect(useChatStore.getState().messagesBySession["session-1"]).toEqual([
      message,
    ]);

    act(() => {
      archive.reject(new Error("backend down"));
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(useChatStore.getState().messagesBySession["session-1"]).toEqual([
      message,
    ]);
    expect(mockToastError).toHaveBeenCalledWith("backend down");
  });

  it("stops the chat's terminals once the operator's archive has succeeded", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Dev server",
          executionTarget: { harnessId: "claude-acp" },
          workingDir: "/tmp/dev-server",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const order: string[] = [];
    mockAcpArchiveSession.mockImplementation(async () => {
      order.push("archive");
    });
    mockStopTerminalSessionsForChat.mockImplementation(() => {
      order.push("stop-terminals");
      return 1;
    });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    // An archived chat leaves the sidebar, so a shell still running under it
    // would have no UI left to stop it from.
    await waitFor(() => {
      expect(mockStopTerminalSessionsForChat).toHaveBeenCalledWith("session-1");
    });
    expect(order).toEqual(["archive", "stop-terminals"]);
  });

  it("never stops the chat's terminals for a distillctl archive", async () => {
    // distillctl reaches the same `archiveChat`, is declared `destructive: false`
    // and promises in its help that it discards nothing local. Killing a dev
    // server, a build or a migration is unrecoverable (unarchive restores no
    // shell), so only the operator's own Archive may do it. `session archive`
    // refuses outright while the chat still has live shells.
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Dev server",
          executionTarget: { harnessId: "claude-acp" },
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    const outcome = await getAppNavigationController().archiveSession(
      "session-1",
      "reject",
    );

    expect(outcome).toEqual({ ok: true });
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(mockStopTerminalSessionsForChat).not.toHaveBeenCalled();
  });

  it("keeps the terminals of a chat whose archive failed", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Dev server",
          executionTarget: { harnessId: "claude-acp" },
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    mockAcpArchiveSession.mockRejectedValue(new Error("offline"));
    renderAppShell();

    const outcome = await getAppNavigationController().archiveSession(
      "session-1",
      "reject",
    );

    expect(outcome).toEqual({ ok: false, reason: "backend_archive_failed" });
    expect(mockStopTerminalSessionsForChat).not.toHaveBeenCalled();
  });

  it("rejects noninteractive archive before local-file loss", async () => {
    const worktreePath = "/repo-worktrees/cli-reject";
    mockPathExists.mockResolvedValue(true);
    gitMocks.hasIgnoredFiles.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "cli-reject",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: worktreePath, branch: "cli-reject", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "cli-reject"],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "CLI reject",
          executionTarget: { harnessId: "claude-acp" },
          workingDir: worktreePath,
          workspaceAttachments: [
            {
              id: `path:${worktreePath}`,
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "cli-reject",
              repositoryPath: "/repo",
              worktreePath,
              usedByAgent: true,
              lifecycle: {
                owner: "distill",
                cleanup: "worktree",
                branch: "cli-reject",
                baseBranch: "main",
                repositoryPath: "/repo",
                worktreePath,
                createdBranch: true,
              },
            },
          ],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    const outcome = await getAppNavigationController().archiveSession(
      "session-1",
      "reject",
    );

    expect(outcome).toEqual({
      ok: false,
      reason: "cleanup_requires_discard",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("blocks destructive Git cleanup and chat archival until confirmed", async () => {
    const user = userEvent.setup();
    const worktreePath = "/repo-worktrees/dirty-chat";
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "dirty-chat",
      dirtyFileCount: 2,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: worktreePath, branch: "dirty-chat", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "dirty-chat"],
    });
    const session: ChatSession = {
      id: "session-1",
      title: "Dirty chat",
      executionTarget: { harnessId: "claude-acp" },
      workingDir: worktreePath,
      workspaceAttachments: [
        {
          id: `path:${worktreePath}`,
          path: worktreePath,
          kind: "git-linked-worktree",
          source: "created",
          branch: "dirty-chat",
          repositoryPath: "/repo",
          worktreePath,
          usedByAgent: true,
          lifecycle: {
            owner: "distill",
            cleanup: "worktree",
            branch: "dirty-chat",
            baseBranch: "main",
            repositoryPath: "/repo",
            worktreePath,
            createdBranch: true,
          },
        },
      ],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({ sessions: [session] });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Archive chat and remove its worktrees?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/discard local files and changes/i),
    ).toBeInTheDocument();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Archive session 1" }));
    await user.click(
      await screen.findByRole("button", { name: "Archive and remove" }),
    );

    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    });
    expect(gitMocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      worktreePath,
      true,
    );
    expect(gitMocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "dirty-chat",
      true,
      "main",
    );
    expect(mockAcpArchiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      gitMocks.removeWorktree.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
  });

  it("prompts before removing a worktree with only ignored files", async () => {
    const user = userEvent.setup();
    const worktreePath = "/repo-worktrees/ignored-files";
    mockPathExists.mockResolvedValue(true);
    gitMocks.hasIgnoredFiles.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "ignored-files",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: worktreePath, branch: "ignored-files", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "ignored-files"],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Ignored files",
          executionTarget: { harnessId: "claude-acp" },
          workingDir: worktreePath,
          workspaceAttachments: [
            {
              id: `path:${worktreePath}`,
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "ignored-files",
              repositoryPath: "/repo",
              worktreePath,
              usedByAgent: true,
              lifecycle: {
                owner: "distill",
                cleanup: "worktree",
                branch: "ignored-files",
                baseBranch: "main",
                repositoryPath: "/repo",
                worktreePath,
                createdBranch: true,
              },
            },
          ],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Archive chat and remove its worktrees?",
      }),
    ).toBeInTheDocument();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("reports cleanup failure as an archived chat with incomplete cleanup", async () => {
    const user = userEvent.setup();
    const worktreePath = "/repo-worktrees/cleanup-fails";
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue(
      managedWorktreeGitState("cleanup-fails", worktreePath),
    );
    gitMocks.removeWorktree.mockRejectedValue(new Error("cleanup failed"));
    const session = makeManagedWorktreeSession("cleanup-fails", worktreePath);
    useChatSessionStore.setState({ sessions: [session] });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    let outcome: unknown;
    await act(async () => {
      outcome = await getAppNavigationController().archiveSession(
        "session-1",
        "confirm",
      );
    });

    expect(outcome).toEqual({
      ok: true,
      cleanupIncomplete: "workspace_cleanup_failed",
    });
    expect(gitMocks.removeWorktree).toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("cleanup failed");
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(useChatSessionStore.getState().activeSessionId).toBeNull();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
  });

  it("rechecks running state before noninteractive archival", async () => {
    const inspection = deferred<GitState>();
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockReturnValue(inspection.promise);
    useChatSessionStore.setState({
      sessions: [makeManagedWorktreeSession("starts-running")],
    });
    renderAppShell();

    const outcome = getAppNavigationController().archiveSession(
      "session-1",
      "reject",
    );
    await waitFor(() => {
      expect(gitMocks.getGitState).toHaveBeenCalled();
    });

    act(() => {
      useChatStore.getState().setChatState("session-1", "thinking");
      inspection.resolve(managedWorktreeGitState("starts-running"));
    });

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "target_session_running",
    });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("re-keys the draft's terminals to the created session before the id swaps", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    const draftStillPresentAtRename: boolean[] = [];
    mockRenameTerminalSessionPrefix.mockImplementation((from: string) => {
      draftStillPresentAtRename.push(
        Boolean(useChatSessionStore.getState().getSession(from)),
      );
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(mockAcpCreateSession).toHaveBeenCalled());
    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";

    act(() => {
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "created-session",
      );
    });
    // A shell opened while the bridge was still spawning is keyed by the
    // draft id; the panel re-keys to the backend id on the very render that
    // swaps ids, so the registry must already answer under the new key.
    expect(mockRenameTerminalSessionPrefix).toHaveBeenCalledWith(
      draftSessionId,
      "created-session",
    );
    expect(draftStillPresentAtRename).toEqual([true]);
  });

  it("applies the latest pending draft selection before promotion", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    const pendingPrepare = deferred<Record<string, never>>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    mockAcpPrepareSession.mockReturnValueOnce(pendingPrepare.promise);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(mockAcpCreateSession).toHaveBeenCalled());
    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";

    act(() => {
      const target = {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "gpt-5.4-mini",
        modelName: "GPT-5.4 mini",
      } as const;
      beginModelSelectionIntent(draftSessionId, {
        requestId: "pending-model",
        target,
        preferenceAgentId: "codex-acp",
      });
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "created-session",
        "codex-acp",
        "~/.distill/artifacts",
        expect.objectContaining({ modelId: "gpt-5.4-mini" }),
      );
    });
    act(() => pendingPrepare.resolve({}));

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "codex-acp",
          modelProviderId: "codex-acp",
          modelId: "gpt-5.4-mini",
          modelName: "GPT-5.4 mini",
        },
      });
    });
    expect(
      JSON.parse(
        localStorage.getItem("distill:preferredModelsByAgent") ?? "{}",
      ),
    ).toMatchObject({
      "codex-acp": {
        modelId: "gpt-5.4-mini",
        modelName: "GPT-5.4 mini",
        providerId: "codex-acp",
      },
    });
    expect(getModelSelectionIntent("created-session")).toBeUndefined();
  });

  it("archives the backend session when post-creation reconciliation fails", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("switch failed"));
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(mockAcpCreateSession).toHaveBeenCalled());
    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";
    act(() => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget(draftSessionId, {
          harnessId: "codex-acp",
          modelProviderId: "codex-acp",
          modelId: "gpt-5.4-mini",
          modelName: "GPT-5.4 mini",
        });
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("created-session");
      expect(
        useChatSessionStore.getState().getSession(draftSessionId),
      ).toMatchObject({ creationState: "failed" });
    });
  });

  it("opens a chat sent from the global composer on the Home selection's model, effort and fast mode in session/new", async () => {
    mockGetPlatform.mockReturnValue("windows");
    window.localStorage.setItem(
      "distill:preferredModelsByAgent",
      JSON.stringify({
        "claude-acp": {
          modelId: "claude-opus-5",
          modelName: "Opus 5",
          providerId: "claude-acp",
          byModel: {
            "claude-opus-5": { reasoningEffort: "xhigh", fastMode: true },
          },
        },
      }),
    );
    const creationArgsBySessionId = new Map<string, unknown[]>();
    let createdCount = 0;
    mockAcpCreateSession.mockImplementation(async (...args: unknown[]) => {
      createdCount += 1;
      const sessionId = `created-session-${createdCount}`;
      creationArgsBySessionId.set(sessionId, args);
      return { sessionId };
    });
    const user = userEvent.setup();
    renderAppShell();

    expect(screen.queryByPlaceholderText("Start a conversation")).toBeNull();
    await user.keyboard("{Control>}n{/Control}");
    await user.type(
      await screen.findByPlaceholderText("Start a conversation"),
      "hello{Enter}",
    );

    // The chat the message was accepted into, whichever creation path the
    // composer took to make it.
    const sentChatId = await waitFor(() => {
      const chatState = useChatStore.getState();
      const id = Object.keys(chatState.queuedMessageBySession).find(
        (sessionId) =>
          chatState.queuedMessageBySession[sessionId]?.some(
            (record) => record.payload.text === "hello",
          ),
      );
      expect(id).toBeDefined();
      return id ?? "";
    });
    await waitFor(() => {
      expect(creationArgsBySessionId.has(sentChatId)).toBe(true);
    });
    expect(creationArgsBySessionId.get(sentChatId)).toEqual([
      "claude-acp",
      expect.any(String),
      expect.objectContaining({
        modelId: "claude-opus-5",
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    ]);
    expect(
      useChatSessionStore.getState().getSession(sentChatId)?.desiredRunSettings,
    ).toEqual({ effort: "xhigh", fast: true });
  });

  it("creates a failed draft again on the agent it was moved to", async () => {
    mockAcpCreateSession.mockRejectedValueOnce(
      new Error("Failed to create session: harness is down"),
    );
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    const draftSessionId = await waitFor(() => {
      const id = useChatSessionStore.getState().activeSessionId ?? "";
      expect(useChatSessionStore.getState().getSession(id)).toMatchObject({
        creationState: "failed",
      });
      return id;
    });
    expect(
      useChatStore.getState().messagesBySession[draftSessionId],
    ).toHaveLength(1);

    // What the picker does for a failed draft: record the choice, then retry.
    replaceSessionTargetAfterDispatch(draftSessionId, {
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
    });
    expect(retryDraftSessionCreation(draftSessionId)).toBe(true);

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenLastCalledWith(
        "codex-acp",
        expect.any(String),
        expect.anything(),
      );
    });
    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "created-session",
      );
    });
    // The failure's notice went with the failure.
    expect(
      useChatStore.getState().messagesBySession["created-session"] ?? [],
    ).toHaveLength(0);
  });

  it("keeping a dirty agent draft continues the pending navigation without deleting it", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);
    mockDeletePersonaSource.mockClear();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(await screen.findByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(mockDeletePersonaSource).not.toHaveBeenCalled();
  });
});
