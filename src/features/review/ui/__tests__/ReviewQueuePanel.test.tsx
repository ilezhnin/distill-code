import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import type { SessionNode, StructuredReport } from "@/features/conductor/types";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { renderWithProviders } from "@/test/render";

import { useReviewSeenStore } from "../../stores/reviewSeenStore";
import { ReviewQueuePanel } from "../ReviewQueuePanel";

const SEEN = 1_000;

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "p",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: `run-${overrides.sessionId}`,
    harnessId: "goose",
    displayName: "Worker",
    status: "completed",
    createdAt: 1,
    finishedAt: SEEN + 100,
    ...overrides,
  };
}

function report(
  overrides: Partial<StructuredReport> & { runId: string },
): StructuredReport {
  return {
    status: "completed",
    summary: "Rebuilt the index",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...overrides,
  };
}

function seedGraph(nodes: SessionNode[], reports: StructuredReport[]) {
  useConductorGraphStore.setState({
    nodesById: Object.fromEntries(nodes.map((n) => [n.sessionId, n])),
    reportsByRunId: Object.fromEntries(reports.map((r) => [r.runId, r])),
  });
  useChatSessionStore.setState({
    sessions: [
      {
        id: "conductor-1",
        title: "Nightly build",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  } as never);
}

describe("ReviewQueuePanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatSessionStore.setState({ sessions: [] } as never);
    useReviewSeenStore.getState().reset(SEEN);
  });

  it("renders nothing when nothing finished", () => {
    renderWithProviders(<ReviewQueuePanel onOpenSession={vi.fn()} />);
    expect(screen.queryByTestId("review-queue")).not.toBeInTheDocument();
  });

  it("names the conductor and quotes its latest report", () => {
    seedGraph([node({ sessionId: "w1" })], [report({ runId: "run-w1" })]);

    renderWithProviders(<ReviewQueuePanel onOpenSession={vi.fn()} />);

    const row = screen.getByTestId("review-item");
    expect(within(row).getByText("Nightly build")).toBeInTheDocument();
    expect(within(row).getByTestId("review-summary")).toHaveTextContent(
      "Rebuilt the index",
    );
  });

  it("shows a stopped agent quietly instead of as an alarm", () => {
    seedGraph(
      [node({ sessionId: "w1", status: "cancelled" })],
      [report({ runId: "run-w1", status: "cancelled", needsOperator: true })],
    );

    renderWithProviders(<ReviewQueuePanel onOpenSession={vi.fn()} />);

    expect(screen.getByTestId("review-item")).toHaveAttribute(
      "data-outcome",
      "stopped",
    );
  });

  it("marks a conductor that is waiting on a person", () => {
    seedGraph(
      [node({ sessionId: "w1" })],
      [report({ runId: "run-w1", needsOperator: true })],
    );

    renderWithProviders(<ReviewQueuePanel onOpenSession={vi.fn()} />);

    expect(screen.getByTestId("review-item")).toHaveAttribute(
      "data-outcome",
      "needsOperator",
    );
  });

  it("opens the conductor when its row is pressed", async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    seedGraph([node({ sessionId: "w1" })], [report({ runId: "run-w1" })]);

    renderWithProviders(<ReviewQueuePanel onOpenSession={onOpenSession} />);
    await user.click(
      within(screen.getByTestId("review-item")).getByRole("button"),
    );

    expect(onOpenSession).toHaveBeenCalledWith("conductor-1");
  });

  it("empties itself only when the operator says they have read it", async () => {
    const user = userEvent.setup();
    seedGraph([node({ sessionId: "w1" })], [report({ runId: "run-w1" })]);

    renderWithProviders(<ReviewQueuePanel onOpenSession={vi.fn()} />);
    expect(screen.getByTestId("review-item")).toBeInTheDocument();

    await user.click(screen.getByTestId("review-dismiss"));

    expect(screen.queryByTestId("review-queue")).not.toBeInTheDocument();
    expect(useReviewSeenStore.getState().lastSeenAt).toBeGreaterThan(SEEN);
  });
});
