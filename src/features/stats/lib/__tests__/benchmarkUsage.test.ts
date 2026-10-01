import { beforeEach, expect, it } from "vitest";
import {
  getUsageLedger,
  projectBenchmarkUsage,
  resetUsageLedgerForTests,
} from "../usageLedger";
import { recordAcpSessionUsage } from "../usageRecorder";
import { observeExecutionOwner } from "@/features/chat/lib/executionOwnership";

beforeEach(() => {
  localStorage.clear();
  resetUsageLedgerForTests();
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
