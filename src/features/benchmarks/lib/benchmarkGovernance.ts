import { isWorkerLayerRole } from "@/features/conductor/roleLayers";
import type { BenchmarkDraft, Evaluation } from "../types";

// Mirrors the native qualification and promotion wire contracts.
export interface QualificationControl {
  id: string;
  output: string;
  expected: "pass" | "fail";
  rationale: string;
}
export interface QualificationRequirement {
  id: string;
  statement: string;
  positiveControls: string[];
  negativeControls: string[];
}
export interface QualificationRequest {
  requestKey: string;
  versionId: string;
  contentHash: string;
  evaluatorRevision: string;
  reviewer: string;
  contractReview: string;
  alternativeReview: string;
  familyReview: string;
  exposureReview: string;
  requirements: QualificationRequirement[];
  controls: QualificationControl[];
}
export interface QualificationBinding {
  id: string;
  versionId: string;
  contentHash: string;
  manifestHash: string;
  evaluatorRevision: string;
  createdAt: number;
  recordHash: string;
  status: string;
  revokedAt: number | null;
  revocationReason: string | null;
}
export interface QualificationRecord {
  id: string;
  createdAt: number;
  request: QualificationRequest;
  manifestHash: string;
  controls: {
    controlId: string;
    outputHash: string;
    evaluation: Evaluation | null;
    error: string | null;
  }[];
  status: string;
  finishedAt: number | null;
  failure: string | null;
  limitations: string[];
}
export interface PromotionRule {
  recipe: "independent-group-sign-holm-v1";
  alpha: number;
  minimumGroupUtilityGain: number;
  minimumObservedQuality: number;
}
export interface DeploymentContract {
  workClassId: string;
  roleId: string | null;
  rolePrompt: string;
  permissions: BenchmarkDraft["permissions"];
  executionProfile: string;
  limits: BenchmarkDraft["limits"];
  entryPresent: boolean;
  budgetRecipe?: string;
  repositoryRecipe?: string;
}
/** The exact step sequence and root wall budget a trajectory rule covers. */
export interface TrajectoryContract {
  rootBudgetSeconds: number;
  steps: DeploymentContract[];
}
/** What a campaign evaluated, computed natively from its frozen cases. */
export interface CampaignDeployment {
  contract: DeploymentContract;
  trajectory: TrajectoryContract | null;
}
export interface PromotionRegistration {
  requestKey: string;
  campaignId: string;
  operator: string;
  rule: PromotionRule;
  contract: DeploymentContract;
  qualificationIds: string[];
  trajectory?: TrajectoryContract | null;
}
export interface RegisteredPromotionRule {
  request: PromotionRegistration;
  createdAt: number;
  planHash: string;
  qualificationHashes: string[];
  artifactHash: string;
}
export interface PromotionAssessment {
  rule: PromotionRule;
  groups: number;
  observedQuality: number;
  comparisons: {
    baseline: string;
    winningGroups: number;
    meanUtilityGain: number;
    pValue: number;
    adjustedPValue: number;
    passed: boolean;
  }[];
  passed: boolean;
  reasons: string[];
  limitations: string[];
}
export interface PromotionCertificate {
  id: string;
  createdAt: number;
  modelId: string;
  modelSnapshotHash: string;
  campaignId: string;
  campaignPlanHash: string;
  reportHash: string;
  ruleHash: string;
  contract: DeploymentContract;
  assessment: PromotionAssessment;
  qualifications: QualificationBinding[];
  priorKeys: string[];
  minPredictionQuality: number;
  artifactHash: string;
  trajectory?: {
    rootBudgetSeconds: number;
    steps: {
      contract: DeploymentContract;
      modelId: string;
      modelSnapshotHash: string;
    }[];
  };
}
export interface PromotionState {
  certificate: PromotionCertificate;
  revokedAt: number | null;
  revocationReason: string | null;
}

/**
 * Step roles a conductor wave cannot name. Only waves use a trajectory
 * certificate, so one for these roles would never select a worker.
 */
export function rolesWavesCannotName(
  roleIds: readonly (string | null | undefined)[],
): string[] {
  return [...new Set(roleIds.filter((id): id is string => Boolean(id)))].filter(
    (id) => !isWorkerLayerRole(id),
  );
}
