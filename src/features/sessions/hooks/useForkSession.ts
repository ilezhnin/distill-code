import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { acpSessionToChatSession } from "@/features/chat/lib/acpSessionMapping";
import { isModelExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { normalizeSessionRunSettings } from "@/features/chat/lib/sessionRunSettings";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { sameModelIdentity } from "@/shared/lib/foldedModelId";
import {
  acpDuplicateSession,
  type AcpDuplicateSessionOptions,
  type AcpSessionInfo,
} from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

/**
 * The host opens a fork on everything its source was running — model, effort
 * and fast mode (`fork_meta` in the agent host) — and answers with the model
 * id plus, from a host that knows them, the effort and fast mode it stored for
 * the fork. The chat-session mapping carries none of that intent, so mapped
 * alone the fork would get a bare target, with the id standing in for the
 * model's name, and the reconciler would treat the effort and fast mode as
 * never chosen.
 *
 * The host's answer wins where it gave one: it is what the fork's own record
 * holds and what the host re-applies on every attach. The source's intent
 * fills in what an older host did not say.
 */
function withSourceSelection(
  forked: ChatSession,
  source: ChatSession,
  answer: AcpSessionInfo,
): ChatSession {
  const target = forked.executionTarget;
  const sourceTarget = source.executionTarget;
  const desiredRunSettings = normalizeSessionRunSettings({
    ...source.desiredRunSettings,
    ...(answer.reasoningEffort ? { effort: answer.reasoningEffort } : {}),
    ...(typeof answer.fastMode === "boolean" ? { fast: answer.fastMode } : {}),
  });
  const sameModel =
    target &&
    sourceTarget &&
    isModelExecutionTarget(target) &&
    isModelExecutionTarget(sourceTarget) &&
    target.harnessId === sourceTarget.harnessId &&
    sameModelIdentity(target.modelId, sourceTarget.modelId);
  return {
    ...forked,
    ...(sameModel
      ? { executionTarget: { ...target, modelName: sourceTarget.modelName } }
      : {}),
    ...(desiredRunSettings ? { desiredRunSettings } : {}),
  };
}

function isSessionNotFoundError(error: unknown): boolean {
  return formatAcpErrorMessage(error, "").includes(
    "not found in sessions or threads",
  );
}

/**
 * Fork (duplicate) a chat session: copy its conversation history into a new
 * session, insert it into the store, and surface success/failure as a toast.
 *
 * Shared by the Session History grid and the sidebar chat-row menu so both
 * entry points behave identically. `onForked` runs after a successful fork
 * (e.g. to open the new session).
 */
export type ForkSessionOptions = AcpDuplicateSessionOptions;
export type ForkSessionHandler = (
  sessionId: string,
  options?: ForkSessionOptions,
) => void | Promise<void>;

export function useForkSession(options?: {
  onForked?: (sessionId: string) => void;
}): ForkSessionHandler {
  const { t } = useTranslation(["sessions", "common"]);
  const onForked = options?.onForked;

  return useCallback(
    async (sessionId: string, forkOptions?: ForkSessionOptions) => {
      const session = useChatSessionStore.getState().getSession(sessionId);
      if (!session) return;
      const sourceName = getDisplaySessionTitle(
        session.title,
        t("common:session.defaultTitle"),
      );
      try {
        const forked = await acpDuplicateSession(
          sessionId,
          session.workingDir ?? "~",
          t("history.copyTitle", { title: sourceName }),
          forkOptions,
        );
        useChatSessionStore
          .getState()
          .addSession(
            withSourceSelection(
              acpSessionToChatSession(forked),
              session,
              forked,
            ),
          );
        toast.success(t("history.forked", { title: sourceName }));
        onForked?.(forked.sessionId);
      } catch (error) {
        console.error("Fork failed:", error);
        if (isSessionNotFoundError(error)) {
          useChatSessionStore.getState().removeSession(sessionId);
        }
        toast.error(formatAcpErrorMessage(error, t("history.forkFailed")));
      }
    },
    [onForked, t],
  );
}
