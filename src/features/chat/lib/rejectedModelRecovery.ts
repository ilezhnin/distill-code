/**
 * Recovery from "the harness refuses the model this session is pinned to".
 *
 * A session can end up carrying a concrete model id its harness does not
 * serve — an agent's saved model, a ranking resolved against a stale
 * inventory, a model the CLI dropped in an update. Goose forwards the id to
 * the ACP agent verbatim as `session/set_config_option("model", <id>)`, the
 * agent answers `Invalid params`, and goose surfaces that as "Failed to set
 * ACP model option". The call happens inside `stream()`, i.e. on the send
 * path, so the failure repeats on EVERY send and there is no way out from
 * inside the chat: the operator sees the same error card forever.
 *
 * The other fixes stop bad ids from reaching a NEW session. This one is the
 * net under the ones already out there — and under whatever the next feature
 * gets wrong. When the harness rejects the session's model we drop the pin,
 * so the session falls back to the harness' own current model, which by
 * definition works.
 *
 * Two deliberate limits.
 *
 * The message is NOT re-sent (Q2). Repairing the target and re-dispatching
 * the operator's prompt on a model they did not choose is exactly the silent
 * substitution D5 forbids; we fix the target, say what happened, and let the
 * operator press send.
 *
 * Only the model is dropped, not the provider. The harness rejected a value
 * for the "model" option; nothing said the provider is wrong, and keeping it
 * preserves as much of the operator's choice as the evidence allows.
 */

import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { i18n } from "@/shared/i18n";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { replaceSessionTargetAfterDispatch } from "@/features/chat/lib/sessionTargetCoordinator";
import {
  isModelExecutionTarget,
  normalizeSessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";

/**
 * Matched by substring, on purpose.
 *
 * ACP carries this back as a plain JSON-RPC `Invalid params` (-32602) whose
 * human text goose composed; there is no code, field or `data` payload that
 * distinguishes "this model id is not one of mine" from any other invalid
 * parameter. The wording is goose's own (`Failed to set ACP model option`),
 * not the remote agent's, so it is as stable as anything else we could key
 * on — and the whole match is kept here, in one function, so the day goose
 * grows a real error code there is exactly one place to change.
 *
 * Both halves must appear. "Invalid params" alone is far too broad to hang a
 * target rewrite on, and the option name alone would also catch failures
 * that are about the transport rather than the value.
 */
export function isHarnessRejectedModelError(error: unknown): boolean {
  const message = formatAcpErrorMessage(error, "").toLowerCase();
  return (
    message.includes("failed to set acp model option") &&
    message.includes("invalid params")
  );
}

export interface RejectedModelRecovery {
  /** What the session was pinned to, as it was shown to the operator. */
  rejectedModelName: string;
  /** The harness that refused it. */
  harnessId: string;
}

/**
 * Drops the session's model pin so its next send runs on the harness'
 * current model. Returns what was dropped, or null when there was no model
 * pin to blame (the caller then leaves the raw error alone).
 */
export function recoverSessionFromRejectedModel(
  sessionId: string,
): RejectedModelRecovery | null {
  const session = useChatSessionStore.getState().getSession(sessionId);
  const target = session?.executionTarget;
  if (!target || !isModelExecutionTarget(target)) {
    return null;
  }

  // Deferred while a dispatch lease is held, which is the normal case here:
  // the rejection arrives from inside the send this session is still running.
  replaceSessionTargetAfterDispatch(
    sessionId,
    normalizeSessionExecutionTarget({
      harnessId: target.harnessId,
      modelProviderId: target.modelProviderId,
    }),
  );

  return {
    rejectedModelName: target.modelName || target.modelId,
    harnessId: target.harnessId,
  };
}

/**
 * The card the operator reads. It has to answer three questions at once —
 * which model was refused, what the chat is running on now, and how to choose
 * something else — because until it does, the only visible fact is an ACP
 * error that repeats forever.
 */
export function harnessRejectedModelNotice(
  recovery: RejectedModelRecovery,
): string {
  const harness =
    useAgentStore
      .getState()
      .providers.find((provider) => provider.id === recovery.harnessId)
      ?.label || recovery.harnessId;
  return i18n.t("chat:errors.harnessRejectedModel", {
    harness,
    model: recovery.rejectedModelName,
  });
}
