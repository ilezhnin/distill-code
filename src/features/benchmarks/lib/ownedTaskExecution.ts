import { invoke } from "@tauri-apps/api/core";
import type { Configuration } from "../types";
import type { PublicSelectorTask } from "./benchmarkLearning";
import type { ExecutorDecision } from "./executorSelection";
import type { DeploymentContract } from "./benchmarkGovernance";

export interface OwnedTaskRequest {
  requestKey: string;
  surface: "chat" | "wave";
  contextId: string;
  promotionId: string;
  acknowledgedCertificateHash: string;
  prompt: string;
  hardCandidateKey: string | null;
  repository: { path: string; commit: string; tree: string } | null;
  entry: {
    rootBindingId: string;
    previousBindingIds: string[];
    includePreviousOutput: boolean;
  } | null;
  waveMode: { contextId: string; artifactHash: string } | null;
}
export interface OwnedTaskModeRequest {
  contextId: string;
  promotionId: string | null;
  acknowledgedCertificateHash: string;
  repository: OwnedTaskRequest["repository"];
}
export interface OwnedTaskMode {
  request: OwnedTaskModeRequest;
  createdAt: number;
  artifactHash: string;
}
export interface NativeTaskRole {
  sourceId: string;
  sourcePath: string;
  sourceHash: string;
  roleId: string;
  rolePrompt: string;
  workClassId: string;
  prior: {
    providerId: string | null;
    modelId: string;
    effort: string | null;
    fastMode: boolean | null;
  }[];
  priorReason: string;
  unknownReasons: string[];
  defaultEffort: string | null;
  defaultFastMode: boolean | null;
}
export interface OwnedTaskModeRequestV2 {
  schemaVersion: 2;
  contextId: string;
  surface: "chat" | "wave";
  executionProfile: "native_text" | "protected_repository";
  repository: OwnedTaskRequest["repository"];
  limits: DeploymentContract["limits"];
  roles: { sourcePath: string; workClassId: string }[];
  providerIds: string[];
  acknowledgedContractHash: string;
  promotionId?: never;
  acknowledgedCertificateHash?: never;
}
export interface NativeTaskConsent {
  surface: "chat" | "wave";
  executionProfile: OwnedTaskModeRequestV2["executionProfile"];
  repository: OwnedTaskRequest["repository"];
  repositoryArchiveHash: string | null;
  limits: DeploymentContract["limits"];
  permissions: DeploymentContract["permissions"];
  roles: NativeTaskRole[];
  providerIds: string[];
  complete: boolean;
  unknownReasons: string[];
  artifactHash: string;
}
export interface OwnedTaskModeV2 {
  schemaVersion: 2;
  request: OwnedTaskModeRequestV2;
  consent: NativeTaskConsent;
  createdAt: number;
  artifactHash: string;
}
export type OwnedTaskModeEnvelope = OwnedTaskMode | OwnedTaskModeV2;
export type OwnedTaskModeIntent = OwnedTaskModeRequest | OwnedTaskModeRequestV2;
export function isOwnedTaskModeV2(
  mode: OwnedTaskModeEnvelope,
): mode is OwnedTaskModeV2 {
  return "schemaVersion" in mode && mode.schemaVersion === 2;
}
export interface OwnedTaskRequestV2 {
  schemaVersion: 2;
  requestKey: string;
  surface: "chat" | "wave";
  contextId: string;
  mode: { contextId: string; artifactHash: string };
  roleSourceId: string;
  workClassId: string;
  prompt: string;
  hardCandidateKey: string | null;
  entry: OwnedTaskRequest["entry"];
  stepBudgetSeconds: number;
  /** A wave root's whole planned step sequence, this request first. */
  plannedTrajectory?: PlannedOwnedStep[] | null;
}
export interface PlannedOwnedStep {
  roleSourceId: string;
  workClassId: string;
  stepBudgetSeconds: number;
}
export type OwnedTaskPrepareIntent = OwnedTaskRequest | OwnedTaskRequestV2;
export interface NativeTaskContextV2 {
  schemaVersion: 2;
  intent: OwnedTaskRequestV2;
  consentHash: string;
  role: NativeTaskRole;
  envelopeHash: string;
  complete: boolean;
  unknownReasons: string[];
  selectedPolicyId: string | null;
  selectedPolicyHash: string | null;
  policyDiscovery: string;
  priorReason: string;
  inventoryHash: string;
}
export interface NativeTaskChoice {
  candidateKey: string;
  configuration: Configuration;
  available: boolean;
  reason: string | null;
}
export interface PreparedOwnedTask {
  binding: {
    id: string;
    createdAt: number;
    request: OwnedTaskRequest;
    certificateHash: string;
    task: PublicSelectorTask;
    contextHash: string;
    artifactHash: string;
    decision: ExecutorDecision;
    contextV2?: NativeTaskContextV2;
  };
  session: {
    owned: {
      sessionId: string;
      ownerId: string;
      policyHash: string;
      selection: {
        modelId: string | null;
        reasoningEffort: string | null;
        fastMode: boolean | null;
      };
      substitutions: unknown[];
    };
    observed: Configuration;
    contextHash: string;
  };
}
export interface OwnedTaskDispatch {
  requestKey: string;
  sessionId: string;
  runId: string;
  userMessageId: string;
  phase: "reserved" | "running" | "terminal" | "uncertain";
  eventCursor: number;
  result: unknown;
  error: { kind?: string; message?: string } | null;
}
/** App-measured facts about reported paths, from the sealed native artifact. */
export interface OwnedTaskArtifactFacts {
  checked: number;
  missing: string[];
  unchecked: number;
  changedFiles: number;
  afterTree: string;
}
export const ownedTaskExecution = {
  artifactFacts: (bindingId: string, paths: readonly string[]) =>
    invoke<OwnedTaskArtifactFacts>("benchmark_owned_task_artifact_facts", {
      bindingId,
      paths,
    }),
  inspectMode: (request: OwnedTaskModeRequestV2) =>
    invoke<NativeTaskConsent>("benchmark_inspect_owned_task_mode", { request }),
  nativeChoices: (contextId: string) =>
    invoke<NativeTaskChoice[]>("benchmark_owned_task_native_choices", {
      contextId,
    }),
  publicResult: (bindingId: string) =>
    invoke<{ text: string; elapsedMs: number }>(
      "benchmark_owned_task_public_result",
      { bindingId },
    ),
  choices: (promotionId: string) =>
    invoke<NativeTaskChoice[]>("benchmark_owned_task_choices", { promotionId }),
  reopen: (bindingId: string) =>
    invoke<void>("benchmark_reopen_owned_task", { bindingId }),
  getMode: (contextId: string) =>
    invoke<OwnedTaskModeEnvelope | null>("benchmark_get_owned_task_mode", {
      contextId,
    }),
  setMode: (request: OwnedTaskModeIntent) =>
    invoke<OwnedTaskModeEnvelope | null>("benchmark_set_owned_task_mode", {
      request,
    }),
  prepare: (request: OwnedTaskPrepareIntent) =>
    invoke<PreparedOwnedTask>("benchmark_prepare_owned_task", { request }),
  get: (bindingId: string) =>
    invoke<PreparedOwnedTask>("benchmark_get_owned_task", { bindingId }),
  dispatch: (bindingId: string) =>
    invoke<OwnedTaskDispatch>("benchmark_dispatch_owned_task", { bindingId }),
  status: (bindingId: string) =>
    invoke<OwnedTaskDispatch | null>("benchmark_owned_task_status", {
      bindingId,
    }),
  cancel: (bindingId: string, close = false) =>
    invoke<void>("benchmark_cancel_owned_task", { bindingId, close }),
};
