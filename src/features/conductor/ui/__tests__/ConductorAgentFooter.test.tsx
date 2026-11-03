import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

import { CHIP_SUMMARY_THROTTLE_MS } from "../../brigadeChipSummary";
import type { SessionNode, StructuredReport } from "../../types";
import { ConductorAgentFooter } from "../ConductorAgentFooter";

function node(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: "worker-1",
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: "run-1",
    harnessId: "claude-acp",
    displayName: "Scout · waveEngine",
    status: "running",
    createdAt: 1_000,
    ...overrides,
  };
}

function reading(file: string, status: "completed" | "in_progress"): Message {
  return {
    id: `a-${file}`,
    role: "assistant",
    created: 2,
    content: [
      {
        type: "toolRequest",
        id: `t-${file}`,
        name: `Read ${file}`,
        toolName: "Read",
        toolKind: "read",
        arguments: { file_path: file },
        status,
        locations: [{ path: file }],
      },
    ],
  };
}

function seedWorker(
  sessionId: string,
  messages: Message[],
  runtime: Partial<typeof INITIAL_SESSION_CHAT_RUNTIME>,
) {
  useChatStore.setState((state) => ({
    messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
    sessionStateById: {
      ...state.sessionStateById,
      [sessionId]: { ...INITIAL_SESSION_CHAT_RUNTIME, ...runtime },
    },
  }));
}

const NO_REPORTS: Record<string, StructuredReport> = {};

describe("ConductorAgentFooter chips", () => {
  beforeEach(() => {
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says what a working worker is doing, with its spend and tool count", () => {
    seedWorker("worker-1", [reading("src/waveEngine.ts", "in_progress")], {
      chatState: "streaming",
      streamingMessageId: "a-src/waveEngine.ts",
      tokenState: {
        ...INITIAL_SESSION_CHAT_RUNTIME.tokenState,
        accumulatedTotal: 9_800,
      },
    });
    render(
      <ConductorAgentFooter
        nodes={[node()]}
        reportsByRunId={NO_REPORTS}
        onOpen={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("brigade-chip");
    expect(chip).toHaveAttribute("data-status", "running");
    const summary = screen.getByTestId("brigade-chip-summary");
    expect(summary).toHaveTextContent("9.8k");
    expect(summary).toHaveTextContent("1 tool");
    expect(summary).toHaveTextContent("waveEngine.ts");
    expect(screen.queryByTestId("brigade-chip-reason")).not.toBeInTheDocument();
  });

  it("holds the live words still between updates, and never the status", () => {
    vi.useFakeTimers();
    seedWorker("worker-1", [reading("src/a.ts", "in_progress")], {
      chatState: "streaming",
      streamingMessageId: "a-src/a.ts",
    });
    render(
      <ConductorAgentFooter
        nodes={[node()]}
        reportsByRunId={NO_REPORTS}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId("brigade-chip-summary")).toHaveTextContent(
      "a.ts",
    );

    act(() => {
      seedWorker(
        "worker-1",
        [reading("src/a.ts", "completed"), reading("src/b.ts", "in_progress")],
        { chatState: "streaming", streamingMessageId: "a-src/b.ts" },
      );
    });
    // Too soon: the chip still shows the previous step.
    expect(screen.getByTestId("brigade-chip-summary")).toHaveTextContent(
      "a.ts",
    );
    act(() => {
      vi.advanceTimersByTime(CHIP_SUMMARY_THROTTLE_MS);
    });
    expect(screen.getByTestId("brigade-chip-summary")).toHaveTextContent(
      "b.ts",
    );
    expect(screen.getByTestId("brigade-chip-summary")).toHaveTextContent(
      "2 tools",
    );
  });

  it("never leaves a chip at working after the worker's bridge died", () => {
    seedWorker(
      "worker-1",
      [
        {
          id: "a-last",
          role: "assistant",
          created: 3,
          content: [{ type: "text", text: "Reading the engine next." }],
          metadata: {
            completionStatus: "error",
            failureReason: "Agent process exited unexpectedly (exit code 1).",
          },
        },
      ],
      {
        chatState: "error",
        error: "Agent process exited unexpectedly (exit code 1).",
      },
    );
    render(
      <ConductorAgentFooter
        nodes={[node({ status: "running" })]}
        reportsByRunId={NO_REPORTS}
        onOpen={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("brigade-chip");
    expect(chip).toHaveAttribute("data-status", "failed");
    expect(screen.getByTestId("brigade-chip-reason")).toHaveTextContent(
      "Agent process exited unexpectedly (exit code 1).",
    );
    // A run that is gone offers nothing to stop.
    expect(
      screen.queryByTestId("conductor-agent-stop"),
    ).not.toBeInTheDocument();
  });

  it("gives a finished worker its duration and a blocked one its reason", () => {
    seedWorker("worker-1", [reading("src/a.ts", "completed")], {
      chatState: "idle",
    });
    seedWorker("worker-2", [], { chatState: "idle" });
    const reports: Record<string, StructuredReport> = {
      "run-2": {
        runId: "run-2",
        status: "blocked",
        reason: "The brief names a file that does not exist.",
        summary: "",
        decisions: [],
        artifacts: [],
        risks: [],
        needsOperator: true,
        nextSuggestedTask: null,
      },
    };
    render(
      <ConductorAgentFooter
        nodes={[
          node({ status: "completed", finishedAt: 1_000 + 130_000 }),
          node({
            sessionId: "worker-2",
            runId: "run-2",
            displayName: "Builder",
            status: "completed",
          }),
        ]}
        reportsByRunId={reports}
        onOpen={vi.fn()}
      />,
    );
    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips[0]).toHaveAttribute("data-status", "completed");
    expect(chips[0]).toHaveTextContent("1 tool · 2m 10s");
    expect(chips[1]).toHaveAttribute("data-status", "blocked");
    expect(chips[1]).toHaveTextContent(
      "The brief names a file that does not exist.",
    );
  });
});

describe("ConductorAgentFooter wave folding", () => {
  beforeEach(() => {
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
  });

  function waveNodes(
    wave: number,
    status: SessionNode["status"],
  ): SessionNode[] {
    return [0, 1].map((step) =>
      node({
        sessionId: `w${wave}-s${step}`,
        runId: `run-${wave}-${step}`,
        waveId: `wave-${wave}`,
        stepIndex: step,
        displayName: `Wave ${wave} step ${step}`,
        status: step === 1 && status === "completed" ? "cancelled" : status,
        createdAt: 1_000 + wave * 10 + step,
      }),
    );
  }

  const waveIds = () =>
    screen
      .getAllByTestId("conductor-agent-footer-wave")
      .map((wave) => wave.getAttribute("data-wave-id"));

  it("draws three waves in full without a fold", () => {
    render(
      <ConductorAgentFooter
        nodes={[0, 1, 2].flatMap((wave) => waveNodes(wave, "completed"))}
        reportsByRunId={NO_REPORTS}
      />,
    );
    expect(waveIds()).toEqual(["wave-0", "wave-1", "wave-2"]);
    expect(
      screen.queryByTestId("conductor-earlier-waves"),
    ).not.toBeInTheDocument();
  });

  it("folds older finished waves into one line and keeps working ones out", () => {
    render(
      <ConductorAgentFooter
        nodes={[
          ...waveNodes(0, "completed"),
          ...waveNodes(1, "running"),
          ...waveNodes(2, "completed"),
          ...waveNodes(3, "completed"),
          ...waveNodes(4, "completed"),
          ...waveNodes(5, "completed"),
        ]}
        reportsByRunId={NO_REPORTS}
      />,
    );
    // Waves 0 and 2 are finished and older than the newest three; wave 1 is
    // still working, so it stays drawn even though it is old.
    expect(waveIds()).toEqual(["wave-1", "wave-3", "wave-4", "wave-5"]);
    const fold = screen.getByTestId("conductor-earlier-waves");
    expect(fold).toHaveTextContent("2 earlier waves");
    expect(fold).toHaveTextContent("2 done");
    expect(fold).toHaveTextContent("2 stopped or failed");

    act(() => {
      fold.click();
    });
    expect(waveIds()).toEqual([
      "wave-0",
      "wave-2",
      "wave-1",
      "wave-3",
      "wave-4",
      "wave-5",
    ]);
  });

  it("leaves working agents to the list above the composer while it shows them", () => {
    const nodes = [
      node({ sessionId: "done", displayName: "Done", status: "completed" }),
      node({ sessionId: "busy-1", displayName: "Busy one", status: "running" }),
      node({ sessionId: "busy-2", displayName: "Busy two", status: "waiting" }),
    ];
    const { rerender } = render(
      <ConductorAgentFooter
        nodes={nodes}
        reportsByRunId={NO_REPORTS}
        workingListedBelow
      />,
    );
    expect(screen.getAllByTestId("brigade-chip")).toHaveLength(1);
    expect(
      screen.getByTestId("conductor-working-listed-below"),
    ).toHaveTextContent("2 more working");
    // The totals still count everyone.
    expect(screen.getByTestId("conductor-stats")).toHaveTextContent(
      "2 working",
    );

    rerender(
      <ConductorAgentFooter nodes={nodes} reportsByRunId={NO_REPORTS} />,
    );
    expect(screen.getAllByTestId("brigade-chip")).toHaveLength(3);
    expect(
      screen.queryByTestId("conductor-working-listed-below"),
    ).not.toBeInTheDocument();
  });
});
