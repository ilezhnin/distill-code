import { invoke } from "@tauri-apps/api/core";
import type { Configuration } from "../types";
import type { PublicSelectorTask } from "./benchmarkLearning";
import type { ExecutorDecision } from "./executorSelection";

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
export const ownedTaskExecution = {
  publicResult: (bindingId: string) =>
    invoke<{ text: string; elapsedMs: number }>(
      "benchmark_owned_task_public_result",
      { bindingId },
    ),
  choices: (promotionId: string) =>
    invoke<
      {
        candidateKey: string;
        configuration: Configuration;
        available: boolean;
        reason: string | null;
      }[]
    >("benchmark_owned_task_choices", { promotionId }),
  reopen: (bindingId: string) =>
    invoke<void>("benchmark_reopen_owned_task", { bindingId }),
  getMode: (contextId: string) =>
    invoke<OwnedTaskMode | null>("benchmark_get_owned_task_mode", {
      contextId,
    }),
  setMode: (request: OwnedTaskModeRequest) =>
    invoke<OwnedTaskMode | null>("benchmark_set_owned_task_mode", { request }),
  prepare: (request: OwnedTaskRequest) =>
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
