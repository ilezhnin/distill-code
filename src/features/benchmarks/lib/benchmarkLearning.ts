import { z } from "zod";
import { isRecord } from "@/shared/lib/isRecord";
import type {
  BenchmarkDraft,
  BenchmarkManifestSummary,
  Configuration,
  RoutingEvidenceQuery,
} from "../types";

// Mirrors the native public repository artifact, never its private lineage.
const repositoryArtifactSchema = z
  .object({
    recipe: z.string(),
    rootTree: z.string(),
    beforeTree: z.string(),
    afterTree: z.string(),
    patch: z.string(),
    patchHash: z.string(),
    archiveHash: z.string(),
  })
  .strict();

export type PublicSelectorTask = Pick<
  BenchmarkDraft,
  | "workClassId"
  | "prompt"
  | "fixtures"
  | "facets"
  | "roleId"
  | "rolePrompt"
  | "permissions"
  | "executionProfile"
  | "limits"
> & {
  entry: {
    conversationPrefix: string;
    previousReports: string[];
    remainingBudgetSeconds: number;
  } | null;
  budgetRecipe?: string;
  repositoryRecipe?: string;
  repositoryArtifact?: z.infer<typeof repositoryArtifactSchema>;
};

/** Explicit projection; never spread a manifest into the inference request. */
export function publicSelectorTask(draft: BenchmarkDraft): PublicSelectorTask {
  const environment = isRecord(draft.environment) ? draft.environment : {};
  const input = environment.repositoryArtifactInput;
  const before = isRecord(input) && isRecord(input.before) ? input.before : {};
  const artifact = repositoryArtifactSchema.safeParse(before);
  return {
    workClassId: draft.workClassId,
    prompt: draft.prompt,
    fixtures: draft.fixtures,
    facets: draft.facets,
    roleId: draft.roleId,
    rolePrompt: draft.rolePrompt,
    permissions: draft.permissions,
    executionProfile: draft.executionProfile,
    limits: draft.limits,
    entry: draft.entryState
      ? {
          conversationPrefix: draft.entryState.conversationPrefix,
          previousReports: draft.entryState.previousReports,
          remainingBudgetSeconds: draft.entryState.remainingBudgetSeconds,
        }
      : null,
    ...(typeof environment.nativeBudgetRecipe === "string"
      ? { budgetRecipe: environment.nativeBudgetRecipe }
      : {}),
    ...(typeof before.recipe === "string"
      ? { repositoryRecipe: before.recipe }
      : {}),
    ...(artifact.success ? { repositoryArtifact: artifact.data } : {}),
  };
}

export function selectorTaskGroup(
  draft: Pick<BenchmarkManifestSummary, "environment" | "taskFamily">,
): string {
  const environment = draft.environment;
  if (
    environment &&
    typeof environment === "object" &&
    "splitGroup" in environment &&
    typeof environment.splitGroup === "string" &&
    environment.splitGroup.trim()
  )
    return environment.splitGroup;
  return draft.taskFamily;
}

/** Which runtimes training cells may come from; omitted means exact. */
export type RuntimeMatch = "exact" | "model_identity";
export interface SelectorFitRequest {
  workClassId: string;
  versionIds: string[];
  configurations: Configuration[];
  cutoffAt: number;
  weights: { quality: number; speed: number; cost: number };
  runtimeMatch?: RuntimeMatch;
}
export interface SelectorFitSummary {
  id: string;
  createdAt: number;
  workClassId: string;
  trainingCases: number;
  commonCases: number;
  groups: number;
  candidates: number;
  dispatchAllowed: false;
  status: "research_only";
}
export interface SelectorFitArtifact {
  createdAt: number;
  model: {
    id: string;
    recipe: string;
    featureVersion: string;
    cutoffAt: number;
    snapshotHash: string;
    workClassId: string;
    trainingCases: number;
    commonCases: number;
    trainingFamilies: string[];
    trainingGroups: string[];
    candidates: {
      candidateKey: string;
      configuration: Configuration;
      cases: number;
      qualityCoefficients: number[];
      utilityCoefficients: number[];
      selectionCoefficients?: number[];
    }[];
  };
  snapshot: {
    request: SelectorFitRequest;
    examples: {
      versionId: string;
      contentHash: string;
      family: string;
      splitGroup: string;
      evaluatorRevision: string;
      task: PublicSelectorTask;
      targets: {
        candidateKey: string;
        status: string;
        reward: number | null;
        utility: number | null;
        meanDurationMs: number | null;
        meanCost: number | null;
        evidence: unknown;
      }[];
    }[];
  };
}
export interface SelectorPredictionRequest {
  task: PublicSelectorTask;
  targetFamily: string;
  targetGroup: string;
  candidates: RoutingEvidenceQuery["candidates"];
  hardCandidateKey: string | null;
  minQuality: number;
}
export interface SelectorPrediction {
  modelId: string;
  chosen: Configuration | null;
  chosenKey: string | null;
  reason: string;
  dispatchAllowed: false;
  scores: {
    candidateKey: string;
    configuration: Configuration;
    quality: number;
    utility: number;
    selectionProbability?: number;
  }[];
}

/** One fixed policy's result in a research report's paired bootstrap. */
export interface SelectorPolicyResult {
  policy: string;
  selectedFixedKey: string | null;
  quality: number;
  utility: number;
  meanDurationMs: number | null;
  meanCost: number | null;
  missingDurationCases: number;
  missingCostCases: number;
  utilityInterval: { lower: number; upper: number };
  learnedUtilityGain: number;
  learnedGainInterval: { lower: number; upper: number };
}

/** One entry of a class's manual order, as the app's ranking names it. */
export interface RankedMatcher {
  platform?: string;
  needles: string[][];
}
/** Fit a class from its training cells and evaluate it on its held-out cells. */
export interface ClassEvaluationRequest {
  workClassId: string;
  excludedProviders?: string[];
  personaOrder: RankedMatcher[];
}
export type ClassEvaluationStatus =
  | "certified"
  | "not_certified"
  | "insufficient_evidence";
export interface ClassEvaluationComparison {
  baseline: string;
  test?: "superiority" | "non_inferiority";
  tiedGroups?: number;
  winningGroups: number;
  meanUtilityGain: number;
  pValue: number;
  adjustedPValue: number;
  passed: boolean;
}
export interface ClassEvaluationCandidate {
  candidateKey: string;
  providerId: string;
  modelId: string;
  modelName: string | null;
  effort: string | null;
  fastMode: boolean | null;
  trainingCases: number;
  heldOutCases: number;
  learnedCases: number;
}
/** One journaled look: a fit replayed on the class's held-out cells. */
export interface ClassEvaluation {
  id: string;
  workClassId: string;
  createdAt: number;
  recipe: string;
  fitRecipe: string;
  modelId: string;
  modelSnapshotHash: string;
  look: number;
  personaKeys: string[];
  aggregateKeys: string[];
  excludedProviders: string[];
  candidates: ClassEvaluationCandidate[];
  cases: {
    versionId: string;
    group: string;
    learnedKey: string;
    aggregateKey: string;
    usedFallback: boolean;
  }[];
  unqualifiedCases: number;
  ungradedCells: number;
  snapshotHash: string;
  assessment: {
    groups: number;
    observedQuality: number;
    comparisons: ClassEvaluationComparison[];
    passed: boolean;
    reasons: string[];
    limitations: string[];
  } | null;
  status: ClassEvaluationStatus;
  limitations: string[];
  qualificationIds: string[];
  certificateId: string | null;
  artifactHash: string;
}
/** What a class's status line shows about its newest evaluation. */
export interface ClassEvaluationSummary {
  id: string;
  modelId: string;
  createdAt: number;
  status: ClassEvaluationStatus;
  look: number;
  trainingCases: number;
  heldOutCases: number;
  groups: number;
  observedQuality: number | null;
  reasons: string[];
  certificateId: string | null;
}
