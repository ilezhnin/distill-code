import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRightRail } from "../ChatRightRail";

const mocks = vi.hoisted(() => ({
  patchSession: vi.fn(),
  setPersonas: vi.fn(),
  addPersona: vi.fn(),
  updatePersona: vi.fn(),
  personas: [] as Array<{ id: string }>,
  listPersonas: vi.fn(),
  recoverDraftAgent: vi.fn(),
  setAgentBuilderSessionLocalEdits: vi.fn(),
  setAgentBuilderSessionSaveHandler: vi.fn(),
  saveDraftAgentSession: vi.fn(),
  clearBuilderSessionState: vi.fn(),
  toastError: vi.fn(),
  rightRailOpen: false,
  compactViewport: false,
  reducedMotion: false,
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) },
}));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    useReducedMotion: () => mocks.reducedMotion,
  };
});

vi.mock("@/features/agents/ui/AgentBuilderRail", () => ({
  AGENT_BUILDER_RAIL_WIDTH: 506,
  AgentBuilderRail: (props: {
    targetAgentPath?: string | null;
    targetAgentSlug?: string | null;
    draftState?: "preparing" | "failed" | null;
    onDraftPromoted?: (source: unknown) => void;
    onAgentBuilderCompleted?: (agentId: string) => void;
    onDraftTargetChanged?: (target: { path: string; slug: string }) => void;
    onRecoverMissingDraft?: () => void;
    onClose?: () => void;
    onLocalEditStateChange?: (hasLocalEdits: boolean) => void;
    onSaveDraftHandlerChange?: (
      saveDraft: (() => boolean | Promise<boolean>) | null,
    ) => void;
  }) => (
    <div data-testid="agent-builder-rail">
      <span data-testid="agent-builder-target">
        {props.targetAgentPath ?? "pending"}
      </span>
      <span data-testid="agent-builder-draft-state">
        {props.draftState ?? "ready"}
      </span>
      <button
        type="button"
        onClick={() => {
          props.onDraftPromoted?.({ path: "/path" });
        }}
      >
        promote
      </button>
      <button
        type="button"
        onClick={() =>
          props.onDraftTargetChanged?.({
            path: "/Users/x/.agents/agents/moved.md",
            slug: "moved",
          })
        }
      >
        target changed
      </button>
      <button type="button" onClick={props.onRecoverMissingDraft}>
        recover
      </button>
      <button type="button" onClick={props.onClose}>
        close
      </button>
      <button
        type="button"
        onClick={() => props.onLocalEditStateChange?.(true)}
      >
        local edits
      </button>
      <button
        type="button"
        onClick={() => props.onSaveDraftHandlerChange?.(() => true)}
      >
        register save draft
      </button>
    </div>
  ),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  clearBuilderSessionState: (...args: unknown[]) =>
    mocks.clearBuilderSessionState(...args),
  recoverPendingDraftAgent: (...args: unknown[]) =>
    mocks.recoverDraftAgent(...args),
  setAgentBuilderSessionLocalEdits: (...args: unknown[]) =>
    mocks.setAgentBuilderSessionLocalEdits(...args),
  setAgentBuilderSessionSaveHandler: (...args: unknown[]) =>
    mocks.setAgentBuilderSessionSaveHandler(...args),
  saveDraftAgentSession: (...args: unknown[]) =>
    mocks.saveDraftAgentSession(...args),
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      personas: mocks.personas,
      setPersonas: mocks.setPersonas,
      addPersona: mocks.addPersona,
      updatePersona: mocks.updatePersona,
    }),
  },
}));

vi.mock("@/shared/api/agents", () => ({
  agentSourceToPersona: (source: {
    path: string;
    name?: string;
    description?: string;
    content?: string;
  }) => ({
    id: source.path,
    displayName: source.name ?? "Saved agent",
    sourceDescription: source.description,
    systemPrompt: source.content ?? "",
    isBuiltin: false,
    writable: true,
  }),
  listPersonas: () => mocks.listPersonas(),
}));

vi.mock("../../hooks/useGitStateAutoRefresh", () => ({
  useGitStateAutoRefreshOnChatSettled: vi.fn(),
}));

vi.mock("@/features/terminal/capabilities/TerminalCapability", () => ({
  TerminalCapability: () => <div data-testid="rail-terminal">Terminal</div>,
}));

vi.mock("../ChatContextPanel", () => ({
  CP_TOTAL_W: 339,
  ChatContextPanel: ({
    isVisible,
    elevated,
  }: {
    isVisible: boolean;
    elevated?: boolean;
  }) =>
    isVisible ? (
      <button type="button" data-elevated={elevated ? "true" : "false"}>
        Context content
      </button>
    ) : null,
  useChatContextPanelCompactViewport: () => mocks.compactViewport,
}));

vi.mock("../../stores/chatSessionStore", () => ({
  useChatSessionStore: (
    selector: (state: {
      isRightRailOpen: boolean;
      patchSession: typeof mocks.patchSession;
    }) => unknown,
  ) =>
    selector({
      isRightRailOpen: mocks.rightRailOpen,
      patchSession: mocks.patchSession,
    }),
}));

describe("ChatRightRail", () => {
  beforeEach(() => {
    mocks.rightRailOpen = false;
    mocks.compactViewport = false;
    mocks.reducedMotion = false;
    mocks.patchSession.mockReset();
    mocks.personas = [];
    mocks.setPersonas.mockReset();
    mocks.addPersona.mockReset();
    mocks.updatePersona.mockReset();
    mocks.listPersonas.mockReset();
    mocks.listPersonas.mockResolvedValue([]);
    mocks.recoverDraftAgent.mockReset();
    mocks.recoverDraftAgent.mockResolvedValue({
      path: "/Users/x/.agents/agents/recovered.md",
      slug: "recovered",
    });
    mocks.setAgentBuilderSessionLocalEdits.mockReset();
    mocks.setAgentBuilderSessionSaveHandler.mockReset();
    mocks.saveDraftAgentSession.mockReset();
    mocks.saveDraftAgentSession.mockResolvedValue(undefined);
    mocks.clearBuilderSessionState.mockReset();
    mocks.toastError.mockReset();
  });

  it("patches only chat session target fields when the draft target moves", () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "target changed" }));

    expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
      targetAgentPath: "/Users/x/.agents/agents/moved.md",
      targetAgentSlug: "moved",
      targetAgentDraftState: null,
    });
  });

  it("recovers a missing draft by pre-seeding and patching the chat session", async () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "recover" }));

    await waitFor(() => {
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        targetAgentDraftState: "preparing",
      });
      expect(mocks.recoverDraftAgent).toHaveBeenCalledWith("s1", "/path");
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        intent: "build-agent",
        agentBuilderOpen: true,
        targetAgentPath: "/Users/x/.agents/agents/recovered.md",
        targetAgentSlug: "recovered",
        targetAgentDraftState: null,
      });
    });
  });

  it("saves and closes the capability without archiving the chat", async () => {
    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "close" }));

    await waitFor(() => {
      expect(mocks.saveDraftAgentSession).toHaveBeenCalledWith("s1");
      expect(mocks.patchSession).toHaveBeenCalledWith("s1", {
        agentBuilderOpen: false,
        agentBuilderContextState: undefined,
      });
    });
  });

  it("keeps Agent Builder open and reports an error when closing cannot save", async () => {
    mocks.saveDraftAgentSession.mockRejectedValue(new Error("disk full"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <ChatRightRail
        contextVisible={mocks.rightRailOpen}
        session={
          {
            id: "s1",
            intent: "build-agent",
            agentBuilderOpen: true,
            targetAgentPath: "/path",
            targetAgentSlug: "draft-s1",
          } as never
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "close" }));

    await waitFor(() => {
      expect(mocks.saveDraftAgentSession).toHaveBeenCalledWith("s1");
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Save failed. Your edits are still here.",
      );
    });
    expect(mocks.patchSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ agentBuilderOpen: false }),
    );
    expect(screen.getByTestId("agent-builder-rail")).toBeVisible();
    consoleError.mockRestore();
  });
});
