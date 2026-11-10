import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelOption } from "@/features/chat/types";
import { HomeComposer } from "./HomeComposer";
import {
  useChatSessionStore,
  type ChatSession,
} from "../../stores/chatSessionStore";

const transcriptImport = vi.hoisted(() => ({
  open: vi.fn(),
  read: vi.fn(),
  append: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: transcriptImport.open }));
vi.mock("@/shared/api/acpApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/acpApi")>()),
  importSessionTranscript: transcriptImport.append,
}));
vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/sessionActivation")
  >()),
  loadSessionMessages: transcriptImport.reload,
}));

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["claude-acp"]),
    agentReadiness: new Map([["claude-acp", "ready"]]),
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn(async () => "/Users/test"),
  searchFilesForMentions: vi.fn(async () => []),
  inspectAttachmentPaths: vi.fn(async () => []),
  readImageAttachment: vi.fn(async () => ({ base64: "", mimeType: "" })),
  readTextFile: transcriptImport.read,
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: vi.fn(async () => []),
}));

vi.mock("@/features/skills/api/skillsQuery", () => ({
  fetchSkillsList: vi.fn(async () => []),
}));

const controller = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@/features/chat/hooks/useChatSessionController", () => ({
  useChatSessionController: () => controller.current,
}));

/** Opus 4.6: five stops and no xhigh, as the host declares it. */
const opus46: ModelOption = {
  id: "claude-opus-4-6",
  name: "Opus 4.6",
  providerId: "claude-acp",
  efforts: [
    { id: "default", name: "Default" },
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
    { id: "max", name: "Max" },
  ],
  defaultEffort: "default",
  supportsFast: false,
  capabilitySource: "declared",
};

const haiku: ModelOption = {
  id: "claude-haiku-4-5",
  name: "Haiku 4.5",
  providerId: "claude-acp",
  efforts: [],
  supportsFast: false,
  capabilitySource: "probed",
};

function controllerWithoutSession(model: ModelOption) {
  return {
    deferredWorkspaceRecord: null,
    queue: {
      queuedRecords: [],
      queuedMessage: null,
      update: vi.fn(),
      beginEditing: vi.fn(),
      cancelEditing: vi.fn(),
      dismiss: vi.fn(),
    },
    handleSend: vi.fn(),
    steerQueuedMessage: vi.fn(),
    canSteerQueuedMessage: false,
    projectMetadataPending: false,
    unresolvedDeferredSend: false,
    sendDeferredAnyway: vi.fn(),
    stopStreaming: vi.fn(),
    chatState: "idle",
    deferredWorkspaceError: null,
    draftValue: "",
    draftAttachments: [],
    handleDraftChange: vi.fn(),
    handleDraftAttachmentsChange: vi.fn(),
    selectedSkills: [],
    handleSkillsChange: vi.fn(),
    personas: [],
    selectedPersonaId: null,
    handlePersonaChange: vi.fn(),
    pickerAgents: [{ id: "claude-acp", label: "Claude Code" }],
    providersLoading: false,
    selectedProvider: "claude-acp",
    handleProviderChange: vi.fn(),
    currentModelId: model.id,
    currentModelProviderId: "claude-acp",
    currentModelName: model.name,
    currentModelOption: model,
    currentExecutionTarget: undefined,
    availableModels: [opus46, haiku],
    modelsLoading: false,
    modelStatusMessage: null,
    handleModelChange: vi.fn(),
    handlePickerOpen: vi.fn(),
    // A session's own menu, which must NOT be what Home shows before its
    // session exists.
    reasoningEffort: undefined,
    handleReasoningEffortChange: vi.fn(),
    ultracodeArmed: false,
    handleUltracodeArmedChange: vi.fn(),
    fastMode: undefined,
    desiredFastMode: undefined,
    pendingRunSettings: undefined,
    handleFastModeChange: vi.fn(),
    runSettingsNotice: null,
    selectedProjectId: null,
    availableProjects: [],
    handleProjectChange: vi.fn(),
    tokenState: {
      accumulatedTotal: 0,
      contextLimit: undefined,
      accumulatedCost: null,
    },
    isContextUsageReady: false,
  };
}

function renderHome() {
  return render(<HomeComposer sessionId={null} onActivateSession={vi.fn()} />);
}

function importedSession(id: string, messageCount = 0): ChatSession {
  return {
    id,
    title: "Example chat",
    workingDir: "C:\\example",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount,
  };
}

async function chooseLoadChat() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Attach" }));
  await user.click(screen.getByRole("menuitem", { name: "Load chat" }));
}

describe("HomeComposer", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useChatSessionStore.setState({ sessions: [], activeSessionId: null });
    transcriptImport.open
      .mockReset()
      .mockResolvedValue("C:\\example\\chat.json");
    transcriptImport.read
      .mockReset()
      .mockResolvedValue({ contents: '{"messages":[]}' });
    transcriptImport.append.mockReset().mockResolvedValue({ messageCount: 2 });
    transcriptImport.reload.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it("imports into Home's session even when no chat is globally active", async () => {
    controller.current = controllerWithoutSession(opus46);
    const home = importedSession("home-chat");
    useChatSessionStore.setState({ sessions: [home], activeSessionId: null });
    const onActivate = vi.fn();
    render(<HomeComposer sessionId={home.id} onActivateSession={onActivate} />);

    await chooseLoadChat();

    await waitFor(() => expect(onActivate).toHaveBeenCalledWith(home.id));
    expect(transcriptImport.append).toHaveBeenCalledWith(
      home.id,
      '{"messages":[]}',
    );
    expect(transcriptImport.reload).toHaveBeenCalledWith(home.id, {
      force: true,
    });
    expect(
      useChatSessionStore.getState().getSession(home.id)?.messageCount,
    ).toBe(2);
    expect(controller.current.handleSend).not.toHaveBeenCalled();
  });

  it("creates a Home session after choosing a file and opens the imported chat", async () => {
    controller.current = controllerWithoutSession(opus46);
    const home = importedSession("new-home-chat");
    const ensureSession = vi.fn(async () => {
      useChatSessionStore.setState({ sessions: [home] });
      return home;
    });
    const onActivate = vi.fn();
    render(
      <HomeComposer
        sessionId={null}
        ensureSession={ensureSession}
        onActivateSession={onActivate}
      />,
    );

    await chooseLoadChat();

    await waitFor(() => expect(onActivate).toHaveBeenCalledWith(home.id));
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(transcriptImport.append).toHaveBeenCalledWith(
      home.id,
      '{"messages":[]}',
    );
    expect(controller.current.handleSend).not.toHaveBeenCalled();
  });

  it("keeps the destination when another chat becomes globally active during file selection", async () => {
    controller.current = controllerWithoutSession(opus46);
    const home = importedSession("home-chat", 3);
    const other = importedSession("other-chat", 7);
    useChatSessionStore.setState({
      sessions: [home, other],
      activeSessionId: home.id,
    });
    transcriptImport.open.mockImplementation(async () => {
      useChatSessionStore.setState({ activeSessionId: other.id });
      return "C:\\example\\chat.json";
    });
    const onActivate = vi.fn();
    render(<HomeComposer sessionId={home.id} onActivateSession={onActivate} />);

    await chooseLoadChat();

    await waitFor(() => expect(onActivate).toHaveBeenCalledWith(home.id));
    expect(transcriptImport.append).toHaveBeenCalledWith(
      home.id,
      '{"messages":[]}',
    );
    expect(
      useChatSessionStore.getState().getSession(home.id)?.messageCount,
    ).toBe(5);
    expect(
      useChatSessionStore.getState().getSession(other.id)?.messageCount,
    ).toBe(7);
  });

  it("does not create a chat when the file picker is cancelled", async () => {
    controller.current = controllerWithoutSession(opus46);
    transcriptImport.open.mockResolvedValue(null);
    const ensureSession = vi.fn();
    render(
      <HomeComposer
        sessionId={null}
        ensureSession={ensureSession}
        onActivateSession={vi.fn()}
      />,
    );

    await chooseLoadChat();

    expect(ensureSession).not.toHaveBeenCalled();
    expect(transcriptImport.read).not.toHaveBeenCalled();
    expect(transcriptImport.append).not.toHaveBeenCalled();
  });

  it("hands a stop chosen before the session exists to the controller", async () => {
    const user = userEvent.setup();
    const current = controllerWithoutSession(opus46);
    controller.current = current;
    renderHome();

    await user.click(
      screen.getByRole("button", { name: "Reasoning effort: Default" }),
    );
    await user.click(await screen.findByRole("radio", { name: "Max" }));

    expect(current.handleReasoningEffortChange).toHaveBeenCalledWith("max");
  });

  it("shows a queued dispatch failure on Home and clears it when the controller recovers", () => {
    const current = controllerWithoutSession(opus46);
    controller.current = {
      ...current,
      error: "Restore the saved model before sending this queued message.",
      queue: {
        ...current.queue,
        queuedRecords: [
          {
            kind: "transport-ready",
            recordId: "example-record",
            payload: { text: "Public example", persona: { kind: "none" } },
          },
        ],
      },
    };
    const view = renderHome();
    expect(screen.getByRole("alert").textContent).toBe(
      "Restore the saved model before sending this queued message.",
    );
    controller.current = { ...controller.current, error: null };
    view.rerender(
      <HomeComposer sessionId={null} onActivateSession={vi.fn()} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the actionable deferred-workspace error ahead of an older dispatch error", () => {
    controller.current = {
      ...controllerWithoutSession(opus46),
      error: "Older dispatch error",
      unresolvedDeferredSend: true,
      deferredWorkspaceError: "Select a model before sending.",
    };
    renderHome();
    expect(screen.getByRole("alert").textContent).toBe(
      "Select a model before sending.",
    );
    expect(screen.queryByText("Older dispatch error")).toBeNull();
  });
});
