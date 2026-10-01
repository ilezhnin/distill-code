import { createBenchmarkDraft } from "../lib/benchmarkDraft";
import type {
  Attempt,
  BenchmarkDefinition,
  BenchmarkDraft,
  BenchmarkRun,
  Configuration,
  TokenUsage,
  RunSummary,
} from "../types";

export const draft: BenchmarkDraft = {
  ...createBenchmarkDraft(),
  name: "Integer transformation",
  category: "text",
  taskFamily: "integer",
  prompt: "Return the number 4.",
  source: "local",
  license: "CC0",
  evaluator: {
    kind: "exact",
    expected: "4",
    knownGood: "4",
    knownBad: "5",
    rubric: "",
    revision: "1",
  },
};
export const definition: BenchmarkDefinition = {
  id: "definition-1",
  draftRevision: 1,
  archived: false,
  draft,
  versions: [
    {
      id: "version-1",
      definitionId: "definition-1",
      contentHash: "abc123",
      publishedAt: 1000,
      manifest: draft,
    },
  ],
};
export const configuration: Configuration = {
  id: "config-1",
  providerId: "claude-acp",
  accountId: "account-1",
  modelId: "model-1",
  effort: "high",
  fastMode: false,
  billingMode: "subscription",
  executionProfile: "native_text",
  inventoryRevision: "inventory-1",
};
export const usage: TokenUsage = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  cost: null,
  schema: "unknown",
};
export const attempt: Attempt = {
  id: "attempt-1",
  runId: "run-1",
  versionId: "version-1",
  configuration,
  repetition: 0,
  phase: "terminal",
  outcome: "pass",
  reason: null,
  sessionId: null,
  hostRunId: null,
  observed: configuration,
  startedAt: 1000,
  finishedAt: 2000,
  durationMs: 1000,
  output: "4",
  evidenceHash: "sealed",
  usage,
  evaluations: [
    {
      id: "eval-1",
      evaluatorRevision: "1",
      verdict: "pass",
      score: 1,
      reason: "exact",
      createdAt: 2000,
      provenance: "objective",
      artifacts: [],
    },
  ],
  eventCursor: 2,
  workflowSteps: [],
};
export const run: BenchmarkRun = {
  id: "run-1",
  state: "completed",
  revision: 1,
  createdAt: 1000,
  updatedAt: 2000,
  request: {
    requestKey: "request-1",
    versionIds: ["version-1"],
    configurations: [configuration],
    repetitions: 1,
    timeoutSeconds: 120,
    maxExecutions: 2,
    preview: false,
  },
  attempts: [attempt],
};

export const runSummary: RunSummary = {
  id: run.id,
  state: run.state,
  revision: run.revision,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  request: run.request,
  attemptCount: 1,
  settledCount: 1,
};
