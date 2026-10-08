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
}
export interface PromotionRegistration {
  requestKey: string;
  campaignId: string;
  operator: string;
  rule: PromotionRule;
  contract: DeploymentContract;
  qualificationIds: string[];
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
}
export interface PromotionState {
  certificate: PromotionCertificate;
  revokedAt: number | null;
  revocationReason: string | null;
}

/** Displayed proposal only; native registration validates the actual fit and campaign. */
export function deploymentContract(
  manifest: BenchmarkDraft,
): DeploymentContract {
  return {
    workClassId: manifest.workClassId,
    roleId: manifest.roleId,
    rolePrompt: manifest.rolePrompt,
    permissions: {
      ...manifest.permissions,
      tools: [...new Set(manifest.permissions.tools)].sort(),
    },
    executionProfile: manifest.executionProfile,
    limits: { ...manifest.limits },
    entryPresent: true,
  };
}
