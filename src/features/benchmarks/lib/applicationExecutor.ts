import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import type { SessionRunSettings } from "@/features/chat/lib/sessionRunSettings";
import type { Configuration } from "../types";
import type { PublicSelectorTask } from "./benchmarkLearning";

export interface ApplicationExecutorOption {
  target: SessionExecutionTarget;
  runSettings?: SessionRunSettings;
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
      runSettings?.fast ?? false,
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
