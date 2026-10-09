import { parseAgentRankingSource } from "@/features/agents/lib/agentModelRanking";
import { modelPreferenceClassForPersona } from "@/features/agents/lib/modelRanking";
import {
  rankedPersonaExecutionTargets,
  type RankedPersonaTargetContext,
} from "@/features/agents/lib/rankedPersonaTarget";
import {
  applicationExecutorConfiguration,
  applicationExecutorTask,
  type ApplicationExecutorOption,
} from "@/features/benchmarks/lib/applicationExecutor";
import {
  executorSelection,
  type ExecutorDecision,
} from "@/features/benchmarks/lib/executorSelection";
import type { Persona } from "@/shared/types/agents";
import type { ModelOption } from "../types";

/** Account-specific inventory already loaded by the existing model picker. */
export interface ChatExecutorInventory {
  harnessId: string;
  accountId: string;
  models: readonly ModelOption[];
}

export type ChatExecutorSuggestionSource = (
  inventory?: ChatExecutorInventory,
) => Promise<ExecutorDecision | null>;

/** The work class a chat of this agent belongs to; `general` without one. */
export function chatWorkClass(
  persona?: Pick<Persona, "modelRanking" | "displayName"> | null,
): string {
  const source = parseAgentRankingSource(persona?.modelRanking);
  return source?.kind === "class"
    ? source.classId
    : ((persona ? modelPreferenceClassForPersona(persona) : undefined) ??
        "general");
}

/** Advisory only: no session writes, queue mutations or provider discovery. */
export async function previewChatExecutor(input: {
  contextId: string;
  prompt: string;
  persona?: Persona | null;
  current?: ApplicationExecutorOption;
  pinned: boolean;
  context: RankedPersonaTargetContext;
  inventory?: ChatExecutorInventory;
}): Promise<ExecutorDecision | null> {
  if (!input.prompt.trim()) return null;
  if (input.pinned && !input.current?.target.modelId) return null;
  const modelsForHarness = (harnessId: string) =>
    input.inventory?.harnessId === harnessId
      ? input.inventory.models
      : input.context.getModelsForHarness(harnessId);
  const context = { ...input.context, getModelsForHarness: modelsForHarness };
  const ranked = input.persona
    ? rankedPersonaExecutionTargets(input.persona, context)
    : [];
  const options =
    input.pinned && input.current
      ? [input.current, ...ranked]
      : [...ranked, ...(input.current ? [input.current] : [])];
  const rows = new Map<
    string,
    {
      configuration: NonNullable<
        ReturnType<typeof applicationExecutorConfiguration>
      >;
      available: boolean;
      reason: string | null;
    }
  >();
  for (const option of options) {
    const configuration = applicationExecutorConfiguration(option);
    if (!configuration || rows.has(configuration.id)) continue;
    if (rows.size === 32) break;
    if (input.inventory?.harnessId === option.target.harnessId)
      configuration.accountId = input.inventory.accountId;
    const available =
      context.providers.some((row) => row.id === option.target.harnessId) &&
      modelsForHarness(option.target.harnessId).some(
        (row) =>
          row.id === option.target.modelId &&
          (row.providerId ?? option.target.harnessId) ===
            option.target.modelProviderId,
      );
    rows.set(configuration.id, {
      configuration,
      available,
      reason: available ? null : "inventory_unconfirmed",
    });
  }
  const workClassId = chatWorkClass(input.persona);
  const pin =
    input.pinned && input.current
      ? (applicationExecutorConfiguration(input.current)?.id ?? null)
      : null;
  const candidates = [...rows.values()];
  return executorSelection.select(
    {
      requestKey: `chat-preview:${crypto.randomUUID()}`,
      surface: "chat",
      contextId: input.contextId,
      task: applicationExecutorTask({
        prompt: input.prompt,
        workClassId,
        roleId: input.persona?.id ?? null,
        rolePrompt: input.persona?.systemPrompt ?? "",
      }),
      targetFamily: `chat:${input.contextId}`,
      targetGroup: `chat:${input.contextId}`,
      candidates,
      priorIds: candidates.map((row) => row.configuration.id),
      hardCandidateId: pin,
      modelId: null,
      minQuality: 0,
    },
    false,
  );
}
