import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import type {
  PromotionRegistration,
  QualificationRequest,
} from "../lib/benchmarkGovernance";
import { definition } from "./fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("maps the nine governance operations to native commands with camelCase arguments", async () => {
  const request: QualificationRequest = {
    requestKey: "qualification",
    versionId: "version",
    contentHash: "hash",
    evaluatorRevision: "revision",
    reviewer: "Fixture operator",
    contractReview: "Coverage",
    alternativeReview: "Alternatives",
    familyReview: "Independent families",
    exposureReview: "Exposure",
    requirements: [],
    controls: [],
  };
  const registration: PromotionRegistration = {
    requestKey: "rule",
    campaignId: "campaign",
    operator: "Fixture operator",
    rule: {
      recipe: "independent-group-sign-holm-v1",
      alpha: 0.01,
      minimumGroupUtilityGain: 0.1,
      minimumObservedQuality: 0.8,
    },
    contract: {
      workClassId: definition.draft.workClassId,
      roleId: definition.draft.roleId,
      rolePrompt: definition.draft.rolePrompt,
      permissions: definition.draft.permissions,
      executionProfile: definition.draft.executionProfile,
      limits: definition.draft.limits,
      entryPresent: true,
    },
    qualificationIds: ["qualification"],
  };
  await api.qualifyVersion(request);
  await api.getQualification("qualification");
  await api.qualificationBindings("version");
  await api.revokeQualification("qualification", "Review withdrawn");
  await api.registerPromotionRule(registration);
  await api.campaignDeployment("campaign");
  await api.getPromotionRule("campaign");
  await api.promoteSelector("campaign");
  await api.listPromotions();
  await api.revokePromotion("certificate", "Runtime changed");
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["benchmark_qualify_version", { request }],
    ["benchmark_get_qualification", { id: "qualification" }],
    ["benchmark_qualification_bindings", { versionId: "version" }],
    [
      "benchmark_revoke_qualification",
      { id: "qualification", reason: "Review withdrawn" },
    ],
    ["benchmark_register_promotion_rule", { request: registration }],
    ["benchmark_campaign_deployment", { campaignId: "campaign" }],
    ["benchmark_get_promotion_rule", { campaignId: "campaign" }],
    ["benchmark_promote_selector", { campaignId: "campaign" }],
    ["benchmark_list_promotions"],
    [
      "benchmark_revoke_promotion",
      { id: "certificate", reason: "Runtime changed" },
    ],
  ]);
});
it("preserves native validation failures instead of manufacturing authority", async () => {
  const failure = {
    code: "invalid_promotion",
    message: "Qualification coverage is incomplete",
  };
  vi.mocked(invoke).mockRejectedValue(failure);
  await expect(api.promoteSelector("campaign")).rejects.toBe(failure);
});
