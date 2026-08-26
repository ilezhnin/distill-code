import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

const agentTelemetryMocks = vi.hoisted(() => ({
  trackAgentCreateCompleted: vi.fn(),
  trackAgentEditCompleted: vi.fn(),
  trackAgentDeleteCompleted: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

const avatarApiMocks = vi.hoisted(() => ({
  importAgentAvatarFile: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

vi.mock("@/features/agents/lib/agentTelemetry", () => agentTelemetryMocks);

vi.mock("@/features/agents/hooks/usePersonaSource", () => ({
  usePersonaSource: vi.fn(),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  promoteDraft: vi.fn(),
  fileStem: (path: string) => path.split("/").pop()?.replace(/\.md$/, ""),
  isPlaceholderAgentName: (name: string) =>
    name === "Untitled agent" || name.startsWith("Untitled agent "),
  PLACEHOLDER_AGENT_NAME: "Untitled agent",
  PLACEHOLDER_AGENT_BODY: "Draft in progress.",
  PLACEHOLDER_AGENT_DESCRIPTION: "Draft",
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.open,
}));

vi.mock("@/shared/api/avatars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/avatars")>()),
  importAgentAvatarFile: avatarApiMocks.importAgentAvatarFile,
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: vi.fn((selector?: (state: unknown) => unknown) => {
    const state = { providers: [], personas: [] };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose"]),
    agentReadiness: new Map([["goose", "ready"]]),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { AgentBuilderRail } from "../AgentBuilderRail";
import { usePersonaSource } from "@/features/agents/hooks/usePersonaSource";
import { promoteDraft } from "@/features/agents/lib/agentBuilderSession";
import type { AgentSourceEntry } from "@/shared/api/agents";

type UsePersonaSourceReturn = ReturnType<typeof usePersonaSource>;

const baseSource: AgentSourceEntry = {
  type: "agent",
  path: "/Users/x/.agents/agents/draft-1.md",
  name: "Untitled agent",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true, builderSessionId: "s1" },
  writable: true,
} as AgentSourceEntry;

function mockHook(overrides: Partial<UsePersonaSourceReturn> = {}) {
  const result: UsePersonaSourceReturn = {
    data: baseSource,
    isLoading: false,
    error: null,
    update: vi.fn(),
    saveStatus: "saved",
    saveNow: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  vi.mocked(usePersonaSource).mockReturnValue(result);
  return result;
}

describe("AgentBuilderRail", () => {
  beforeEach(() => {
    vi.mocked(usePersonaSource).mockReset();
    vi.mocked(promoteDraft).mockReset();
    dialogMocks.open.mockReset();
    avatarApiMocks.importAgentAvatarFile.mockReset();
    avatarApiMocks.importAgentAvatarFile.mockResolvedValue(
      "user-avatar:agent-1",
    );
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    agentTelemetryMocks.trackAgentCreateCompleted.mockReset();
    agentTelemetryMocks.trackAgentEditCompleted.mockReset();
    agentTelemetryMocks.trackAgentDeleteCompleted.mockReset();
  });

  it("renders the 'New agent' header when the source still has the placeholder name", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(
      screen.getByRole("heading", { name: /new agent/i }),
    ).toBeInTheDocument();
  });

  it("renders the full-page builder and expands chat", () => {
    mockHook();
    const onExpandChat = vi.fn();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        fullPage
        onExpandChat={onExpandChat}
      />,
    );

    expect(screen.getByTestId("agent-builder-rail")).toHaveAttribute(
      "data-full-page",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /show chat/i }));
    expect(onExpandChat).toHaveBeenCalledTimes(1);
  });

  it("renders the source's real name when changed", () => {
    mockHook({ data: { ...baseSource, name: "Snark" } });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByRole("heading", { name: /snark/i })).toBeInTheDocument();
  });

  it("calls update() when the name field changes", () => {
    const { update } = mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    fireEvent.change(screen.getByLabelText(/agent name/i), {
      target: { value: "Snark" },
    });
    expect(update).toHaveBeenCalledWith({ name: "Snark" });
  });

  it("calls update() when the instructions textarea changes", () => {
    const { update } = mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    fireEvent.change(screen.getByLabelText(/agent instructions/i), {
      target: { value: "Be snarky." },
    });
    expect(update).toHaveBeenCalledWith({ content: "Be snarky." });
  });

  it("allows an incomplete draft to be saved when leaving", async () => {
    const saveNow = vi.fn().mockResolvedValue(true);
    mockHook({ saveNow });
    let saveDraft: (() => boolean | Promise<boolean>) | null = null;
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onSaveDraftHandlerChange={(handler) => {
          saveDraft = handler;
        }}
      />,
    );

    expect(screen.getByLabelText(/description/i)).toHaveValue("");
    await waitFor(() => expect(saveDraft).not.toBeNull());
    const registeredSave = saveDraft as unknown as () => Promise<boolean>;
    await expect(registeredSave()).resolves.toBe(true);
    expect(saveNow).toHaveBeenCalledOnce();
  });

  it("calls update() when the description field changes", () => {
    const { update } = mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: "Catches bugs before you ship them." },
    });
    expect(update).toHaveBeenCalledWith({
      description: "Catches bugs before you ship them.",
    });
  });

  it("treats the placeholder draft description as empty in the field", () => {
    mockHook({ data: { ...baseSource, description: "Draft" } });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByLabelText(/description/i)).toHaveValue("");
  });

  it("renders the placeholder draft body as muted placeholder text", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    const textarea = screen.getByLabelText(/agent instructions/i);
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute("placeholder", "Draft in progress.");
  });

  it("does not render the custom avatar URL field", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(screen.queryByLabelText(/custom avatar url/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /select avatar/i }),
    ).toBeInTheDocument();
  });

  it("disables save changes until required fields are complete", () => {
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/required:/i)).not.toHaveTextContent(/avatar/i);
    expect(screen.getByText(/required:/i)).toHaveTextContent(/description/i);
    expect(screen.getByLabelText(/description/i)).toBeRequired();
    expect(screen.getByLabelText(/description/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("does not persist a default avatar when the draft opens", async () => {
    const { update } = mockHook();

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /select avatar/i }),
      ).toBeInTheDocument();
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("imports an avatar image when the avatar target is clicked", async () => {
    const { update } = mockHook();
    dialogMocks.open.mockResolvedValue("/Users/x/Pictures/avatar.gif");
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select avatar/i }));

    await waitFor(() =>
      expect(avatarApiMocks.importAgentAvatarFile).toHaveBeenCalledWith({
        agentPath: baseSource.path,
        sourcePath: "/Users/x/Pictures/avatar.gif",
      }),
    );
    expect(update).toHaveBeenCalledWith({
      properties: { avatar: "user-avatar:agent-1" },
    });
  });

  it("promotes an otherwise-complete draft without provider or model overrides", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
        description: "A sharp, witty agent.",
        content: "Be snarky.",
        properties: {
          draft: true,
          builderSessionId: "s1",
          avatar: "app-avatar:gloopy-1",
        },
      },
    });
    vi.mocked(promoteDraft).mockResolvedValue({
      ...baseSource,
      name: "Snark",
      description: "A sharp, witty agent.",
      content: "Be snarky.",
      properties: {
        avatar: "app-avatar:gloopy-1",
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
    });
  });

  it("promotes the draft when save changes is clicked with complete fields", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
        description: "A sharp, witty agent.",
        content: "Be snarky.",
        properties: {
          draft: true,
          builderSessionId: "s1",
          avatar: "app-avatar:gloopy-1",
          provider: "openai",
          model: "gpt-5",
        },
      },
    });
    const promotedSource = {
      ...baseSource,
      path: "/Users/x/.agents/agents/snark.md",
      name: "Snark",
      description: "A sharp, witty agent.",
      content: "Be snarky.",
      properties: {
        avatar: "app-avatar:gloopy-1",
        provider: "openai",
        model: "gpt-5",
      },
    };
    vi.mocked(promoteDraft).mockResolvedValue(promotedSource);
    const onDraftPromoted = vi.fn();

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onDraftPromoted={onDraftPromoted}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
      expect(onDraftPromoted).toHaveBeenCalledWith(promotedSource);
    });
    expect(agentTelemetryMocks.trackAgentCreateCompleted).toHaveBeenCalledTimes(
      1,
    );
    expect(agentTelemetryMocks.trackAgentCreateCompleted).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5",
    });
    expect(agentTelemetryMocks.trackAgentEditCompleted).not.toHaveBeenCalled();
  });

  it("does not promote when flushing rail edits fails", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Snark",
        description: "A sharp, witty agent.",
        content: "Be snarky.",
        properties: {
          draft: true,
          builderSessionId: "s1",
          avatar: "app-avatar:gloopy-1",
          provider: "openai",
          model: "gpt-5",
        },
      },
      saveStatus: "error",
      error: "load",
      saveNow: vi.fn().mockResolvedValue(false),
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /save changes|retry save/i }),
    );

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
    });
    expect(promoteDraft).not.toHaveBeenCalled();
  });

  it("allows existing agents to save without draft-only required metadata", async () => {
    const { saveNow } = mockHook({
      data: {
        ...baseSource,
        name: "Code Reviewer",
        description: "Reviews code for correctness.",
        content: "",
        properties: {},
      },
    });
    vi.mocked(promoteDraft).mockResolvedValue({
      ...baseSource,
      name: "Code Reviewer",
      content: "",
      properties: {},
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="code-reviewer"
      />,
    );

    const button = screen.getByRole("button", { name: /save changes/i });
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);

    await waitFor(() => {
      expect(saveNow).toHaveBeenCalled();
      expect(promoteDraft).toHaveBeenCalledWith("s1");
    });
  });

  it("does not render the legacy Provider/Model selects", () => {
    mockHook({
      data: {
        ...baseSource,
        name: "Code Reviewer",
        properties: { provider: "grok-acp", model: "grok-4-6" },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="code-reviewer"
      />,
    );

    // The ranking list is the only model-selection UI now; the old single
    // provider/model pair surfaces through it instead of separate selects.
    expect(screen.queryByText("Provider")).toBeNull();
    expect(screen.queryByText("Model")).toBeNull();
    expect(screen.getByTestId("model-ranking-field")).toBeInTheDocument();
  });

  it("seeds a legacy single model as the visible first ranking row", () => {
    mockHook({
      data: {
        ...baseSource,
        name: "Code Reviewer",
        properties: { provider: "grok-acp", model: "grok-4-6" },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="code-reviewer"
      />,
    );

    const rows = screen.getAllByTestId("model-ranking-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("grok-4-6");
    // The seed is labeled as such — a migration the operator cannot see
    // would be a silent substitution (D5).
    expect(screen.getByTestId("model-ranking-legacy-note")).toBeInTheDocument();
  });

  it("does not seed the legacy model when the role's built-in order applies", () => {
    // "Acceptor" maps to a bundled role class, which the runtime prefers
    // over the single model — a seed row here would show a ranking that
    // resolution would not actually walk first.
    mockHook({
      data: {
        ...baseSource,
        name: "Acceptor",
        properties: { provider: "grok-acp", model: "grok-4-6" },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="acceptor"
      />,
    );

    expect(screen.queryAllByTestId("model-ranking-row")).toHaveLength(0);
    expect(screen.getByTestId("model-ranking-empty")).toBeInTheDocument();
  });

  it("lets the operator remove the seeded legacy row without it respawning", () => {
    const { update } = mockHook({
      data: {
        ...baseSource,
        name: "Code Reviewer",
        properties: { provider: "grok-acp", model: "grok-4-6" },
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="code-reviewer"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove", hidden: true }),
    );

    // Clearing writes an explicit null so a stored ranking would be removed,
    // and the display seed stands down instead of reappearing.
    expect(update).toHaveBeenCalledWith({
      properties: { model_ranking: null },
    });
    expect(screen.queryAllByTestId("model-ranking-row")).toHaveLength(0);
    expect(screen.getByTestId("model-ranking-empty")).toBeInTheDocument();
  });

  describe("berd_agent Edit Completed", () => {
    const existingAgentSource: AgentSourceEntry = {
      ...baseSource,
      path: "/Users/x/.agents/agents/code-reviewer.md",
      name: "Code Reviewer",
      description: "Reviews code for correctness.",
      content: "Review code carefully.",
      properties: { provider: "openai", model: "gpt-5" },
    };

    function lastPersonaSourceOptions() {
      return vi.mocked(usePersonaSource).mock.calls.at(-1)?.[1];
    }

    // A saveNow double that behaves like the real flush persisting
    // `persisted`: it reports the write through the rail's onWritePersisted
    // before resolving, exactly as usePersonaSource does.
    function persistingSaveNow(persisted: AgentSourceEntry) {
      return vi.fn().mockImplementation(async () => {
        lastPersonaSourceOptions()?.onWritePersisted?.(persisted);
        return true;
      });
    }

    function renderExistingAgentRail() {
      return renderWithProviders(
        <AgentBuilderRail
          sessionId="s1"
          targetAgentPath={existingAgentSource.path}
          targetAgentSlug="code-reviewer"
        />,
      );
    }

    it("does not fire for a no-op Save with nothing to persist", async () => {
      const { saveNow } = mockHook({ data: existingAgentSource });
      vi.mocked(promoteDraft).mockResolvedValue(existingAgentSource);
      renderExistingAgentRail();

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(saveNow).toHaveBeenCalled();
        expect(promoteDraft).toHaveBeenCalledWith("s1");
      });
      expect(
        agentTelemetryMocks.trackAgentEditCompleted,
      ).not.toHaveBeenCalled();
      expect(
        agentTelemetryMocks.trackAgentCreateCompleted,
      ).not.toHaveBeenCalled();
    });

    it("fires once from the persisted write when a real edit saves", async () => {
      const persisted = {
        ...existingAgentSource,
        name: "Code Reviewer Deluxe",
      };
      mockHook({
        data: existingAgentSource,
        saveNow: persistingSaveNow(persisted),
      });
      vi.mocked(promoteDraft).mockResolvedValue(persisted);
      renderExistingAgentRail();

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(promoteDraft).toHaveBeenCalledWith("s1");
      });
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledTimes(
        1,
      );
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5",
      });
      expect(
        agentTelemetryMocks.trackAgentCreateCompleted,
      ).not.toHaveBeenCalled();
    });

    it("still fires when the post-save source lookup comes back empty", async () => {
      const persisted = {
        ...existingAgentSource,
        name: "Code Reviewer Deluxe",
      };
      const saveNow = persistingSaveNow(persisted);
      mockHook({ data: existingAgentSource, saveNow });
      vi.mocked(promoteDraft).mockResolvedValue(null);
      renderExistingAgentRail();

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(saveNow).toHaveBeenCalled();
        expect(promoteDraft).toHaveBeenCalledWith("s1");
      });
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledTimes(
        1,
      );
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5",
      });
    });

    it("tracks non-draft persisted writes and stays silent for draft writes", () => {
      mockHook();
      renderWithProviders(
        <AgentBuilderRail
          sessionId="s1"
          targetAgentPath={baseSource.path}
          targetAgentSlug="draft-1"
        />,
      );
      const options = lastPersonaSourceOptions();

      // A draft write is the create flow's incremental auto-save.
      options?.onWritePersisted?.(baseSource);
      expect(
        agentTelemetryMocks.trackAgentEditCompleted,
      ).not.toHaveBeenCalled();

      // A non-draft write is a real edit no matter which caller ran saveNow
      // (Save button, leave-builder Keep, builder close).
      options?.onWritePersisted?.(existingAgentSource);
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledTimes(
        1,
      );
      expect(agentTelemetryMocks.trackAgentEditCompleted).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5",
      });
    });
  });

  it("does not show a back button in the agent editor", () => {
    mockHook({
      data: {
        ...baseSource,
        name: "Code Reviewer",
        properties: {},
      },
    });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="code-reviewer"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /back to agent/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a close affordance only when the source is a draft", () => {
    mockHook({
      data: {
        ...baseSource,
        properties: { draft: false },
      },
    });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="existing"
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /close agent builder/i }),
    ).toBeNull();
  });

  it("invokes onClose when the draft close button is clicked", () => {
    const onClose = vi.fn();
    mockHook();
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /close agent builder/i }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a Loading state while the source is loading", () => {
    mockHook({ data: null, isLoading: true });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByText(/loading agent/i)).toBeInTheDocument();
  });

  it("renders a preparing state while the draft target is pending", () => {
    mockHook({ data: null, error: "missing", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={null}
        targetAgentSlug={null}
      />,
    );

    expect(screen.getByText(/preparing draft/i)).toBeInTheDocument();
    expect(screen.queryByText(/draft missing/i)).not.toBeInTheDocument();
    expect(vi.mocked(usePersonaSource).mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("renders a retry state when preparing the draft target fails", () => {
    const onRecoverMissingDraft = vi.fn();
    mockHook({ data: null, error: "missing", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={null}
        targetAgentSlug={null}
        draftState="failed"
        onRecoverMissingDraft={onRecoverMissingDraft}
      />,
    );

    expect(screen.getByText(/couldn't prepare draft/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRecoverMissingDraft).toHaveBeenCalledTimes(1);
  });

  it("renders a 'Draft missing' state when the source can't be found", () => {
    mockHook({ data: null, error: "missing", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByText(/draft missing/i)).toBeInTheDocument();
  });

  it("automatically requests recovery when a builder draft source is missing", async () => {
    const onRecoverMissingDraft = vi.fn();
    mockHook({ data: null, error: "missing", isLoading: false });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onRecoverMissingDraft={onRecoverMissingDraft}
      />,
    );

    await waitFor(() => {
      expect(onRecoverMissingDraft).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/draft missing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/loading agent/i)).toBeInTheDocument();
  });

  it("shows missing after automatic draft recovery fails", async () => {
    const onRecoverMissingDraft = vi.fn().mockRejectedValue(new Error("nope"));
    mockHook({ data: null, error: "missing", isLoading: false });

    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
        onRecoverMissingDraft={onRecoverMissingDraft}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/draft missing/i)).toBeInTheDocument();
    });
  });

  it("renders an 'Invalid frontmatter' state when the source can't be parsed", () => {
    mockHook({ data: null, error: "parse", isLoading: false });
    renderWithProviders(
      <AgentBuilderRail
        sessionId="s1"
        targetAgentPath={baseSource.path}
        targetAgentSlug="draft-1"
      />,
    );
    expect(screen.getByText(/invalid frontmatter/i)).toBeInTheDocument();
  });
});
