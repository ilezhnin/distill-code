import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelOption } from "@/features/chat/types";
import { HomeComposer } from "./HomeComposer";

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

describe("HomeComposer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("offers the selected model's own effort stops from the inventory while Home has no session", async () => {
    const user = userEvent.setup();
    controller.current = controllerWithoutSession(opus46);
    renderHome();

    await user.click(
      screen.getByRole("button", { name: "Reasoning effort: Default" }),
    );
    await screen.findByRole("radiogroup", { name: "Reasoning effort" });

    expect(screen.getAllByRole("radio")).toHaveLength(5);
    for (const name of ["Default", "Low", "Medium", "High", "Max"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("radio", { name: /x ?high/i })).toBeNull();
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

  it("shows no effort control for a model whose inventory row offers no efforts", () => {
    controller.current = controllerWithoutSession(haiku);
    renderHome();

    expect(
      screen.queryByRole("button", { name: /Reasoning effort/ }),
    ).toBeNull();
  });
});
