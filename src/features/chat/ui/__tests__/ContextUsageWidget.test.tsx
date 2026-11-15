import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode } from "@/features/conductor/types";
import {
  INITIAL_SESSION_CHAT_RUNTIME,
  INITIAL_TOKEN_STATE,
  type SessionChatRuntime,
} from "@/shared/types/chat";
import {
  useChatSessionStore,
  type ChatSession,
} from "../../stores/chatSessionStore";
import { useChatStore } from "../../stores/chatStore";
import { ContextUsageWidget } from "../widgets/ContextUsageWidget";

const { mockGetSessionsContextUsage } = vi.hoisted(() => ({
  mockGetSessionsContextUsage: vi.fn(),
}));

vi.mock("@/shared/api/acpApi", () => ({
  getSessionsContextUsage: mockGetSessionsContextUsage,
}));

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: null,
    rootConductorId: null,
    runId: null,
    harnessId: "claude-acp",
    displayName: overrides.sessionId,
    status: "completed",
    createdAt: 1,
    ...overrides,
  };
}

function session(
  id: string,
  title: string,
  target?: ChatSession["executionTarget"],
): ChatSession {
  return {
    id,
    title,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 0,
    ...(target ? { executionTarget: target } : {}),
  };
}

function reported(used: number, limit: number): SessionChatRuntime {
  return {
    ...INITIAL_SESSION_CHAT_RUNTIME,
    hasUsageSnapshot: true,
    tokenState: {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: used,
      contextLimit: limit,
    },
  };
}

function renderWidget(
  props: Partial<Parameters<typeof ContextUsageWidget>[0]> = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ContextUsageWidget sessionId="conductor" active {...props} />
    </QueryClientProvider>,
  );
}

const teamRow = (sessionId: string) => {
  const row = screen
    .getAllByTestId("context-team-row")
    .find((candidate) => candidate.dataset.sessionId === sessionId);
  if (!row) throw new Error(`no team row for ${sessionId}`);
  return row;
};

describe("ContextUsageWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionsContextUsage.mockResolvedValue([]);
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
    useChatSessionStore.setState({ sessions: [] });
    useConductorGraphStore.setState({ nodesById: {} });
  });

  it("shows how full the open chat's window is, and what it runs on", () => {
    useChatSessionStore.setState({
      sessions: [
        session("conductor", "Chat", {
          harnessId: "claude-acp",
          modelProviderId: "anthropic",
          modelId: "model-a",
          modelName: "Model A",
        }),
      ],
    });
    useChatStore.setState({
      sessionStateById: { conductor: reported(570_500, 1_000_000) },
    });

    renderWidget();

    const current = within(screen.getByTestId("context-usage-current"));
    expect(current.getByText("57% used")).toBeInTheDocument();
    expect(current.getByText("570.5K / 1M")).toBeInTheDocument();
    expect(current.getByText("Model A")).toBeInTheDocument();
    // A chat on its own has one window: there is no team to list.
    expect(screen.queryByTestId("context-team")).not.toBeInTheDocument();
  });

  it("says a chat has reported nothing rather than showing an empty window", async () => {
    renderWidget();

    expect(screen.getByText("No usage yet")).toBeInTheDocument();
    // Nothing live, so the stored transcript is asked.
    await waitFor(() => {
      expect(mockGetSessionsContextUsage).toHaveBeenCalledWith(["conductor"]);
    });
  });

  it("reads a count without a percentage when the harness names no window", () => {
    useChatStore.setState({
      sessionStateById: { conductor: reported(12_300, 0) },
    });

    renderWidget();

    const current = within(screen.getByTestId("context-usage-current"));
    expect(current.getByText("12.3K tokens")).toBeInTheDocument();
    expect(current.queryByText(/used$/)).not.toBeInTheDocument();
  });

  it("lists every agent of the team with its own window, whatever it runs on", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    useConductorGraphStore.setState({
      nodesById: {
        conductor: node({
          sessionId: "conductor",
          role: "conductor",
          rootConductorId: "conductor",
          displayName: "Conductor",
          status: "waiting",
        }),
        integrator: node({
          sessionId: "integrator",
          parentSessionId: "conductor",
          rootConductorId: "conductor",
          displayName: "Integrator",
          harnessId: "codex-acp",
          modelId: "model-b",
          status: "running",
          stepIndex: 0,
        }),
        acceptor: node({
          sessionId: "acceptor",
          parentSessionId: "conductor",
          rootConductorId: "conductor",
          displayName: "Acceptor",
          harnessId: "grok-acp",
          modelId: "model-c",
          stepIndex: 1,
        }),
      },
    });
    useChatStore.setState({
      sessionStateById: {
        conductor: reported(100_000, 1_000_000),
        // Live: this window heard the integrator report.
        integrator: reported(380_000, 400_000),
      },
    });
    // Not loaded since the restart: the host reads it off the transcript.
    mockGetSessionsContextUsage.mockResolvedValue([
      { sessionId: "acceptor", used: 96_000, size: 128_000 },
    ]);

    renderWidget({ onOpenSession });

    expect(screen.getAllByTestId("context-team-row")).toHaveLength(3);
    const conductorRow = teamRow("conductor");
    expect(conductorRow).toHaveAttribute("data-current", "true");
    expect(within(conductorRow).getByText("10%")).toBeInTheDocument();
    // The open chat is not a link to itself.
    expect(within(conductorRow).queryByRole("button")).not.toBeInTheDocument();

    const integratorRow = teamRow("integrator");
    expect(within(integratorRow).getByText("95%")).toBeInTheDocument();
    expect(within(integratorRow).getByText("380K / 400K")).toBeInTheDocument();
    expect(within(integratorRow).getByText("model-b")).toBeInTheDocument();
    expect(integratorRow).toHaveAttribute("data-pressure", "critical");

    const acceptorRow = teamRow("acceptor");
    expect(await within(acceptorRow).findByText("75%")).toBeInTheDocument();
    expect(within(acceptorRow).getByText("96K / 128K")).toBeInTheDocument();
    expect(acceptorRow).toHaveAttribute("data-pressure", "high");
    expect(mockGetSessionsContextUsage).toHaveBeenCalledWith([
      "acceptor",
      "conductor",
      "integrator",
    ]);

    await user.click(
      within(acceptorRow).getByRole("button", { name: /acceptor/i }),
    );
    expect(onOpenSession).toHaveBeenCalledWith("acceptor");
  });

  it("asks the host nothing while the rail is hidden", async () => {
    renderWidget({ active: false });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetSessionsContextUsage).not.toHaveBeenCalled();
  });

  it("asks the host nothing once every chat has reported live", async () => {
    useChatStore.setState({
      sessionStateById: { conductor: reported(10, 100) },
    });

    renderWidget();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetSessionsContextUsage).not.toHaveBeenCalled();
  });
});
