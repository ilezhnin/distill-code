import { clearReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import {
  hasConversationMessages,
  replaceMessagesFromSessionReplay,
} from "@/features/chat/lib/sessionReplayReplacement";
import { completeReplayAssistantMessage } from "@/features/chat/acp/acpReplayAssistant";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type ChatSessionPatch,
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { checkDirectory } from "@/features/projects/lib/missingProjectDirs";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  type ExplicitCwdSource,
  getExplicitCwdSource,
} from "@/features/projects/lib/sessionCwdSelection";
import { resolveSessionArtifactCwd } from "@/shared/artifacts/sessionArtifactLocation";
import { perfLog } from "@/shared/lib/perfLog";
import {
  isDefaultChatTitle,
  titleFromUserText,
} from "@/features/chat/lib/sessionTitle";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { isWaveManagedSession } from "@/features/conductor/waveManagedSession";
import {
  interruptedTurnNoticeId,
  unansweredSendToReport,
  type UnansweredSendContext,
} from "@/features/chat/lib/unansweredSend";
import { i18n } from "@/shared/i18n";
import {
  createSystemNotificationMessage,
  getTextContent,
  type Message,
  type SystemNotificationAction,
} from "@/shared/types/messages";
import { getWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import {
  getWorkspaceAttachments,
  isSameWorkspacePath,
} from "@/features/chat/lib/workspaceAttachments";
import { executionTargetFromHostSession } from "@/features/chat/lib/hostExecutionTarget";
import {
  hydrateSessionTarget,
  transitionSessionTarget,
} from "@/features/chat/lib/sessionTargetCoordinator";

export function clearIdleStreamingMessageAfterReplay(
  sessionId: string,
): boolean {
  return useChatStore.getState().clearSettledStreamingMessage(sessionId);
}

function fallbackTitleFromReplay(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    try {
      const text = getTextContent(message).trim();
      if (text) {
        return titleFromUserText(text);
      }
    } catch {}
  }

  return null;
}

interface LoadSessionMessagesOptions {
  force?: boolean;
}

interface SessionLoadWorkingDir {
  workingDir: string;
  missingCwdWarning?: {
    source: ExplicitCwdSource;
    missingPath: string;
  };
}

async function resolveWorkingDirForSessionLoad(
  session: ChatSession | undefined,
  project: ProjectInfo | null,
): Promise<SessionLoadWorkingDir> {
  const activeWorkspace =
    session?.id != null
      ? useChatSessionStore.getState().activeWorkspaceBySession[session.id]
      : undefined;
  const workspaceSet = getWorkspaceRepository().chatWorkspaces(session, {
    activePath: activeWorkspace?.path,
  });
  const primaryWorkspacePath = workspaceSet.primary?.path;
  const primaryIsSessionAttachment =
    session && primaryWorkspacePath
      ? getWorkspaceAttachments(session).some(
          (attachment) =>
            attachment.source !== "excluded" &&
            isSameWorkspacePath(attachment.path, primaryWorkspacePath),
        )
      : false;
  const activeWorkspacePath =
    activeWorkspace?.path ??
    (primaryIsSessionAttachment ? primaryWorkspacePath : undefined);
  const explicitCwdSource = getExplicitCwdSource(
    project,
    activeWorkspacePath,
    session?.workingDir,
  );
  const explicitCwd = explicitCwdSource
    ? await checkDirectory(explicitCwdSource.path)
    : null;

  if (!explicitCwdSource || !explicitCwd) {
    return { workingDir: await resolveSessionArtifactCwd() };
  }
  if (!explicitCwd.missing) {
    return { workingDir: explicitCwd.resolvedPath };
  }

  const fallbackPath = await resolveSessionArtifactCwd();
  // resolveSessionArtifactCwd recreates the artifact directory, so a deleted
  // artifact root is already repaired — warning about it would tell the
  // user their folder was replaced by itself.
  if (fallbackPath === explicitCwd.resolvedPath) {
    return { workingDir: fallbackPath };
  }

  return {
    workingDir: fallbackPath,
    missingCwdWarning: {
      source: explicitCwdSource,
      missingPath: explicitCwd.resolvedPath,
    },
  };
}

function buildMissingCwdWarning(
  source: ExplicitCwdSource,
  missingPath: string,
  fallbackPath: string,
): Message {
  const action: SystemNotificationAction =
    source.type === "project"
      ? { type: "editProject", projectId: source.projectId }
      : { type: "openContextPanel" };
  const key =
    source.type === "project"
      ? "chat:toolbar.sessionLoadMissingProjectDir"
      : "chat:toolbar.sessionLoadMissingWorkingDir";

  return createSystemNotificationMessage(
    i18n.t(key, { missingPath, fallbackPath }),
    "warning",
    action,
  );
}

// Deterministic ids so reloads replace the loader's own notifications
// instead of stacking duplicates.
function loaderNoticeMessageId(
  sessionId: string,
  kind: "warning" | "error",
): string {
  return `session-load-${kind}:${sessionId}`;
}

/**
 * Surfaces a missing-folder fallback to the user and repairs local session
 * state so the dead path stops winning cwd resolution. Shared by the fresh
 * replay path and cache-hit activations, so the recovery notice appears
 * whenever the user lands in the chat — not only on a cold transcript load.
 */
function applyMissingCwdRecovery(
  sessionId: string,
  missingCwdWarning: { source: ExplicitCwdSource; missingPath: string },
  workingDir: string,
): void {
  const chatStore = useChatStore.getState();
  const sessionStore = useChatSessionStore.getState();
  chatStore.removeMessage(
    sessionId,
    loaderNoticeMessageId(sessionId, "warning"),
  );
  chatStore.addMessage(sessionId, {
    ...buildMissingCwdWarning(
      missingCwdWarning.source,
      missingCwdWarning.missingPath,
      workingDir,
    ),
    id: loaderNoticeMessageId(sessionId, "warning"),
  });
  if (missingCwdWarning.source.type === "workspace") {
    // The dead workspace path would otherwise keep winning cwd resolution
    // (loads, compaction, model changes) over the patched workingDir,
    // re-triggering the same fallback on every pass.
    sessionStore.clearActiveWorkspace(sessionId);
  }
  sessionStore.patchSession(sessionId, { workingDir });
}

/**
 * Removes the loader's missing-folder recovery notice. Called when the user
 * re-points the chat at a folder they just picked, which resolves the
 * condition the warning reported.
 */
export function clearSessionLoadWarningNotice(sessionId: string): void {
  useChatStore
    .getState()
    .removeMessage(sessionId, loaderNoticeMessageId(sessionId, "warning"));
}

const sessionLoadPromises = new Map<string, Promise<boolean>>();

type SessionLoadModules = [
  typeof import("@/shared/api/acp"),
  typeof import("@/features/chat/acp/acpNotificationHandler"),
];

let sessionLoadModulesPromise: Promise<SessionLoadModules> | null = null;

/**
 * The ACP client and replay handler are loaded lazily so the chat shell does
 * not pay for them on every screen — but loaded exactly once, and ideally
 * before the first chat is opened: under Vite dev the on-demand transform of
 * these modules was the single largest share of the first open of a chat.
 * A failed load is forgotten so the next open retries instead of failing
 * forever.
 */
function sessionLoadModules(): Promise<SessionLoadModules> {
  if (!sessionLoadModulesPromise) {
    const pending = Promise.all([
      import("@/shared/api/acp"),
      import("@/features/chat/acp/acpNotificationHandler"),
    ]);
    sessionLoadModulesPromise = pending;
    pending.catch(() => {
      if (sessionLoadModulesPromise === pending) {
        sessionLoadModulesPromise = null;
      }
    });
  }
  return sessionLoadModulesPromise;
}

/** Warm the chat load path in the background, e.g. once the app has started. */
export function prefetchSessionLoadModules(): void {
  void sessionLoadModules().catch(() => {
    // Reported by the next real load; nothing to do at prefetch time.
  });
}

/**
 * The chat-side report of a load that could not finish: one inline error
 * notice, replacing any earlier one. Deliberately no `setError` — parking
 * `chatState` at "error" would route the next send into a queue that never
 * flushes, and re-opening the session retries the load because the guard
 * ignores system-only messages.
 */
function reportSessionLoadFailure(sessionId: string, error: unknown): void {
  console.error("Failed to load session messages:", error);
  const errorMessage = formatAcpErrorMessage(
    error,
    i18n.t("chat:toolbar.sessionLoadFailed"),
  );
  const chatStore = useChatStore.getState();
  chatStore.removeMessage(sessionId, loaderNoticeMessageId(sessionId, "error"));
  chatStore.addMessage(sessionId, {
    ...createSystemNotificationMessage(errorMessage, "error"),
    id: loaderNoticeMessageId(sessionId, "error"),
  });
}

export async function loadSessionMessagesAndPrepare(
  sessionId: string,
  options: LoadSessionMessagesOptions = {},
): Promise<boolean> {
  const loaded = await loadSessionMessages(sessionId, options);
  if (!loaded) return false;

  const session = useChatSessionStore.getState().getSession(sessionId);
  const liveTarget = session?.executionTarget;
  if (liveTarget) {
    const project = session?.projectId
      ? (useProjectStore
          .getState()
          .projects.find((candidate) => candidate.id === session.projectId) ??
        null)
      : null;
    let resolvedWorkingDir: SessionLoadWorkingDir;
    try {
      resolvedWorkingDir = await resolveWorkingDirForSessionLoad(
        session,
        project,
      );
    } catch (error) {
      // Resolving the folder touches the disk (`resolvePath`,
      // `checkDirectoriesExist`) and can reject on an unmounted drive or
      // before the backend's state is managed. Every caller here is a `void`
      // call, so an escaping rejection became an unhandled one with nothing
      // said in the chat. Report it the way the replay path reports a failed
      // load, and leave the session unprepared rather than half-prepared.
      reportSessionLoadFailure(sessionId, error);
      return false;
    }
    const { workingDir, missingCwdWarning } = resolvedWorkingDir;
    if (missingCwdWarning) {
      // Reaching here with a warning means the load itself was skipped (the
      // transcript was still cached), so the replay path never surfaced the
      // fallback. Activation is the user landing in the chat — tell them now
      // instead of waiting for a cold reload.
      applyMissingCwdRecovery(sessionId, missingCwdWarning, workingDir);
    }
    try {
      await transitionSessionTarget({
        sessionId,
        target: liveTarget,
        workingDir: missingCwdWarning
          ? workingDir
          : (session?.workingDir ?? workingDir),
        prepareWorkingDir: workingDir,
      });
    } catch (error) {
      console.warn("Failed to prepare loaded session selection:", error);
    }
  }
  return true;
}

/**
 * Deduplicates only replay/session hydration. Caller-specific target
 * preparation deliberately happens after this shared promise settles, so load
 * join order cannot erase either an ordinary caller's preparation contract or
 * a sender's load-before-dispatch ordering contract.
 */
export async function loadSessionMessages(
  sessionId: string,
  options: LoadSessionMessagesOptions = {},
): Promise<boolean> {
  const existingLoad = sessionLoadPromises.get(sessionId);
  if (existingLoad) {
    return existingLoad;
  }

  const load = performSessionMessagesLoad(sessionId, options);
  sessionLoadPromises.set(sessionId, load);
  try {
    const loaded = await load;
    if (loaded) {
      useChatStore.getState().markQueuedMessagesReady(sessionId);
    }
    return loaded;
  } finally {
    if (sessionLoadPromises.get(sessionId) === load) {
      sessionLoadPromises.delete(sessionId);
    }
  }
}

async function performSessionMessagesLoad(
  sessionId: string,
  options: LoadSessionMessagesOptions,
): Promise<boolean> {
  const sid = sessionId.slice(0, 8);
  const existingMsgs = useChatStore.getState().messagesBySession[sessionId];
  if (!options.force && hasConversationMessages(existingMsgs)) {
    perfLog(`[perf:load] ${sid} skip — has messages`);
    clearIdleStreamingMessageAfterReplay(sessionId);
    useChatSessionStore
      .getState()
      .patchSession(sessionId, { pinnedLoadState: undefined });
    return true;
  }

  const sessionStore = useChatSessionStore.getState();
  const sessionAtRequest = sessionStore.getSession(sessionId);
  if (sessionAtRequest?.creationState === "pending") {
    perfLog(`[perf:load] ${sid} skip — session creation pending`);
    useChatStore.getState().setSessionLoading(sessionId, false);
    return true;
  }

  if (sessionAtRequest?.creationState === "failed") {
    perfLog(`[perf:load] ${sid} skip — session creation failed`);
    useChatStore.getState().setSessionLoading(sessionId, false);
    return false;
  }

  if (
    !sessionAtRequest &&
    sessionStore.sessions.some(
      (session) => session.clientSessionId === sessionId,
    )
  ) {
    perfLog(`[perf:load] ${sid} skip — stale client session id`);
    useChatStore.getState().setSessionLoading(sessionId, false);
    return true;
  }

  const t0 = performance.now();
  perfLog(`[perf:load] ${sid} start`);
  useChatStore.getState().setSessionLoading(sessionId, true);
  try {
    const [
      { acpGetSessionInfo, acpLoadSession },
      { getReplayPerf, clearReplayPerf },
    ] = await sessionLoadModules();
    const t1 = performance.now();
    // Mostly the render yield after setSessionLoading — the modules themselves
    // are prefetched at startup and resolve in microseconds.
    perfLog(`[perf:load] ${sid} modules ready in ${(t1 - t0).toFixed(1)}ms`);
    let sessionInfo: Awaited<ReturnType<typeof acpGetSessionInfo>> | null =
      null;
    if (sessionAtRequest?.pinnedLoadState) {
      try {
        sessionInfo = await acpGetSessionInfo(sessionId);
      } catch (error) {
        console.warn("Failed to refresh pinned session metadata:", error);
      }
    }
    if (sessionInfo) {
      const sessionStore = useChatSessionStore.getState();
      const hydratedTarget = executionTargetFromHostSession({
        providerId: sessionInfo.providerId ?? undefined,
        modelId: sessionInfo.modelId ?? undefined,
      });
      const sessionPatch: ChatSessionPatch = {
        projectId: sessionInfo.projectId ?? undefined,
        personaId: sessionInfo.personaId ?? undefined,
        archivedAt: sessionInfo.archivedAt ?? undefined,
        messageCount: sessionInfo.messageCount,
        subtitle: sessionInfo.subtitle ?? undefined,
        userSetName: sessionInfo.userSetName,
      };
      if (sessionInfo.title !== null) sessionPatch.title = sessionInfo.title;
      if (sessionInfo.workingDir !== null) {
        sessionPatch.workingDir = sessionInfo.workingDir;
      }
      if (sessionInfo.createdAt !== null) {
        sessionPatch.createdAt = sessionInfo.createdAt;
      }
      if (sessionInfo.updatedAt !== null) {
        sessionPatch.updatedAt = sessionInfo.updatedAt;
      }
      if (sessionInfo.lastMessageAt !== null) {
        sessionPatch.lastMessageAt = sessionInfo.lastMessageAt;
      }
      sessionStore.patchSession(sessionId, sessionPatch);
      if (hydratedTarget) {
        hydrateSessionTarget(sessionId, hydratedTarget);
      }
    }
    const session = useChatSessionStore.getState().getSession(sessionId);
    const project = session?.projectId
      ? (useProjectStore
          .getState()
          .projects.find((p) => p.id === session.projectId) ?? null)
      : null;
    const { workingDir, missingCwdWarning } =
      await resolveWorkingDirForSessionLoad(session, project);
    const loadedSelection = await acpLoadSession(sessionId, workingDir);
    const loadedTarget = loadedSelection
      ? executionTargetFromHostSession(loadedSelection)
      : undefined;
    if (loadedTarget) {
      hydrateSessionTarget(sessionId, loadedTarget);
    }
    const tFlush = performance.now();
    const latestSessionBeforeReplay = useChatSessionStore
      .getState()
      .getSession(sessionId);
    const historyExpectation = sessionAtRequest?.pinnedLoadState
      ? sessionInfo
        ? sessionInfo.messageCount > 0
          ? "nonempty"
          : "empty"
        : "unknown"
      : latestSessionBeforeReplay?.messageCount === undefined
        ? "unknown"
        : latestSessionBeforeReplay.messageCount > 0
          ? "nonempty"
          : "empty";
    const replayResult = replaceMessagesFromSessionReplay(sessionId, {
      historyExpectation,
    });
    const replayStats = getReplayPerf(sessionId);
    clearReplayPerf(sessionId);
    const chatStore = useChatStore.getState();
    if (replayResult.status === "invalid") {
      const errorMessage = i18n.t("chat:toolbar.sessionReplayIncomplete");
      chatStore.setSessionLoading(sessionId, false);
      chatStore.removeMessage(
        sessionId,
        loaderNoticeMessageId(sessionId, "error"),
      );
      chatStore.addMessage(sessionId, {
        ...createSystemNotificationMessage(errorMessage, "error"),
        id: loaderNoticeMessageId(sessionId, "error"),
      });
      useChatSessionStore.getState().patchSession(sessionId, {
        pinnedLoadState:
          sessionAtRequest?.pinnedLoadState && !sessionInfo
            ? "failed"
            : undefined,
      });
      clearIdleStreamingMessageAfterReplay(sessionId);
      perfLog(
        `[perf:load] ${sid} replay invalid: reason=${replayResult.reason} notifs=${replayStats?.count ?? 0}`,
      );
      return false;
    }

    const replayMessages = replayResult.messages;
    // Whether the transcript's last reply is still being written. `session/info`
    // is only fetched for a pinned load, but every `session/list` row carries
    // `_meta.activeRunId`, so an ordinary load can answer it too — otherwise the
    // last bubble of every finished chat keeps its in-progress affordances until
    // the next turn. A run the renderer itself knows about outranks the listed
    // value, which can be up to a refresh interval old.
    const runtimeBeforeCompletion =
      useChatStore.getState().sessionStateById[sessionId];
    const rendererKnowsOfARun =
      runtimeBeforeCompletion?.activeRunId != null ||
      isSessionRunning(runtimeBeforeCompletion?.chatState ?? "idle") ||
      Boolean(runtimeBeforeCompletion?.isRunCancellationPending);
    const knownActiveRunId =
      sessionInfo?.activeRunId !== undefined
        ? sessionInfo.activeRunId
        : rendererKnowsOfARun
          ? undefined
          : latestSessionBeforeReplay?.activeRunId;
    if (knownActiveRunId === null) {
      completeReplayAssistantMessage(sessionId);
    }
    const latestSession = useChatSessionStore.getState().getSession(sessionId);
    const sessionPatch: Partial<ChatSession> = {};
    if (
      latestSession &&
      !latestSession.userSetName &&
      isDefaultChatTitle(latestSession.title)
    ) {
      const fallbackTitle = fallbackTitleFromReplay(replayMessages);
      if (fallbackTitle) {
        sessionPatch.title = fallbackTitle;
      }
    }
    useChatSessionStore.getState().patchSession(sessionId, sessionPatch);
    const sessionStore = useChatSessionStore.getState();
    chatStore.removeMessage(
      sessionId,
      loaderNoticeMessageId(sessionId, "error"),
    );
    chatStore.removeMessage(
      sessionId,
      loaderNoticeMessageId(sessionId, "warning"),
    );
    if (missingCwdWarning) {
      applyMissingCwdRecovery(sessionId, missingCwdWarning, workingDir);
    }
    sessionStore.patchSession(sessionId, { pinnedLoadState: undefined });
    // Publish replay completion before an idle/error transition can wake a queued-message subscriber and route its prompt notifications into the consumed replay buffer.
    chatStore.setSessionLoading(sessionId, false);
    chatStore.setError(sessionId, null);
    clearIdleStreamingMessageAfterReplay(sessionId);
    const runtimeAfterReplay =
      useChatStore.getState().sessionStateById[sessionId];
    reportInterruptedTurn(sessionId, replayMessages, {
      // Both sources of "still working" are consulted: the host's run for this
      // session (from `session/info` on a pinned load, otherwise the listed
      // one) and the local runtime.
      isRunning:
        (knownActiveRunId ?? null) !== null ||
        isSessionRunning(runtimeAfterReplay?.chatState ?? "idle") ||
        Boolean(runtimeAfterReplay?.isRunCancellationPending),
      hasError: (runtimeAfterReplay?.chatState ?? "idle") === "error",
      hasQueuedSend:
        (useChatStore.getState().queuedMessageBySession[sessionId]?.length ??
          0) > 0,
      isAgentManaged: isWaveManagedSession(sessionId),
    });
    const t2 = performance.now();
    perfLog(
      `[perf:load] ${sid} replay: notifs=${replayStats?.count ?? 0} span=${replayStats?.spanMs.toFixed(1) ?? "0"}ms msgs=${replayMessages?.length ?? 0} flush=${(t2 - tFlush).toFixed(1)}ms total=${(t2 - t0).toFixed(1)}ms`,
    );
    return true;
  } catch (err) {
    clearReplayBuffer(sessionId);
    const chatStore = useChatStore.getState();
    clearIdleStreamingMessageAfterReplay(sessionId);
    chatStore.setSessionLoading(sessionId, false);
    reportSessionLoadFailure(sessionId, err);
    return false;
  }
}

/**
 * Says so when a loaded transcript ends on a message that never got an answer.
 *
 * The notice carries a fixed id, so re-opening the session replaces it rather
 * than stacking a second copy, and the moment the message is answered — by
 * the resend button or by anything else — the next load finds a reply at the
 * end and the notice is simply not written again.
 */
function reportInterruptedTurn(
  sessionId: string,
  messages: readonly Message[] | undefined,
  context: UnansweredSendContext,
): void {
  const chatStore = useChatStore.getState();
  const noticeId = interruptedTurnNoticeId(sessionId);
  chatStore.removeMessage(sessionId, noticeId);
  const unanswered = unansweredSendToReport(messages, context);
  if (!unanswered) return;
  chatStore.addMessage(sessionId, {
    ...createSystemNotificationMessage(
      i18n.t("chat:interruptedTurn.notice"),
      "warning",
      {
        type: "resendMessage",
        sessionId,
        text: getTextContent(unanswered),
      },
    ),
    id: noticeId,
  });
}

export function activateSession(sessionId: string): void {
  useChatSessionStore.getState().setActiveSession(sessionId);
  useChatStore.getState().setActiveSession(sessionId);
  useChatStore.getState().markSessionRead(sessionId);
}
