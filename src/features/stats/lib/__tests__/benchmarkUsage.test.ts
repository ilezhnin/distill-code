import { beforeEach, expect, it, vi } from "vitest";
import {
  getUsageLedger,
  projectBenchmarkUsage,
  projectBenchmarkUsageBatch,
  recordSessionTokens,
  subscribeUsageLedger,
  resetUsageLedgerForTests,
} from "../usageLedger";
import {
  recordAcpSessionUsage,
  syncChatSessionsIntoUsageLedger,
} from "../usageRecorder";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { observeExecutionOwner } from "@/features/chat/lib/executionOwnership";

beforeEach(() => {
  localStorage.clear();
  resetUsageLedgerForTests();
});
it("records application-owned work before session hydration and preserves it on replay", () => {
  const task = "application-owned-usage";
  const benchmark = "benchmark-owned-usage";
  observeExecutionOwner(task, { kind: "task", id: "task:usage-binding" });
  observeExecutionOwner(benchmark, {
    kind: "benchmark",
    id: "benchmark-usage-attempt",
  });
  recordAcpSessionUsage(task, {
    mode: "add",
    inputTokens: 30,
    outputTokens: 10,
    costUsd: 0.01,
    turnsDelta: 1,
  });
  recordAcpSessionUsage(task, {
    mode: "replace",
    inputTokens: 30,
    outputTokens: 10,
    costUsd: 0.01,
  });
  recordAcpSessionUsage(benchmark, {
    mode: "add",
    inputTokens: 90,
    outputTokens: 90,
    turnsDelta: 1,
  });
  expect(getUsageLedger().sessions[task]).toMatchObject({
    inputTokens: 30,
    outputTokens: 10,
    turns: 1,
    costUsd: 0.01,
  });
  expect(getUsageLedger().sessions[benchmark]).toBeUndefined();
  const base = {
    type: "agent" as const,
    title: "Invented task",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 1,
  };
  useChatSessionStore.setState({
    sessions: [
      {
        ...base,
        id: task,
        executionOwner: { kind: "task", id: "task:usage-binding" },
      },
      {
        ...base,
        id: benchmark,
        executionOwner: { kind: "benchmark", id: "benchmark-usage-attempt" },
      },
    ],
  });
  syncChatSessionsIntoUsageLedger();
  expect(getUsageLedger().sessions[task].totalTokens).toBe(40);
  expect(getUsageLedger().sessions[benchmark]).toBeUndefined();
});

it("projects sealed benchmark usage once and ignores live/replayed accounting", () => {
  const sessionId = "sealed-benchmark-stats";
  observeExecutionOwner(sessionId, { kind: "benchmark", id: "attempt-stats" });
  const row = {
    sessionId,
    providerId: "claude-acp",
    modelId: "model",
    effort: "high",
    inputTokens: 40,
    outputTokens: 12,
    costUsd: null,
    durationMs: 150,
    finishedAt: Date.now(),
  };
  projectBenchmarkUsage(row);
  projectBenchmarkUsage(row);
  recordAcpSessionUsage(sessionId, {
    mode: "add",
    inputTokens: 40,
    outputTokens: 12,
    turnsDelta: 1,
  });
  expect(getUsageLedger().sessions[sessionId]).toMatchObject({
    origin: "benchmark",
    inputTokens: 40,
    outputTokens: 12,
    totalTokens: 52,
    turns: 1,
    workedMs: 150,
    costUsd: null,
  });
  expect(
    Object.values(getUsageLedger().daily).reduce(
      (sum, day) => sum + day.totalTokens,
      0,
    ),
  ).toBe(52);
});

it("publishes a large benchmark snapshot once and leaves a replay unchanged", () => {
  const records = Array.from({ length: 2_000 }, (_, index) => ({
    sessionId: `invented-benchmark-${index}`,
    providerId: "codex-acp",
    modelId: "invented-model",
    effort: "low",
    inputTokens: index + 1,
    outputTokens: 10,
    costUsd: null,
    durationMs: 100,
    finishedAt: Date.now(),
  }));
  const notified = vi.fn();
  const stop = subscribeUsageLedger(notified);
  try {
    projectBenchmarkUsageBatch(records);
    expect(notified).toHaveBeenCalledTimes(1);
    const snapshot = getUsageLedger();
    expect(Object.keys(snapshot.sessions)).toHaveLength(records.length);
    expect(
      Object.values(snapshot.daily).reduce(
        (sum, day) => sum + day.totalTokens,
        0,
      ),
    ).toBe(2_021_000);
    expect(snapshot.sessions[records[0].sessionId]).toMatchObject({
      origin: "benchmark",
      turns: 1,
      workedMs: 100,
    });
    projectBenchmarkUsageBatch(records);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(getUsageLedger()).toBe(snapshot);
  } finally {
    stop();
  }
});

it("reconciles repeated sessions within one batch without double counting or losing unknown usage", () => {
  const finishedAt = Date.now();
  const row = {
    sessionId: "invented-partial-usage",
    providerId: "codex-acp",
    modelId: "invented-model",
    effort: "high",
    inputTokens: 20,
    outputTokens: 5,
    costUsd: 0.2,
    durationMs: 100,
    finishedAt,
  };
  recordSessionTokens("unrelated-chat", { inputTokens: 7, outputTokens: 3 });
  const before = getUsageLedger();
  const unrelated = before.sessions["unrelated-chat"];
  projectBenchmarkUsageBatch([
    row,
    {
      ...row,
      inputTokens: 40,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
    },
  ]);
  const result = getUsageLedger();
  expect(result.sessions["unrelated-chat"]).toBe(unrelated);
  expect(before.sessions[row.sessionId]).toBeUndefined();
  expect(result.sessions[row.sessionId]).toMatchObject({
    inputTokens: 40,
    outputTokens: 5,
    totalTokens: 45,
    costUsd: null,
    costCurrency: "USD",
    workedMs: 100,
    turns: 1,
  });
  expect(
    Object.values(result.daily).reduce((sum, day) => sum + day.totalTokens, 0),
  ).toBe(55);
  projectBenchmarkUsageBatch([
    {
      ...row,
      inputTokens: 40,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
    },
  ]);
  expect(getUsageLedger()).toBe(result);
});
