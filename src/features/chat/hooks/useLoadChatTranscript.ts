import { useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { importSessionTranscript } from "@/shared/api/acpApi";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { readTextFile } from "@/shared/api/system";
import { normalizeDialogSelection } from "@/shared/lib/dialogSelection";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { activateSession, loadSessionMessages } from "../lib/sessionActivation";

const READY_WAIT_MS = 20_000;

interface LoadChatTranscriptOptions {
  sessionId: string | null;
  ensureSession?: () => Promise<{ id: string } | null | undefined>;
  onImported?: (sessionId: string) => void;
}

/** Load into this composer's session, creating Home's session when needed. */
export function useLoadChatTranscript({
  sessionId,
  ensureSession,
  onImported,
}: LoadChatTranscriptOptions): () => Promise<void> {
  const { t } = useTranslation("chat");
  const busy = useRef(false);

  return useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const selected = await open({
        title: t("toolbar.loadChatDialogTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const path = normalizeDialogSelection(selected)[0];
      if (!path) return;

      const file = await readTextFile(path);
      // Home owns a separate session which need not be the globally active
      // chat. Keep the destination of the clicked composer across the picker.
      const targetId = sessionId ?? (await ensureSession?.())?.id ?? null;
      const session = await waitForBackendSession(targetId);
      if (!session) {
        toast.error(t("toolbar.loadChatNotReady"));
        return;
      }

      const loaded = await importSessionTranscript(session.id, file.contents);
      const sessions = useChatSessionStore.getState();
      const current = sessions.getSession(session.id);
      sessions.patchSession(session.id, {
        messageCount: (current?.messageCount ?? 0) + loaded.messageCount,
        ...(loaded.lastSnippet ? { lastSnippet: loaded.lastSnippet } : {}),
        ...(loaded.title ? { title: loaded.title } : {}),
      });
      // Use the regular replay path so cached existing messages are replaced
      // with the complete saved history, including the newly imported events.
      const refreshed = await loadSessionMessages(session.id, { force: true });
      (onImported ?? activateSession)(session.id);
      if (refreshed) {
        toast.success(
          t("toolbar.loadChatDone", { count: loaded.messageCount }),
        );
      }
    } catch (error) {
      toast.error(t("toolbar.loadChatFailed"), {
        description: formatAcpErrorMessage(error, t("toolbar.loadChatFailed")),
      });
    } finally {
      busy.current = false;
    }
  }, [ensureSession, onImported, sessionId, t]);
}

async function waitForBackendSession(
  startId: string | null,
): Promise<{ id: string } | undefined> {
  const started = Date.now();
  if (!startId) return undefined;

  while (Date.now() - started < READY_WAIT_MS) {
    const state = useChatSessionStore.getState();
    const session =
      state.getSession(startId) ??
      state.sessions.find((candidate) => candidate.clientSessionId === startId);
    if (!session) return undefined;
    if (session.creationState === "failed") {
      throw new Error(
        session.creationError || "This chat could not be created",
      );
    }
    if (session.creationState == null) {
      return { id: session.id };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}
