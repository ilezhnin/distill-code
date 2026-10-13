import type { Configuration, RunRequest, WorkflowPolicy } from "../types";
import type { SelectorHoldoutReport } from "./benchmarkLearning";

export interface WorkflowCampaignRequest {
  executionLimits?: RunRequest["executionLimits"];
  /** Frozen maximum of unfinished trajectories (1..12); absent means serial. */
  parallelism?: number;
  /** Frozen worker calls one account runs at once (1..8); absent means four. */
  accountSlots?: number;
  requestKey: string;
  modelId: string;
  versionIds: string[];
  candidates: Configuration[];
  personaPriorIds: string[];
  minQuality: number;
  repetitions: number;
  timeoutSeconds: number;
  maxExecutions: number;
  /** Mixed-role workflows: the fitted model for every step work class. */
  classModelIds?: Record<string, string>;
}
export interface WorkflowCampaignProtocol {
  recipe: string;
  cellSelection: string;
  scoreSelection: string;
  primaryMetric: string;
  resampling: string;
  bootstrapSamples: number;
  seed: number;
  intervalMass: number;
  weights: { quality: number; speed: number; cost: number };
}
export interface WorkflowCampaign {
  plan: {
    id: string;
    createdAt: number;
    request: WorkflowCampaignRequest;
    modelSnapshotHash: string;
    cases: {
      versionId: string;
      contentHash: string;
      manifestHash: string;
      family: string;
      group: string;
      evaluatorRevision: string;
      steps: number;
      judging?: { calls: number; timeoutSeconds: number; panelBinding: string };
    }[];
    policies: WorkflowPolicy[];
    cells: { caseIndex: number; policyIndex: number; repetition: number }[];
    orderAlgorithm: string;
    aggregateRecipe: string;
    evaluation: WorkflowCampaignProtocol;
    /** Cancelled campaigns whose cells already measured these families. */
    supersedes?: string[];
  };
  planHash: string;
  state:
    | "reserved"
    | "running"
    | "pausing"
    | "paused"
    | "cancelled"
    | "completed";
  stateReason: string | null;
  nextCell: number;
  revision: number;
}
export interface WorkflowCampaignReport {
  campaignId: string;
  supersedes?: string[];
  planHash: string;
  artifactHash: string;
  createdAt: number;
  protocol: WorkflowCampaignProtocol;
  traceHashes: string[];
  cases: {
    versionId: string;
    group: string;
    learnedKey: string;
    aggregateKey: string;
    usedFallback: boolean;
    cells: {
      candidateKey: string;
      runId: string;
      quality: number;
      utility: number;
      meanDurationMs: number | null;
      meanCost: number | null;
      repeats: {
        attemptId: string;
        repetition: number;
        scoredAt: number;
        quality: number;
        durationMs: number | null;
        cost: number | null;
        evidenceHash: string | null;
        evaluationsHash: string;
      }[];
    }[];
  }[];
  policies: SelectorHoldoutReport["policies"];
  groups: number;
  dispatchAllowed: false;
  limitations: string[];
  judging?: {
    attemptId: string;
    reservedCalls: number;
    dispatchedCalls: number;
    durationMs: number | null;
    cost: number | null;
    evaluationIds: string[];
  }[];
}
