import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import type { SessionRunSettings } from "@/features/chat/lib/sessionRunSettings";
import type { RankableModel } from "@/features/agents/lib/modelRanking";
import type { Configuration } from "../types";
import type { PublicSelectorTask } from "./benchmarkLearning";

export interface ApplicationExecutorOption {
  target: SessionExecutionTarget;
  runSettings?: SessionRunSettings;
}

/** Add advertised effort/normal-mode choices after the original fallback options. */
export function applicationExecutorEffortOptions(
  preferred: readonly ApplicationExecutorOption[],
  modelForTarget: (target: SessionExecutionTarget) => RankableModel | undefined,
): ApplicationExecutorOption[] {
  const options: ApplicationExecutorOption[] = [];
  const seen = new Set<string>();
  const add = (option: ApplicationExecutorOption) => {
    const id = applicationExecutorConfiguration(option)?.id;
    if (!id || seen.has(id) || options.length === 32) return;
    seen.add(id);
    options.push(option);
  };
  preferred.forEach(add);
  for (const option of preferred) {
    const model = modelForTarget(option.target);
    if (
      !model ||
      model.id !== option.target.modelId ||
      (model.providerId ?? option.target.harnessId) !==
        option.target.modelProviderId
    )
      continue;
    const addNormalMode = (choice: ApplicationExecutorOption) => {
      if (
        choice.runSettings?.fast === undefined &&
        typeof model.supportsFast === "boolean"
      ) {
        add({
          target: choice.target,
          runSettings: { ...choice.runSettings, fast: false },
        });
      }
    };
    if (
      !option.runSettings?.effort ||
      model.efforts?.some((effort) => effort.id === option.runSettings?.effort)
    )
      addNormalMode(option);
    for (const effort of model.efforts ?? []) {
      if (!effort.id.trim()) continue;
      const choice = {
        target: option.target,
        runSettings: { ...option.runSettings, effort: effort.id },
      };
      add(choice);
      addNormalMode(choice);
    }
  }
  return options;
}

/** Local inventory row identity; the native service owns evidence-key hashing. */
export function applicationExecutorConfiguration(
  option: ApplicationExecutorOption,
): Configuration | null {
  const { target, runSettings } = option;
  if (!target.modelId) return null;
  return {
    id: JSON.stringify([
      target.harnessId,
      target.modelProviderId,
      target.modelId,
      runSettings?.effort ?? null,
      runSettings?.fast ?? null,
    ]),
    providerId: target.harnessId,
    accountId: null,
    modelId: target.modelId,
    modelName: target.modelName ?? null,
    effort: runSettings?.effort ?? null,
    fastMode: runSettings?.fast ?? null,
    billingMode: "unknown",
    executionProfile: "interactive_acp",
    inventoryRevision: null,
  };
}

/** Unknown runtime limits are zero; this does not assert benchmark isolation. */
export function applicationExecutorTask(input: {
  prompt: string;
  workClassId: string;
  roleId: string | null;
  rolePrompt: string;
  timeoutSeconds?: number;
}): PublicSelectorTask {
  return {
    prompt: input.prompt,
    workClassId: input.workClassId,
    roleId: input.roleId,
    rolePrompt: input.rolePrompt,
    fixtures: [],
    facets: {},
    permissions: {
      tools: ["acp_session"],
      network: true,
      context:
        "Interactive session permissions are resolved by the agent host at dispatch.",
    },
    executionProfile: "interactive_acp",
    limits: {
      timeoutSeconds: Math.ceil(input.timeoutSeconds ?? 0),
      maxTurns: 0,
      maxArtifactBytes: 0,
    },
    entry: null,
  };
}
