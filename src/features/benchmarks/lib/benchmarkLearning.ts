import type {
  BenchmarkDraft,
  Configuration,
  RoutingEvidenceQuery,
} from "../types";

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
};

/** Explicit projection; never spread a manifest into the inference request. */
export function publicSelectorTask(draft: BenchmarkDraft): PublicSelectorTask {
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
  };
}

export function selectorTaskGroup(draft: BenchmarkDraft): string {
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

export interface SelectorFitRequest {
  workClassId: string;
  versionIds: string[];
  configurations: Configuration[];
  cutoffAt: number;
  weights: { quality: number; speed: number; cost: number };
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
  }[];
}
