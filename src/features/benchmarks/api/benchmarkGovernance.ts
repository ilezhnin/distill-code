import { invoke } from "@tauri-apps/api/core";
import type {
  CampaignDeployment,
  ClassPolicy,
  PromotionRegistration,
  PromotionState,
  QualificationBinding,
  QualificationRecord,
  QualificationRequest,
  RegisteredPromotionRule,
} from "../lib/benchmarkGovernance";

export const benchmarkGovernanceApi = {
  qualifyVersion: (request: QualificationRequest) =>
    invoke<QualificationRecord>("benchmark_qualify_version", { request }),
  getQualification: (id: string) =>
    invoke<QualificationRecord>("benchmark_get_qualification", { id }),
  qualificationBindings: (versionId: string) =>
    invoke<QualificationBinding[]>("benchmark_qualification_bindings", {
      versionId,
    }),
  revokeQualification: (id: string, reason: string) =>
    invoke<void>("benchmark_revoke_qualification", { id, reason }),
  registerPromotionRule: (request: PromotionRegistration) =>
    invoke<RegisteredPromotionRule>("benchmark_register_promotion_rule", {
      request,
    }),
  classPolicies: () => invoke<ClassPolicy[]>("benchmark_class_policies"),
  campaignDeployment: (campaignId: string) =>
    invoke<CampaignDeployment>("benchmark_campaign_deployment", {
      campaignId,
    }),
  getPromotionRule: (campaignId: string) =>
    invoke<RegisteredPromotionRule | null>("benchmark_get_promotion_rule", {
      campaignId,
    }),
  promoteSelector: (campaignId: string) =>
    invoke<PromotionState>("benchmark_promote_selector", { campaignId }),
  listPromotions: () => invoke<PromotionState[]>("benchmark_list_promotions"),
  revokePromotion: (id: string, reason: string) =>
    invoke<PromotionState>("benchmark_revoke_promotion", { id, reason }),
};
