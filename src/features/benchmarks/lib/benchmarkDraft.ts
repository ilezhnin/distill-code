import { z } from "zod";
import type { BenchmarkDraft } from "../types";

export const benchmarkDraftSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(160),
  description: z.string(),
  category: z.string().trim().min(1),
  taskFamily: z.string().trim().min(1),
  split: z.enum(["development", "train", "held_out"]),
  prompt: z.string().trim().min(1),
  source: z.string(),
  license: z.string(),
  executionProfile: z.string().min(1),
  // The quota and capacity batches are retired; every case measures tokens,
  // time and list-price cost per attempt.
  measurementProfile: z.literal("task_metrics"),
  evaluator: z.object({
    kind: z.string().min(1),
    expected: z.string(),
    rubric: z.string(),
    revision: z.string().min(1),
    knownGood: z.string(),
    knownBad: z.string(),
  }),
  permissions: z.object({
    tools: z.array(z.string()),
    network: z.boolean(),
    context: z.string(),
  }),
  limits: z.object({
    timeoutSeconds: z.number().int().positive(),
    maxTurns: z.number().int().positive(),
    maxArtifactBytes: z.number().int().positive(),
  }),
  repetitions: z.number().int().min(1).max(100),
  fixtures: z.array(z.object({ path: z.string().min(1), content: z.string() })),
  environment: z.unknown(),
  workClassId: z.string().min(1),
  roleId: z.string().nullable(),
  rolePrompt: z.string(),
  roleContextHash: z.string(),
  facets: z
    .object({
      language: z.string().nullable().optional(),
      domain: z.string().nullable().optional(),
      difficulty: z.string().nullable().optional(),
      inputBytes: z.number().int().nonnegative().nullable().optional(),
      outputFormat: z.string().nullable().optional(),
    })
    .strict(),
  entryState: z
    .object({
      schemaVersion: z.literal(1),
      rootTaskId: z.string().min(1),
      stepId: z.string().min(1),
      parentStepId: z.string().nullable(),
      fixtureSnapshotHash: z.string(),
      conversationPrefix: z.string(),
      previousReports: z.array(z.string()),
      remainingBudgetSeconds: z.number().int().min(1).max(3600),
      contentHash: z.string(),
    })
    .strict()
    .nullable(),
  workflow: z
    .object({
      schemaVersion: z.literal(1),
      driverRevision: z.string().min(1),
      steps: z
        .array(
          z
            .object({
              id: z.string().min(1),
              prompt: z.string().min(1),
              includePreviousOutput: z.boolean(),
            })
            .strict(),
        )
        .min(2)
        .max(4),
    })
    .strict()
    .nullable(),
});

export function createBenchmarkDraft(): BenchmarkDraft {
  return {
    schemaVersion: 1,
    name: "",
    description: "",
    category: "text",
    taskFamily: "",
    split: "development",
    prompt: "",
    source: "",
    license: "",
    executionProfile: "native_text",
    measurementProfile: "task_metrics",
    evaluator: {
      kind: "exact",
      expected: "",
      rubric: "",
      revision: "1",
      knownGood: "",
      knownBad: "",
    },
    permissions: { tools: [], network: false, context: "clean" },
    limits: { timeoutSeconds: 120, maxTurns: 1, maxArtifactBytes: 1048576 },
    repetitions: 1,
    fixtures: [],
    environment: {},
    workClassId: "general",
    roleId: null,
    facets: {},
    rolePrompt: "",
    roleContextHash: "clean-v1",
    entryState: null,
    workflow: null,
  };
}

export function configurationLabel(configuration: {
  providerId: string;
  modelId: string;
  effort: string | null;
  fastMode: boolean | null;
}) {
  return [
    configuration.providerId,
    configuration.modelId,
    configuration.effort,
    configuration.fastMode === true ? "fast" : null,
  ]
    .filter(Boolean)
    .join(" / ");
}
