import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAgentModelRanking } from "@/features/agents/lib/agentModelRanking";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import type { Persona } from "@/shared/types/agents";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import { resetProjectWikiPresenceForTests } from "@/features/memory/lib/projectWikiPrompt";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import { MEMORY_PROTOCOL_PROMPT } from "@/features/memory/lib/memoryFence";
import { useChatStore } from "../../stores/chatStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "../../stores/chatSessionStore";
import { resetSessionTargetCoordinatorsForTests } from "../../lib/sessionTargetCoordinator";
import { workspaceAttachmentIdForPath } from "../../lib/workspaceAttachments";
import type { ChatSendOptions, ModelOption } from "../../types";
import { ModelFailedAfterProviderMoveError } from "@/shared/api/acpSessionRegistry";

const mockAcpPrepareSession = vi.fn();
const mockAcpSetSessionConfigOption = vi.fn();
const mockSetSelectedProvider = vi.fn();
const mockResolveSessionCwd = vi.fn();
const mockGooseDefaultsRead = vi.fn();
const mockGoosePreferencesRead = vi.fn();
const mockGoosePreferencesSave = vi.fn();
const mockSupportedModelsList = vi.fn();
const mockToastError = vi.fn();
const mockUseChatSendMessage = vi.fn();
const mockUseChatSteerMessage = vi.fn();
const mockUseChatHook = vi.fn();
const mockUseMessageQueue = vi.fn();
const mockPickerOpen = vi.fn();
const mockPreSeedDraftAgent = vi.fn();
const mockClearBuilderSessionState = vi.fn();
const mockMarkAgentBuilderSessionPreparationFailed = vi.fn();
const mockDeletePersonaSource = vi.fn();
const mockAcpCreateSession = vi.fn();
const mockAcpSessionArchive = vi.fn();
const mockUseChatRuntime = {
  chatState: "idle",
  activeRunId: null as string | null,
  isRunCancellationPending: false,
};
const mockListSkills = vi.fn();
const mockListDistillAppSkills = vi.fn();
const mockListGooseSourceSkills = vi.fn();
const mockLoadWorkspaceInstructionFiles = vi.fn();
const mockListProjectDocuments = vi.fn();
const mockReadProjectDocument = vi.fn();
const mockWriteProjectDocument = vi.fn();
const mockPickerState = {
  selectedAgentId: "claude-acp",
  pickerAgents: [{ id: "claude-acp", label: "Claude Code" }],
  availableModels: [] as ModelOption[],
  modelsByAgent: new Map<string, ModelOption[]>(),
  installedModelsByAgent: new Map<string, ModelOption[]>(),
  // Whether the harness itself reported the list, as opposed to a cache
  // nobody vouches for.
  inventoryAuthoritative: false,
  modelsLoading: false,
  modelStatusMessage: null as string | null,
};
const modelFixtures: Record<
  string,
  { name: string; displayName: string; providerId: string }
> = {
  "claude-sonnet-4": {
    name: "claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    providerId: "claude-acp",
  },
  "gpt-5.4": {
    name: "gpt-5.4",
    displayName: "GPT-5.4",
    providerId: "claude-acp",
  },
};

class ImmediatelyResolved<T> implements PromiseLike<T> {
  constructor(private readonly value: T) {}

  // biome-ignore lint/suspicious/noThenProperty: this test helper intentionally models immediate PromiseLike resolution.
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): PromiseLike<TResult1 | TResult2> {
    if (!onfulfilled) {
      return Promise.resolve(this.value as unknown as TResult1);
    }
    return Promise.resolve(onfulfilled(this.value));
  }
}

function immediatelyResolved<T>(value: T): Promise<T> {
  return new ImmediatelyResolved(value) as unknown as Promise<T>;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock("@/shared/api/acp", () => ({
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
  acpSetSessionConfigOption: (...args: unknown[]) =>
    mockAcpSetSessionConfigOption(...args),
  acpCreateSession: (...args: unknown[]) => mockAcpCreateSession(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    host: {
      defaultsRead: (...args: unknown[]) => mockGooseDefaultsRead(...args),
      preferencesRead: (...args: unknown[]) =>
        mockGoosePreferencesRead(...args),
      preferencesSave: (...args: unknown[]) =>
        mockGoosePreferencesSave(...args),
      providersSupportedModelsList: (...args: unknown[]) =>
        mockSupportedModelsList(...args),
      sessionArchive: (...args: unknown[]) => mockAcpSessionArchive(...args),
    },
  }),
}));

vi.mock("../useChat", () => ({
  useChat: (
    sessionId: string,
    providerOverride?: string,
    systemPromptOverride?: string,
    personaInfo?: { id: string; name: string },
    options?: {
      ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
      onMessageAccepted?: (
        sessionId: string,
        text: string,
      ) => boolean | undefined;
    },
  ) => {
    mockUseChatHook(
      sessionId,
      providerOverride,
      systemPromptOverride,
      personaInfo,
    );
    const optionsWithSessionId = { ...options, __sessionId: sessionId };
    return {
      messages: [],
      chatState: mockUseChatRuntime.chatState,
      tokenState: null,
      sendMessage: (...args: unknown[]) =>
        mockUseChatSendMessage(optionsWithSessionId, ...args),
      steerMessage: (...args: unknown[]) => mockUseChatSteerMessage(...args),
      compactConversation: vi.fn(),
      stopStreaming: vi.fn(),
      streamingMessageId: null,
      activeRunId: mockUseChatRuntime.activeRunId,
      isRunCancellationPending: mockUseChatRuntime.isRunCancellationPending,
    };
  },
}));

vi.mock("../useMessageQueue", () => ({
  useMessageQueue: (...args: unknown[]) => mockUseMessageQueue(...args),
}));

vi.mock("../useAutoCompactPreferences", () => ({
  useAutoCompactPreferences: () => ({
    autoCompactEnabled: false,
    autoCompactThresholdPercent: 80,
    preferencesLoading: false,
    setAutoCompactEnabled: vi.fn(),
    setAutoCompactThresholdPercent: vi.fn(),
  }),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  preSeedDraftAgent: (...args: unknown[]) => mockPreSeedDraftAgent(...args),
  clearBuilderSessionState: (...args: unknown[]) =>
    mockClearBuilderSessionState(...args),
  markAgentBuilderSessionPreparationFailed: (...args: unknown[]) =>
    mockMarkAgentBuilderSessionPreparationFailed(...args),
}));

vi.mock("@/shared/api/agents", () => ({
  deletePersonaSource: (...args: unknown[]) => mockDeletePersonaSource(...args),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listDistillAppSkills: (...args: unknown[]) =>
    mockListDistillAppSkills(...args),
  listHostSourceSkills: (...args: unknown[]) =>
    mockListGooseSourceSkills(...args),
  listSkills: (...args: unknown[]) => mockListSkills(...args),
}));

vi.mock("@/features/chat/api/workspaceContext", () => ({
  loadWorkspaceInstructionFiles: (...args: unknown[]) =>
    mockLoadWorkspaceInstructionFiles(...args),
}));

// The project folder's own documents, which is where the wiki pointer's
// presence check looks. Outside the desktop runtime these are no-ops, so the
// mock only makes the answer steerable.
vi.mock("@/shared/api/projectStore", () => ({
  listProjectDocuments: (...args: unknown[]) =>
    mockListProjectDocuments(...args),
  readProjectDocument: (...args: unknown[]) => mockReadProjectDocument(...args),
  writeProjectDocument: (...args: unknown[]) =>
    mockWriteProjectDocument(...args),
}));

vi.mock("@/features/agents/hooks/useProviderSelection", () => ({
  useProviderSelection: () => ({
    providers: [
      { id: "claude-acp", label: "Claude Code" },
      { id: "codex-acp", label: "Codex" },
      { id: "claude-acp", label: "OpenAI" },
      { id: "claude-acp", label: "Anthropic" },
    ],
    providersLoading: false,
    selectedProvider: useAgentStore.getState().selectedProvider ?? "claude-acp",
    setSelectedProvider: (...args: unknown[]) =>
      mockSetSelectedProvider(...args),
  }),
}));

vi.mock("@/features/projects/lib/sessionCwdSelection", () => ({
  resolveSessionCwd: (...args: unknown[]) => mockResolveSessionCwd(...args),
}));

vi.mock("../useAgentModelPickerState", () => ({
  useAgentModelPickerState: ({
    onProviderSelected,
    onModelSelected,
  }: {
    onProviderSelected?: (providerId: string) => void;
    onModelSelected?: (model: {
      id: string;
      name: string;
      displayName?: string;
      providerId?: string;
    }) => void;
  }) => ({
    selectedAgentId: mockPickerState.selectedAgentId,
    pickerAgents: mockPickerState.pickerAgents,
    availableModels: mockPickerState.availableModels,
    getModelsForAgent: (agentId: string) =>
      mockPickerState.modelsByAgent.get(agentId) ??
      mockPickerState.availableModels,
    // Defaults to the same list: only the tests that care about an inventory
    // the cache no longer vouches for set the two apart.
    getInstalledModelsForAgent: (agentId: string) =>
      mockPickerState.installedModelsByAgent.get(agentId) ??
      mockPickerState.modelsByAgent.get(agentId) ??
      mockPickerState.availableModels,
    isModelInventoryAuthoritative: () => mockPickerState.inventoryAuthoritative,
    modelsLoading: mockPickerState.modelsLoading,
    modelStatusMessage: mockPickerState.modelStatusMessage,
    handleProviderChange: (providerId: string) =>
      onProviderSelected?.(providerId),
    handleModelChange: (modelId: string) => {
      const model = modelFixtures[modelId];
      if (model) {
        onModelSelected?.({
          id: modelId,
          name: model.name,
          displayName: model.displayName,
          providerId: model.providerId,
        });
      }
    },
    handlePickerOpen: () => mockPickerOpen(),
  }),
}));

import { useChatSessionController } from "../useChatSessionController";

function latestMessageQueueArgs() {
  const call = mockUseMessageQueue.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call as [
    string,
    string,
    unknown,
    boolean | undefined,
    boolean | undefined,
  ];
}

function expectSessionPreparation({
  sessionId,
  modelProviderId,
  workingDir = "/tmp/project",
  modelId,
  forceConfigRefresh,
}: {
  sessionId: string;
  modelProviderId: string;
  workingDir?: string;
  modelId?: string;
  forceConfigRefresh?: boolean;
}) {
  expect(mockAcpPrepareSession).toHaveBeenCalledWith(
    sessionId,
    modelProviderId,
    workingDir,
    expect.objectContaining({
      ...(modelId ? { modelId } : {}),
      ...(forceConfigRefresh ? { forceConfigRefresh: true } : {}),
    }),
  );
}

function catalogSkill(name: string) {
  return {
    id: `project:/tmp/project/.agents/skills/${name}`,
    name,
    description: `${name} description`,
    instructions: "Full instructions are not part of the catalog.",
    path: `/tmp/project/.agents/skills/${name}`,
    fileLocation: `/tmp/project/.agents/skills/${name}/SKILL.md`,
    sourceKind: "project",
    sourceLabel: "project",
    projectLinks: [],
    readonly: false,
    color: null,
  };
}

function sessionFixture(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Chat",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

function personaFixture(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "persona-1",
    displayName: "Research Scout",
    systemPrompt: "Gather context.",
    isBuiltin: false,
    writable: true,
    ...overrides,
  };
}

describe("useChatSessionController", () => {
  afterEach(cleanup);

  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    vi.clearAllMocks();
    delete modelFixtures["legacy-v1-model"];
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "appDefault",
        config: DEFAULT_RUNTIME_CONFIG,
      },
      config: DEFAULT_RUNTIME_CONFIG,
    });
    window.localStorage.clear();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      waveExecutorSessionIds: [],
    });
    setMultiWorkspaceEnabled(true);
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
        onMessageAccepted?: (
          sessionId: string,
          text: string,
        ) => boolean | undefined;
        __sessionId?: string;
      }) => {
        await options?.ensurePrepared?.();
        return true;
      },
    );
    mockUseMessageQueue.mockImplementation(
      (
        _sessionId: string,
        _chatState: string,
        sendMessage: (
          text: string,
          persona?: { id: string },
          attachments?: unknown[],
          sendOptions?: unknown,
        ) => boolean | Promise<boolean>,
      ) => ({
        queuedMessage: null,
        enqueue: (
          text: string,
          personaId?: string,
          attachments?: unknown[],
          sendOptions?: unknown,
          personaName?: string,
        ) => {
          const persona = personaId
            ? useAgentStore
                .getState()
                .personas.find((candidate) => candidate.id === personaId)
            : undefined;
          void sendMessage(
            text,
            personaId
              ? {
                  id: personaId,
                  ...((personaName ?? persona?.displayName) && {
                    name: personaName ?? persona?.displayName,
                  }),
                }
              : undefined,
            attachments,
            sendOptions,
          );
          return true;
        },
        dismiss: vi.fn(),
      }),
    );
    mockDeletePersonaSource.mockResolvedValue(undefined);
    mockListSkills
      .mockReset()
      .mockImplementation(() => immediatelyResolved([]));
    mockListDistillAppSkills
      .mockReset()
      .mockImplementation(() => immediatelyResolved([]));
    mockListGooseSourceSkills.mockReset().mockResolvedValue([]);
    mockLoadWorkspaceInstructionFiles.mockImplementation(() =>
      immediatelyResolved([]),
    );
    resetProjectWikiPresenceForTests();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    mockListProjectDocuments.mockReset().mockResolvedValue([]);
    mockReadProjectDocument.mockReset().mockResolvedValue(null);
    mockWriteProjectDocument.mockReset().mockResolvedValue(undefined);
    useProviderCatalogStore.getState().reset();
    useProviderCatalogStore.getState().setEntries([
      {
        id: "claude-acp",
        displayName: "Claude Code",
        category: "agent",
        description: "Claude Code",
        setupMethod: "none",
        group: "default",
      },
      {
        id: "codex-acp",
        displayName: "Codex",
        category: "agent",
        description: "OpenAI's coding agent",
        setupMethod: "cli_auth",
        binaryName: "codex-acp",
        group: "default",
        aliases: ["codex-acp", "codex_cli", "codex-cli", "codex"],
      },
    ]);
    mockAcpPrepareSession.mockResolvedValue(undefined);
    mockAcpSetSessionConfigOption.mockResolvedValue(undefined);
    mockAcpCreateSession.mockResolvedValue({
      sessionId: "session-recovered",
      configOptionsSnapshot: undefined,
    });
    mockAcpSessionArchive.mockResolvedValue(undefined);
    mockResolveSessionCwd.mockResolvedValue("/tmp/project");
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: null,
      modelId: null,
    });
    mockGoosePreferencesRead.mockResolvedValue({ values: [] });
    mockGoosePreferencesSave.mockResolvedValue(undefined);
    mockSupportedModelsList.mockResolvedValue({ models: [] });
    mockPreSeedDraftAgent.mockResolvedValue({
      path: "/Users/x/.agents/agents/draft-from-chat.md",
      slug: "draft-from-chat",
    });
    mockPickerState.selectedAgentId = "claude-acp";
    mockPickerState.pickerAgents = [{ id: "claude-acp", label: "Claude Code" }];
    mockPickerState.availableModels = [];
    mockPickerState.modelsByAgent.clear();
    mockPickerState.installedModelsByAgent.clear();
    mockPickerState.inventoryAuthoritative = false;
    mockPickerState.modelsLoading = false;
    mockPickerState.modelStatusMessage = null;
    mockUseChatRuntime.chatState = "idle";
    mockUseChatRuntime.activeRunId = null;
    mockUseChatRuntime.isRunCancellationPending = false;

    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      agents: [],
      agentsLoading: false,
      providers: [],
      providersLoading: false,
      selectedProvider: "claude-acp",
      activeAgentId: null,
      isLoading: false,
    });

    useProjectStore.setState({
      projects: [],
      loading: false,
      activeProjectId: null,
    });

    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      queuedMessageBySession: {},
      scrollTargetMessageBySession: {},
      loadingSessionIds: new Set(),
      activeSessionId: null,
      isConnected: true,
    });

    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "claude-acp",
            modelProviderId: "claude-acp",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
        }),
      ],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
  });

  describe("persona run settings", () => {
    const OPUS_EFFORTS = [
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
      { id: "xhigh", name: "Extra high" },
    ];

    function rankedPersona() {
      return personaFixture({
        modelRanking: serializeAgentModelRanking({
          version: 1,
          entries: [
            {
              platform: "claude-acp",
              modelId: "claude-opus-5",
              label: "Opus 5",
              effort: "xhigh",
              fastMode: true,
            },
          ],
        }),
      });
    }

    function offerOpus() {
      mockPickerState.availableModels = [
        {
          id: "claude-opus-5",
          name: "claude-opus-5",
          displayName: "Opus 5",
          providerId: "claude-acp",
          efforts: OPUS_EFFORTS,
          supportsFast: true,
        },
      ];
    }

    it("keeps an effort chosen in the composer over the persona's", () => {
      useAgentStore.setState({ personas: [rankedPersona()] });
      offerOpus();

      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: null, isHomeSession: true }),
      );
      act(() => {
        result.current.handleReasoningEffortChange("low");
      });
      act(() => {
        result.current.handlePersonaChange("persona-1");
      });

      expect(result.current.pendingRunSettings).toEqual({
        effort: "low",
        fast: true,
      });
    });
  });

  it("flushes a pending draft store write on unmount", () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("unsaved draft");
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        undefined,
      );

      act(() => {
        unmount();
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        "unsaved draft",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore a debounced draft after an accepted send clears it", async () => {
    vi.useFakeTimers();
    try {
      mockUseChatSendMessage.mockImplementationOnce(
        async (options?: {
          ensurePrepared?: () => Promise<boolean | undefined>;
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
          __sessionId?: string;
        }) => {
          options?.onMessageAccepted?.(
            options.__sessionId ?? "session-1",
            "hello",
          );
          await options?.ensurePrepared?.();
          return true;
        },
      );
      mockUseMessageQueue.mockImplementationOnce(
        (
          _sessionId: string,
          _chatState: string,
          sendMessage: (
            text: string,
            persona?: { id: string; name?: string },
            attachments?: unknown[],
            sendOptions?: unknown,
          ) => boolean | Promise<boolean>,
        ) => ({
          queuedMessage: null,
          enqueue: (
            text: string,
            personaId?: string,
            attachments?: unknown[],
            sendOptions?: unknown,
          ) =>
            sendMessage(
              text,
              personaId ? { id: personaId } : undefined,
              attachments,
              sendOptions,
            ),
          dismiss: vi.fn(),
        }),
      );
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("hello");
      });

      await act(async () => {
        await result.current.handleSend("hello");
      });

      expect(
        useChatStore.getState().draftsBySession["session-1"],
      ).toBeUndefined();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(
        useChatStore.getState().draftsBySession["session-1"],
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a newer draft when an older send is accepted later", async () => {
    vi.useFakeTimers();
    try {
      let acceptCommittedMessage!: (text: string) => void;
      mockUseChatSendMessage.mockImplementationOnce(
        (options?: {
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
          __sessionId?: string;
        }) => {
          acceptCommittedMessage = (text: string) => {
            const sessionId = options?.__sessionId ?? "session-1";
            const shouldClearDraft =
              options?.onMessageAccepted?.(sessionId, text) !== false;
            if (shouldClearDraft) {
              useChatStore.getState().clearDraft(sessionId);
            }
          };
        },
      );
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("first");
      });
      act(() => {
        result.current.handleSend("first");
      });
      act(() => {
        result.current.handleDraftChange("");
        result.current.handleDraftChange("second");
      });

      act(() => {
        acceptCommittedMessage("first");
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        "second",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a debounced draft to the backend session id when a draft session is promoted", () => {
    vi.useFakeTimers();
    try {
      useChatSessionStore.setState({
        sessions: [
          sessionFixture({
            id: "draft-session",
            clientSessionId: "draft-session",
            executionTarget: {
              harnessId: "claude-acp",
              modelProviderId: "claude-acp",
            },
            projectId: "project-1",
            creationState: "pending",
          }),
        ],
      });

      const { result, rerender } = renderHook(
        ({ sessionId }: { sessionId: string }) =>
          useChatSessionController({ sessionId }),
        {
          initialProps: { sessionId: "draft-session" },
        },
      );

      act(() => {
        result.current.handleDraftChange("draft during promotion");
      });
      expect(
        useChatStore.getState().draftsBySession["draft-session"],
      ).toBeUndefined();

      act(() => {
        useChatStore
          .getState()
          .promoteSessionId("draft-session", "backend-session");
        useChatSessionStore
          .getState()
          .promoteDraftSession("draft-session", "backend-session");
      });
      rerender({ sessionId: "backend-session" });

      expect(useChatStore.getState().draftsBySession["backend-session"]).toBe(
        "draft during promotion",
      );
      expect(
        useChatStore.getState().draftsBySession["draft-session"],
      ).toBeUndefined();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(useChatStore.getState().draftsBySession["backend-session"]).toBe(
        "draft during promotion",
      );
      expect(
        useChatStore.getState().draftsBySession["draft-session"],
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a newer draft when a pending send drains after promotion", () => {
    vi.useFakeTimers();
    try {
      let acceptCommittedMessage!: (sessionId: string, text: string) => void;
      mockUseChatSendMessage.mockImplementationOnce(
        (options?: {
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
        }) => {
          acceptCommittedMessage = (sessionId, text) => {
            if (options?.onMessageAccepted?.(sessionId, text) !== false) {
              useChatStore.getState().clearDraft(sessionId);
            }
          };
        },
      );
      useChatSessionStore.setState({
        sessions: [
          sessionFixture({
            id: "draft-session",
            clientSessionId: "draft-session",
            executionTarget: {
              harnessId: "claude-acp",
              modelProviderId: "claude-acp",
            },
            creationState: "pending",
          }),
        ],
      });

      const { result, rerender } = renderHook(
        ({ sessionId }: { sessionId: string }) =>
          useChatSessionController({ sessionId }),
        { initialProps: { sessionId: "draft-session" } },
      );

      act(() => {
        expect(result.current.handleSend("send when ready")).toBe(true);
        result.current.handleDraftChange("newer draft");
        useChatStore
          .getState()
          .promoteSessionId("draft-session", "backend-session");
        useChatSessionStore
          .getState()
          .promoteDraftSession("draft-session", "backend-session");
      });
      rerender({ sessionId: "backend-session" });
      const [, , drainQueuedMessage] = latestMessageQueueArgs();
      act(() => {
        (drainQueuedMessage as (text: string) => void)("send when ready");
      });

      act(() => {
        acceptCommittedMessage("backend-session", "send when ready");
        vi.advanceTimersByTime(300);
      });

      expect(useChatStore.getState().draftsBySession["backend-session"]).toBe(
        "newer draft",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards in-flight Agent Builder preparation when its queue record is removed", async () => {
    const pendingDraft = deferred<{ path: string; slug: string }>();
    mockPreSeedDraftAgent.mockReturnValueOnce(pendingDraft.promise);
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "make a reviewer",
      sendOptions: {
        chips: [{ label: "agent-builder", type: "skill" }],
      },
    });
    const queuedRecord =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0];

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("session-1");
    });
    act(() => {
      useChatStore
        .getState()
        .dismissQueuedMessage("session-1", queuedRecord?.recordId);
    });
    await act(async () => {
      pendingDraft.resolve({
        path: "/Users/x/.agents/agents/removed-queue-record.md",
        slug: "removed-queue-record",
      });
      await pendingDraft.promise;
    });

    await waitFor(() => {
      expect(mockDeletePersonaSource).toHaveBeenCalledWith(
        "/Users/x/.agents/agents/removed-queue-record.md",
      );
    });
    const session = useChatSessionStore.getState().getSession("session-1");
    expect(session?.intent).toBeUndefined();
    expect(session?.targetAgentPath).toBeUndefined();
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
  });

  it("marks queued Agent Builder preparation as failed without dropping its send", async () => {
    mockPreSeedDraftAgent.mockRejectedValueOnce(
      new Error("draft creation failed"),
    );
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "make a reviewer",
      sendOptions: {
        chips: [{ label: "agent-builder", type: "skill" }],
      },
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(mockMarkAgentBuilderSessionPreparationFailed).toHaveBeenCalledWith(
        "session-1",
      );
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toHaveLength(1);
  });

  it("routes a pending project first send through workspace startup", () => {
    setMultiWorkspaceEnabled(true);
    const onWorkspaceNameRequest = vi.fn();
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/tmp/project.md",
          name: "Project",
          description: "",
          prompt: "",
          icon: "",
          color: "#22c55e",
          projectWorkspaces: [
            {
              id: "workspace-1",
              path: "/repo/project",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: false,
              repositoryPath: "/repo/project",
              startupMode: "worktree",
            },
          ],
          workingDirs: ["/repo/project"],
          useWorktrees: true,
          order: 0,
          archivedAt: null,
          artifact: null,
        },
      ],
      loading: false,
      activeProjectId: "project-1",
    });
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          clientSessionId: "draft-session",
          projectId: "project-1",
          workingDir: "/repo/project",
          workspaceAttachments: [],
          executionTarget: {
            harnessId: "claude-acp",
            modelProviderId: "claude-acp",
          },
          creationState: "pending",
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({
        sessionId: "draft-session",
        onWorkspaceNameRequest,
      }),
    );

    act(() => {
      expect(result.current.handleSend("send after setup")).toBe(true);
    });

    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0],
    ).toMatchObject({
      kind: "deferred",
      payload: { text: "send after setup" },
      state: { type: "workspace-first-send", status: "choice" },
    });
  });

  it("blocks queued sends while a stopped backend run is still active", () => {
    mockUseChatRuntime.chatState = "idle";
    mockUseChatRuntime.activeRunId = "run-1";

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const [, , , , isSendBlocked] = latestMessageQueueArgs();
    expect(isSendBlocked).toBe(true);
  });

  it("waits for complete workspace context before freezing queued execution", async () => {
    const skillsDeferred = deferred<ReturnType<typeof catalogSkill>[]>();
    const enqueue = vi.fn();
    mockListSkills.mockReturnValue(skillsDeferred.promise);
    mockLoadWorkspaceInstructionFiles.mockResolvedValue([
      {
        path: "/tmp/project/AGENTS.md",
        workspacePaths: ["/tmp/project"],
        content: "workspace instructions are ready",
      },
    ]);
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      enqueue,
      dismiss: vi.fn(),
    }));
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "claude-acp",
            modelProviderId: "claude-acp",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(latestMessageQueueArgs()[1]).toBe("thinking");

    act(() => {
      expect(result.current.handleSend("hello")).toBe(true);
    });

    const queuedSendOptions = enqueue.mock.calls[0]?.[3];
    const queuedExecutionTarget = enqueue.mock.calls[0]?.[5];
    // Only the telemetry surface stamp is captured this early — no execution
    // context may freeze before the workspace context is ready.
    expect(queuedSendOptions).toEqual({});
    expect(queuedExecutionTarget).toBeUndefined();
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      skillsDeferred.resolve([catalogSkill("code-review")]);
      await skillsDeferred.promise;
    });

    await waitFor(() => {
      expect(latestMessageQueueArgs()[1]).toBe("idle");
    });

    const drainSend = latestMessageQueueArgs()[2] as (
      text: string,
      persona?: { id: string; name?: string },
      attachments?: unknown[],
      sendOptions?: ChatSendOptions,
    ) => boolean | Promise<boolean>;
    await act(async () => {
      await drainSend("hello", undefined, undefined, undefined);
    });

    const executionSystemPrompt =
      mockUseChatSendMessage.mock.calls.at(-1)?.[4]?.executionSystemPrompt;
    expect(executionSystemPrompt).toContain("<included-workspaces>");
    expect(executionSystemPrompt).toContain("workspace instructions are ready");
    expect(executionSystemPrompt).toContain("code-review");
  });

  it("queues persona-switch sends immediately with immutable FIFO selections", async () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          displayName: "Codex Planner",
          systemPrompt: "Plan clearly.",
          provider: "codex-acp",
        }),
        personaFixture({
          id: "persona-2",
          displayName: "Goose Reviewer",
          systemPrompt: "Review carefully.",
          provider: "claude-acp",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "claude-acp",
            modelProviderId: "claude-acp",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });
    mockPickerState.modelsByAgent.set("claude-acp", [
      {
        id: "goose-claude-opus-4-8",
        name: "Claude Opus 4.8",
        providerId: "claude-acp",
      },
    ]);
    const queued: Array<{
      text: string;
      personaId?: string | null;
      personaName?: string;
      sendOptions?: ChatSendOptions;
    }> = [];
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      queuedRecords: queued.map((payload, index) => ({
        id: `queued-${index}`,
        kind: "transport-ready" as const,
        payload,
        createdAt: index,
      })),
      enqueue: (
        text: string,
        personaId?: string | null,
        _attachments?: ChatAttachmentDraft[],
        sendOptions?: ChatSendOptions,
        personaName?: string,
      ) => {
        queued.push({
          text,
          personaId,
          personaName,
          sendOptions,
        });
        return true;
      },
      dismiss: vi.fn(),
    }));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      expect(result.current.handleSend("no persona", null)).toBe(true);
      expect(result.current.handleSend("plan", "persona-1")).toBe(true);
      expect(result.current.handleSend("review", "persona-2")).toBe(true);
    });

    expect(queued).toEqual([
      {
        text: "no persona",
        personaId: null,
        personaName: undefined,
        sendOptions: {},
      },
      {
        text: "plan",
        personaId: "persona-1",
        personaName: "Codex Planner",
        sendOptions: {
          capturedPersonaSystemPrompt: expect.stringContaining("Plan clearly."),
        },
      },
      {
        text: "review",
        personaId: "persona-2",
        personaName: "Goose Reviewer",
        sendOptions: {
          capturedPersonaSystemPrompt:
            expect.stringContaining("Review carefully."),
        },
      },
    ]);
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("skips navigation and archives the fresh session when a newer pick supersedes the recreate mid-flight", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));

    // Suspend the recovery's createSession so a second pick can land while the
    // fresh session is still being born.
    const create = deferred<{
      sessionId: string;
      configOptionsSnapshot: undefined;
    }>();
    mockAcpCreateSession.mockReturnValueOnce(create.promise);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    // First switch strands the provider and kicks off a recreate that suspends
    // inside createSession.
    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });

    // A second pick lands mid-recreate, bumping the picker's shared version
    // counter so the in-flight recreate is now superseded.
    act(() => {
      result.current.handleProviderChange("codex-acp");
    });

    // Let the suspended recreate finish creating its (now stale) session.
    create.resolve({
      sessionId: "session-recovered",
      configOptionsSnapshot: undefined,
    });

    // The superseded recreate archives the empty session it just created rather
    // than orphaning it, closing the empty-accumulation gap under a rapid
    // double-switch.
    await waitFor(() => {
      expect(mockAcpSessionArchive).toHaveBeenCalledWith({
        sessionId: "session-recovered",
      });
    });
    // ...and never navigates onto the stale target — the newer pick owns
    // activation, so the user is not left on the superseded provider.
    expect(useChatSessionStore.getState().activeSessionId).not.toBe(
      "session-recovered",
    );
    expect(useChatStore.getState().activeSessionId).not.toBe(
      "session-recovered",
    );
    // The superseded recreate must not persist its stale model choice either —
    // the newer pick owns the preference, so the discarded selection leaves no
    // residue in goose:preferredModelsByAgent.
    expect(
      window.localStorage.getItem("distill:preferredModelsByAgent"),
    ).toBeNull();
  });

  it("does not recover a session that has assistant history", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));

    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          {
            id: "user-1",
            role: "user",
            created: 0,
            content: [{ type: "text", text: "hello" }],
          },
          {
            id: "assistant-1",
            role: "assistant",
            created: 1,
            content: [{ type: "text", text: "hi there" }],
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    // The switch failure surfaces through the normal rollback path instead.
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledTimes(1);
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  describe("a stored model preference on an agent switch", () => {
    const RETIRED = {
      modelId: "gpt-5.3-codex-spark",
      modelName: "GPT-5.3-Codex-Spark",
      providerId: "codex-acp",
    };
    const SERVED: ModelOption = {
      id: "gpt-6-astra",
      name: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      providerId: "codex-acp",
    };

    function switchToCodex(stored: typeof RETIRED) {
      window.localStorage.setItem(
        "distill:preferredModelsByAgent",
        JSON.stringify({ "codex-acp": stored }),
      );
      mockPickerState.modelsByAgent.set("codex-acp", [SERVED]);
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );
      act(() => {
        result.current.handleProviderChange("codex-acp");
      });
    }

    it("goes back to the previous agent when the agent cannot be kept either", async () => {
      mockAcpPrepareSession
        .mockRejectedValueOnce(
          new ModelFailedAfterProviderMoveError(
            "codex-acp",
            new Error("Invalid value for config option model"),
          ),
        )
        .mockRejectedValueOnce(new Error("bridge exited"));
      switchToCodex(RETIRED);

      await waitFor(() => {
        expect(
          mockAcpPrepareSession.mock.calls.some(
            ([, providerId]) => providerId === "claude-acp",
          ),
        ).toBe(true);
      });
      // The preference was never proven wrong on its own, so it stays.
      expect(
        window.localStorage.getItem("distill:preferredModelsByAgent"),
      ).not.toBeNull();
    });
  });

  it("does not prepare or dispatch an unresolved existing session", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Existing chat",
          workingDir: "/tmp/project",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const preparationResults: Array<boolean | undefined> = [];
    const promptTransport = vi.fn();
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: () => Promise<boolean | undefined>;
      }) => {
        const prepared = await options?.ensurePrepared?.();
        preparationResults.push(prepared);
        if (prepared !== false) promptTransport();
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend("keep the backend model");
    });

    await waitFor(() => {
      expect(preparationResults).toEqual([false]);
    });
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
    expect(promptTransport).not.toHaveBeenCalled();

    act(() => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", {
          harnessId: "claude-acp",
          modelProviderId: "claude-acp",
          modelId: "gpt-5.6",
          modelName: "GPT-5.6",
        });
      result.current.handleSend("now use the explicit model");
    });

    await waitFor(() => {
      expect(preparationResults).toEqual([false, true]);
      expect(promptTransport).toHaveBeenCalledOnce();
    });
    expectSessionPreparation({
      sessionId: "session-1",
      modelProviderId: "claude-acp",
      modelId: "gpt-5.6",
    });
  });

  it("rejects a captured send target when the UI changes before cwd resolves", async () => {
    const capturedTarget = {
      harnessId: "claude-acp" as const,
      modelProviderId: "claude-acp",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    };
    const capturedCwd = deferred<string>();
    const preparationResults: Array<boolean | undefined> = [];
    const promptTransport = vi.fn();
    mockResolveSessionCwd.mockReset();
    mockResolveSessionCwd
      .mockReturnValueOnce(capturedCwd.promise)
      .mockResolvedValue("/tmp/project");
    mockUseChatSendMessage.mockImplementationOnce(
      async (
        options?: {
          ensurePrepared?: (
            personaId?: string,
            sessionSelection?: ChatSendOptions["sessionSelection"],
          ) => Promise<boolean | undefined>;
        },
        _text?: string,
        _persona?: unknown,
        _attachments?: unknown,
        sendOptions?: ChatSendOptions,
      ) => {
        const prepared = await options?.ensurePrepared?.(
          undefined,
          sendOptions?.sessionSelection,
        );
        preparationResults.push(prepared);
        if (prepared !== false) promptTransport();
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend(
        "use the captured model",
        undefined,
        undefined,
        {
          sessionSelection: capturedTarget,
        },
      );
    });
    await waitFor(() => {
      expect(mockResolveSessionCwd).toHaveBeenCalledOnce();
    });

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });
    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "claude-acp",
        modelId: "claude-sonnet-4",
      });
    });

    await act(async () => {
      capturedCwd.resolve("/tmp/project");
      await capturedCwd.promise;
    });

    await waitFor(() => {
      expect(preparationResults).toEqual([false]);
    });
    expect(promptTransport).not.toHaveBeenCalled();
    expect(mockAcpPrepareSession).toHaveBeenCalledTimes(1);
    expect(mockAcpPrepareSession).not.toHaveBeenCalledWith(
      "session-1",
      "claude-acp",
      expect.anything(),
      expect.objectContaining({ modelId: "gpt-4o" }),
    );
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual({
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });

  it("queues Home attachments and migrates them when a real session becomes active", async () => {
    mockUseMessageQueue.mockImplementation((sessionId: string) => ({
      queuedMessage:
        useChatStore.getState().queuedMessageBySession[sessionId] ?? null,
      enqueue: (
        text: string,
        personaId?: string,
        attachments?: ChatAttachmentDraft[],
        sendOptions?: ChatSendOptions,
      ) =>
        useChatStore.getState().enqueueTransportReadyMessage(sessionId, {
          persona: { kind: "inherit" },
          text,
          ...(personaId ? { personaId } : {}),
          ...(attachments ? { attachments } : {}),
          ...(sendOptions ? { sendOptions } : {}),
        }),
      dismiss: () => useChatStore.getState().dismissQueuedMessage(sessionId),
    }));
    const imageDraft = {
      id: "home-image",
      kind: "image" as const,
      name: "home.png",
      mimeType: "image/png",
      base64: "home-base64",
      previewUrl: "blob:home",
    };

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      {
        initialProps: { sessionId: null as string | null },
      },
    );

    await waitFor(() =>
      expect(result.current.workspaceContextReady).toBe(true),
    );
    act(() => {
      result.current.handleSend("", undefined, [imageDraft]);
    });

    expect(
      useChatStore.getState().queuedMessageBySession.__home_pending__?.[0]
        ?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "",
      attachments: [imageDraft],
      sendOptions: {
        executionSystemPrompt: MEMORY_PROTOCOL_PROMPT,
      },
    });

    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "session-home-attachments",
          executionTarget: {
            harnessId: "claude-acp",
            modelProviderId: "claude-acp",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-home-attachments" });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession[
          "session-home-attachments"
        ]?.[0]?.payload,
      ).toEqual({
        persona: { kind: "inherit" },
        text: "",
        attachments: [imageDraft],
        // Migration preserves the operator protocols accepted in Home.
        sendOptions: {
          executionSystemPrompt: MEMORY_PROTOCOL_PROMPT,
        },
      });
    });
    expect(
      useChatStore.getState().queuedMessageBySession.__home_pending__,
    ).toBeUndefined();
  });

  it("unparks restored Home messages after attaching them to a ready session", async () => {
    useChatStore.setState({
      queuedMessageBySession: {
        __home_pending__: [
          {
            kind: "transport-ready",
            recordId: "restored-home",
            payload: {
              persona: { kind: "inherit" },
              text: "restored from Home",
            },
            restored: true,
          },
        ],
      },
    });
    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "session-restored-home",
          executionTarget: {
            harnessId: "claude-acp",
            modelProviderId: "claude-acp",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    renderHook(() =>
      useChatSessionController({
        sessionId: "session-restored-home",
        isHomeSession: true,
      }),
    );

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession[
          "session-restored-home"
        ]?.[0],
      ).toMatchObject({
        recordId: "restored-home",
        payload: {
          persona: { kind: "inherit" },
          text: "restored from Home",
        },
      });
    });
    expect(
      useChatStore.getState().queuedMessageBySession[
        "session-restored-home"
      ]?.[0],
    ).not.toHaveProperty("restored");
  });

  // Regression coverage for the `distill_chat` send-telemetry anchor: both events
  // fire from the user-message-commit callback, so an attempt that fails
  // before committing emits nothing and the queue's automatic retry of the
  // same payload emits exactly once, when it finally commits.

  // LAWS/MEMORY.md, Writing: "A wave-spawned executor MUST NOT receive the
  // operator's memories or the protocols that reach them." The conductor
  // evicts a finished child's node, after which the graph reports an ordinary
  // chat and only the memory store's record still knows.
  describe("the operator's memory block", () => {
    function composedSystemPrompt(): string {
      const calls = mockUseChatHook.mock.calls;
      const [, , systemPromptOverride] = (calls[calls.length - 1] ?? []) as [
        string,
        string | undefined,
        string | undefined,
      ];
      return systemPromptOverride ?? "";
    }

    const globalFact = {
      id: "memory-1",
      text: "A global fact",
      scope: "global" as const,
      projectId: null,
      createdAt: 0,
    };

    it("stays away from a wave child whose graph node was evicted", () => {
      useMemoryStore.setState({
        entries: [globalFact],
        waveExecutorSessionIds: ["session-1"],
      });

      renderHook(() => useChatSessionController({ sessionId: "session-1" }));

      expect(composedSystemPrompt()).not.toContain("A global fact");
    });
  });

  describe("project instructions and memory on queued sends", () => {
    function composedSystemPrompt(): string {
      const calls = mockUseChatHook.mock.calls;
      const [, , systemPromptOverride] = (calls[calls.length - 1] ?? []) as [
        string,
        string | undefined,
        string | undefined,
      ];
      return systemPromptOverride ?? "";
    }

    function seedProject() {
      useProjectStore.setState({
        projects: [
          {
            id: "p-1",
            path: "/projects/quarp",
            name: "Quarp",
            description: "",
            prompt: "Follow Quarp's project instructions.",
            icon: "",
            color: "",
            projectWorkspaces: [],
            workingDirs: ["/work/quarp"],
            useWorktrees: false,
            order: 0,
            archivedAt: null,
          },
        ],
        loading: false,
        activeProjectId: "p-1",
      });
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === "session-1"
            ? { ...session, projectId: "p-1" }
            : session,
        ),
      }));
    }

    function seedWaveChild() {
      useConductorGraphStore.setState({
        nodesById: {
          "session-1": {
            sessionId: "session-1",
            projectId: "p-1",
            role: "worker",
            managedBy: "wave",
            parentSessionId: "conductor-1",
            rootConductorId: "conductor-1",
            runId: "run-1",
            harnessId: "goose",
            displayName: "Scout · step",
            status: "running",
          },
        },
        reportsByRunId: {},
      });
    }

    const globalFact = {
      id: "memory-1",
      text: "A standing fact captured with the message.",
      scope: "global" as const,
      projectId: null,
      createdAt: 0,
    };

    function seedRunningChat(
      identity: "plain" | "managedBy wave" | "waveExecutorSessionIds",
    ) {
      seedProject();
      useMemoryStore.setState({ entries: [globalFact] });
      if (identity === "managedBy wave") seedWaveChild();
      if (identity === "waveExecutorSessionIds") {
        useMemoryStore.setState({ waveExecutorSessionIds: ["session-1"] });
      }
      mockUseChatRuntime.chatState = "thinking";
      useChatSessionStore.getState().patchSession("session-1", {
        messageCount: 1,
        workingDir: "/work/quarp",
        workspaceAttachments: [
          {
            id: workspaceAttachmentIdForPath("/work/quarp"),
            path: "/work/quarp",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: true,
          },
        ],
      });
    }

    function expectMemoryScope(prompt: string, isPlain: boolean) {
      expect(prompt).toContain("<project-instructions>");
      expect(prompt).toContain("Follow Quarp's project instructions.");
      const operatorParts = [
        "<memory>",
        globalFact.text,
        MEMORY_PROTOCOL_PROMPT,
      ];
      for (const part of operatorParts) {
        if (isPlain) expect(prompt).toContain(part);
        else expect(prompt).not.toContain(part);
      }
      if (isPlain) {
        const orderedParts = [
          "Follow Quarp's project instructions.",
          ...operatorParts,
        ];
        for (let index = 1; index < orderedParts.length; index += 1) {
          expect(prompt.indexOf(orderedParts[index])).toBeGreaterThan(
            prompt.indexOf(orderedParts[index - 1]),
          );
        }
      }
    }

    it.each([
      "plain",
      "managedBy wave",
      "waveExecutorSessionIds",
    ] as const)("accepts a %s message during the first workspace read without freezing an incomplete prompt", async (identity) => {
      seedRunningChat(identity);
      const files =
        deferred<
          Array<{ path: string; content: string; workspacePaths: string[] }>
        >();
      mockLoadWorkspaceInstructionFiles.mockReturnValue(files.promise);
      const enqueue = vi.fn().mockReturnValue(true);
      mockUseMessageQueue.mockImplementation(() => ({
        queuedMessage: null,
        enqueue,
        dismiss: vi.fn(),
      }));
      const { result, rerender } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );
      await waitFor(() =>
        expect(mockLoadWorkspaceInstructionFiles).toHaveBeenCalledTimes(1),
      );
      expect(result.current.workspaceContextReady).toBe(false);
      act(() => {
        expect(result.current.handleSend("first queued turn")).toBe(true);
      });
      expect(enqueue).toHaveBeenCalledTimes(1);
      const acceptedOptions = enqueue.mock.calls[0][3] as ChatSendOptions;
      expect(acceptedOptions.executionSystemPrompt).toBeUndefined();
      expect(mockUseChatSendMessage).not.toHaveBeenCalled();

      await act(async () => {
        files.resolve([
          {
            path: "/work/quarp/AGENTS.md",
            content: "Workspace instructions.",
            workspacePaths: ["/work/quarp"],
          },
        ]);
        await files.promise;
      });
      await waitFor(() =>
        expect(result.current.workspaceContextReady).toBe(true),
      );
      mockUseChatRuntime.chatState = "idle";
      rerender();
      const drainSend = latestMessageQueueArgs()[2] as (
        text: string,
        persona: undefined,
        attachments: undefined,
        options: ChatSendOptions,
      ) => Promise<boolean>;
      await act(async () => {
        await drainSend(
          "first queued turn",
          undefined,
          undefined,
          acceptedOptions,
        );
      });
      expect(
        mockUseChatSendMessage.mock.calls[0][4].executionSystemPrompt,
      ).toContain("Workspace instructions.");
      expectMemoryScope(
        mockUseChatSendMessage.mock.calls[0][4].executionSystemPrompt,
        identity === "plain",
      );
    });

    it.each([
      "plain",
      "managedBy wave",
      "waveExecutorSessionIds",
    ] as const)("freezes project instructions and memory at queue acceptance for %s", async (identity) => {
      seedRunningChat(identity);
      const enqueue = vi.fn().mockReturnValue(true);
      mockUseMessageQueue.mockImplementation(() => ({
        queuedMessage: null,
        enqueue,
        dismiss: vi.fn(),
      }));
      const { result, rerender } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );
      await waitFor(() => {
        expect(result.current.workspaceContextReady).toBe(true);
        expectMemoryScope(composedSystemPrompt(), identity === "plain");
      });
      expect(latestMessageQueueArgs()[1]).toBe("thinking");

      act(() => {
        expect(result.current.handleSend("next turn")).toBe(true);
      });

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(mockUseChatSendMessage).not.toHaveBeenCalled();
      const capturedOptions = enqueue.mock.calls[0][3] as ChatSendOptions;
      const capturedPrompt = capturedOptions.executionSystemPrompt;
      expect(capturedPrompt).toBeTypeOf("string");
      expectMemoryScope(capturedPrompt ?? "", identity === "plain");

      // A later turn refreshes the visible context; the accepted send must
      // still carry exactly the memory it captured earlier.
      await act(async () => {
        useMemoryStore.setState({
          entries: [
            { ...globalFact, text: "A newer memory after acceptance." },
          ],
        });
        useChatSessionStore.getState().patchSession("session-1", {
          updatedAt: "2026-09-22T12:00:00.000Z",
        });
      });
      if (identity === "plain") {
        await waitFor(() => {
          expect(composedSystemPrompt()).toContain(
            "A newer memory after acceptance.",
          );
        });
      }
      mockUseChatRuntime.chatState = "idle";
      rerender();
      const drainSend = latestMessageQueueArgs()[2] as (
        text: string,
        persona: undefined,
        attachments: undefined,
        sendOptions: ChatSendOptions,
      ) => Promise<boolean>;
      await act(async () => {
        await drainSend("next turn", undefined, undefined, capturedOptions);
      });

      expect(mockUseChatSendMessage).toHaveBeenCalledTimes(1);
      const dispatchedPrompt =
        mockUseChatSendMessage.mock.calls[0][4].executionSystemPrompt;
      expect(dispatchedPrompt).toBe(capturedPrompt);
      expectMemoryScope(dispatchedPrompt, identity === "plain");
      expect(dispatchedPrompt).not.toContain(
        "A newer memory after acceptance.",
      );
    });

    it("releases the queue when optional instruction reads fail", async () => {
      seedRunningChat("plain");
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockLoadWorkspaceInstructionFiles.mockRejectedValue(
        new Error("Workspace unavailable"),
      );
      mockListProjectDocuments.mockRejectedValue(
        new Error("Project unavailable"),
      );
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );
      await waitFor(() =>
        expect(result.current.workspaceContextReady).toBe(true),
      );
      expect(composedSystemPrompt()).not.toContain("<workspace-instructions>");
      expect(composedSystemPrompt()).toContain(globalFact.text);
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to load workspace instructions:",
        expect.any(Error),
      );
    });
  });
});
