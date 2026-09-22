/**
 * A chat opened on its agent, but not on the model it was asked to open on:
 * the harness refused that model in `session/new`, and the host opened the
 * session on the harness's own model instead. The chat is kept — the operator
 * asked for the agent, the model was a remembered preference riding along —
 * and three things follow. The chat's target becomes the model it is really
 * on, so the picker shows the truth (D5: no silent substitution). The
 * remembered preference is dropped, because it would fail the same way on the
 * next new chat. And the operator is told, in the words a failed switch uses.
 *
 * Kept free of the chat stores and the target coordinator on purpose: the
 * session store calls this while it is still being evaluated, and a module
 * that reaches back into it would find nothing there yet.
 */

import { toast } from "sonner";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { clearStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import {
  isModelExecutionTarget,
  materializeSessionExecutionModel,
  normalizeSessionExecutionTarget,
  type SessionExecutionModelSnapshot,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { i18n } from "@/shared/i18n";
import { sameModelIdentity } from "@/shared/lib/foldedModelId";

export interface RejectedCreationModel {
  modelId: string;
  reason?: string;
}

export function settleCreatedSessionOnHarnessModel({
  harnessId,
  requestedTarget,
  model,
  rejected,
}: {
  harnessId: string;
  requestedTarget: SessionExecutionTarget;
  /** The model the host reports the session on, when it reported one. */
  model: SessionExecutionModelSnapshot | null | undefined;
  rejected: RejectedCreationModel;
}): SessionExecutionTarget {
  const agentOnly = normalizeSessionExecutionTarget({
    harnessId: requestedTarget.harnessId,
    modelProviderId: requestedTarget.modelProviderId ?? harnessId,
  });
  const settled = model
    ? (materializeSessionExecutionModel(agentOnly, model) ?? agentOnly)
    : agentOnly;
  clearStoredModelPreference(harnessId);
  const rejectedName =
    isModelExecutionTarget(requestedTarget) &&
    sameModelIdentity(requestedTarget.modelId, rejected.modelId)
      ? requestedTarget.modelName || rejected.modelId
      : rejected.modelId;
  const agentName =
    useAgentStore
      .getState()
      .providers.find((provider) => provider.id === harnessId)?.label ||
    harnessId;
  toast.error(
    i18n.t("chat:notifications.modelLeftBehindOnAgentSwitch", {
      agent: agentName,
      model: rejectedName,
    }),
  );
  return settled;
}
