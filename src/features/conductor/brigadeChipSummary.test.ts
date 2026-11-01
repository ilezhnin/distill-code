import { describe, expect, it } from "vitest";

import type { SessionChatRuntime } from "@/shared/types/chat";
import { INITIAL_TOKEN_STATE } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

import {
  brigadeChipFacts,
  formatRunDuration,
  formatTokenCount,
  oneLine,
} from "./brigadeChipSummary";
import type { SessionNode, StructuredReport } from "./types";

function node(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: "worker-1",
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor",
    rootConductorId: "conductor",
    runId: "run-1",
    harnessId: "claude-acp",
    displayName: "Scout · waveEngine",
    status: "running",
    createdAt: 10_000,
    ...overrides,
  };
}

function runtime(
  overrides: Partial<SessionChatRuntime> = {},
): Pick<
  SessionChatRuntime,
  "chatState" | "tokenState" | "streamingMessageId" | "error"
> {
  return {
    chatState: "streaming",
    tokenState: { ...INITIAL_TOKEN_STATE, accumulatedTotal: 9_800 },
    streamingMessageId: "a2",
    error: null,
    ...overrides,
  };
}

const MESSAGES: Message[] = [
  {
    id: "a1",
    role: "assistant",
    created: 1,
    content: [
      {
        type: "toolRequest",
        id: "t1",
        name: "Read",
        toolName: "Read",
        arguments: { file_path: "src/a.ts" },
        status: "completed",
      },
      {
        type: "toolResponse",
        id: "t1",
        name: "Read",
        result: "ok",
        isError: false,
      },
      { type: "text", text: "Found it." },
    ],
  },
  {
    id: "a2",
    role: "assistant",
    created: 2,
    content: [
      {
        type: "thinking",
        text: "**Checking the engine**\n\nLooking at ticks.",
      },
      {
        type: "toolRequest",
        id: "t2",
        name: "Grep",
        toolName: "Grep",
        arguments: { pattern: "tick" },
        status: "in_progress",
      },
    ],
  },
];

function report(overrides: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "run-1",
    status: "completed",
    summary: "Did the step.",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...overrides,
  };
}

describe("brigadeChipFacts", () => {
  it("reads a working worker's spend, tool count and the step it is on", () => {
    const facts = brigadeChipFacts({
      node: node(),
      runtime: runtime(),
      messages: MESSAGES,
    });
    expect(facts.status).toBe("running");
    expect(facts.spendLabel).toBe("9.8k");
    expect(facts.toolCount).toBe(2);
    expect(facts.lastStep).toMatchObject({ kind: "tool" });
    expect(facts.reason).toBeUndefined();
  });

  it("prefers the bill to the token count when the provider prices tokens", () => {
    const facts = brigadeChipFacts({
      node: node(),
      runtime: runtime({
        tokenState: {
          ...INITIAL_TOKEN_STATE,
          accumulatedTotal: 12_300,
          accumulatedCost: 0.41,
        },
      }),
      messages: MESSAGES,
    });
    expect(facts.spendLabel).toBe("$0.41");
  });

  it("names the latest thought once no tool is in flight", () => {
    const facts = brigadeChipFacts({
      node: node(),
      runtime: runtime(),
      messages: [
        MESSAGES[0] as Message,
        {
          ...(MESSAGES[1] as Message),
          content: [
            {
              type: "thinking",
              text: "**Checking the engine**\n\nLooking at ticks.",
            },
          ],
        },
      ],
    });
    expect(facts.lastStep).toEqual({
      kind: "thought",
      headline: "Checking the engine",
    });
  });

  it("leaves the tool count unknown when the worker's chat is not loaded", () => {
    const facts = brigadeChipFacts({ node: node(), runtime: runtime() });
    expect(facts.toolCount).toBeUndefined();
    expect(facts.lastStep).toBeNull();
  });

  it("shows a worker whose chat is in error as failed, with the host's reason, before the graph catches up", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "running" }),
      runtime: runtime({
        chatState: "error",
        streamingMessageId: null,
        error: "The bridge exited with code 1.",
      }),
      messages: MESSAGES,
    });
    expect(facts.status).toBe("failed");
    expect(facts.reason).toBe("The bridge exited with code 1.");
    expect(facts.lastStep).toBeNull();
  });

  it("shows a worker as failed when its last reply carries the host's failure and nothing runs", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "running" }),
      runtime: runtime({ chatState: "idle", streamingMessageId: null }),
      messages: [
        {
          id: "a3",
          role: "assistant",
          created: 3,
          content: [{ type: "text", text: "Partial." }],
          metadata: {
            completionStatus: "error",
            failureReason: "The provider refused the request mid-turn.",
          },
        },
      ],
    });
    expect(facts.status).toBe("failed");
    expect(facts.reason).toBe("The provider refused the request mid-turn.");
  });

  it("keeps a working worker working while its chat is merely quiet", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "starting" }),
      runtime: runtime({ chatState: "idle", streamingMessageId: null }),
      messages: [],
    });
    expect(facts.status).toBe("starting");
  });

  it("gives a finished worker its duration and no step", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "completed", finishedAt: 10_000 + 130_000 }),
      runtime: runtime({ chatState: "idle", streamingMessageId: null }),
      messages: MESSAGES,
      report: report(),
    });
    expect(facts.status).toBe("completed");
    expect(facts.durationMs).toBe(130_000);
    expect(facts.lastStep).toBeNull();
    expect(facts.reason).toBeUndefined();
  });

  it("repeats the host's reason on a failed worker, on one line", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "failed", finishedAt: 20_000 }),
      runtime: runtime({ chatState: "idle", streamingMessageId: null }),
      messages: [
        {
          id: "a3",
          role: "assistant",
          created: 3,
          content: [],
          metadata: {
            completionStatus: "error",
            failureReason: "Agent process exited unexpectedly\n\nexit code 1",
          },
        },
      ],
    });
    expect(facts.status).toBe("failed");
    expect(facts.reason).toBe("Agent process exited unexpectedly");
  });

  it("falls back to the report's words when a failed worker left no host reason", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "failed" }),
      messages: [],
      report: report({ status: "failed", summary: "Tests did not pass." }),
    });
    expect(facts.reason).toBe("Tests did not pass.");
  });

  it("wears the report's blocked status and reason over a run that completed", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "completed" }),
      report: report({
        status: "blocked",
        reason: "The fixture file named in the brief does not exist.",
        needsOperator: true,
      }),
    });
    expect(facts.status).toBe("blocked");
    expect(facts.reason).toBe(
      "The fixture file named in the brief does not exist.",
    );
  });

  it("says nothing beyond the status word for a stop the operator asked for", () => {
    const facts = brigadeChipFacts({
      node: node({ status: "stopped" }),
      report: report({
        status: "cancelled",
        summary: "The agent was cancelled.",
      }),
    });
    expect(facts.status).toBe("stopped");
    expect(facts.reason).toBeUndefined();
  });
});

describe("chip formatting", () => {
  it("counts tokens the width of a chip", () => {
    expect(formatTokenCount(980)).toBe("980");
    expect(formatTokenCount(9_800)).toBe("9.8k");
    expect(formatTokenCount(12_300)).toBe("12k");
    expect(formatTokenCount(120_000)).toBe("120k");
    expect(formatTokenCount(2_100_000)).toBe("2.1M");
  });

  it("counts a run's length the way a status line does", () => {
    expect(formatRunDuration(12_000)).toBe("12s");
    expect(formatRunDuration(130_000)).toBe("2m 10s");
    expect(formatRunDuration(3_720_000)).toBe("1h 02m");
  });

  it("cuts a reason to its first line and chip length", () => {
    expect(oneLine("\n\nFirst line.\nSecond.")).toBe("First line.");
    expect(oneLine("x".repeat(200), 20)).toHaveLength(20);
    expect(oneLine("x".repeat(200), 20).endsWith("…")).toBe(true);
  });
});
