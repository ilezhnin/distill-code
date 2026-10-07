import { invoke } from "@tauri-apps/api/core";
import type { Configuration } from "../types";
import type {
  SelectorPrediction,
  SelectorPredictionRequest,
  PublicSelectorTask,
} from "./benchmarkLearning";

export interface ApplicationExecutorRequest {
  requestKey: string;
  surface: "chat" | "wave";
  contextId: string;
  task: PublicSelectorTask;
  targetFamily: string;
  targetGroup: string;
  candidates: SelectorPredictionRequest["candidates"];
  priorIds: string[];
  hardCandidateId: string | null;
  modelId: string | null;
  minQuality: number;
}

export interface ExecutorSelectionRequest {
  requestKey: string;
  surface: "chat" | "wave";
  contextId: string;
  prediction: SelectorPredictionRequest;
  priorKeys: string[];
  modelId: string | null;
}

export interface ExecutorDecision {
  request: ExecutorSelectionRequest;
  inputHash: string;
  artifactHash: string;
  createdAt: number;
  policyVersion: string;
  chosen: Configuration | null;
  chosenKey: string | null;
  source: "pin" | "prior" | "none";
  reason: string;
  learnedStatus: string;
  researchPrediction: SelectorPrediction | null;
  learnedDispatchAllowed: false;
}

export interface ExecutorObservation {
  phase: "started" | "terminal";
  sessionId: string | null;
  runId: string | null;
  configuration: Configuration | null;
  outcome: "completed" | "failed" | "cancelled" | "blocked" | null;
  reason: string | null;
}

export interface ExecutorDecisionRecord {
  decision: ExecutorDecision;
  observations: {
    createdAt: number;
    observation: ExecutorObservation;
    matchesSelected: boolean | null;
  }[];
}

/** Shared native boundary; preview has no writes and prepare precedes dispatch. */
export const executorSelection = {
  select: (request: ApplicationExecutorRequest, record: boolean) =>
    invoke<ExecutorDecision>("benchmark_select_executor", { request, record }),
  preview: (request: ExecutorSelectionRequest) =>
    invoke<ExecutorDecision>("benchmark_preview_executor_decision", {
      request,
    }),
  prepare: (request: ExecutorSelectionRequest) =>
    invoke<ExecutorDecision>("benchmark_prepare_executor_decision", {
      request,
    }),
  get: (requestKey: string) =>
    invoke<ExecutorDecisionRecord | null>("benchmark_get_executor_decision", {
      requestKey,
    }),
  observe: (requestKey: string, observation: ExecutorObservation) =>
    invoke<ExecutorDecisionRecord>("benchmark_observe_executor", {
      requestKey,
      observation,
    }),
};
