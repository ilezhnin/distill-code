import { flushBufferedStreamingUpdatesForSession } from "@/features/chat/acp/liveStreamingUpdates";
import { taskBindingId } from "@/features/chat/lib/executionOwnership";
import { completeAssistantMessage } from "@/features/chat/lib/messageCompletion";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  adoptSessionRun,
  adoptedSessionRun,
  forgetAdoptedSessionRun,
  getSessionPromptOwner,
} from "@/features/chat/lib/sessionPromptOwnership";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { logRendererEvent } from "@/shared/api/rendererLog";

/**
 * What the host answers a prompt for a chat while a turn of that chat is
 * still running (`prepare_session_account`, router/prompts.rs). The session
 * is not ready: the prompt was not taken, and the message is sent when the
 * host says the turn is over.
 */
const HOST_RUN_ACTIVE_MESSAGE = "A prompt is already running for this session";
const INVALID_PARAMS = -32602;

/**
 * The run id the renderer holds for a host turn it learned of from a refusal,
 * which names none. Steering corrects it on its own (`steerSession` retries
 * with the id the host reports), and the host's settlement clears it.
 */
export const UNNAMED_HOST_RUN = "__flock_host_run_unnamed__";

function errorField(error: unknown, key: "code" | "message"): unknown {
  return typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

/** Whether `error` is the host refusing a prompt because a turn still runs. */
export function isHostRunActiveRefusal(error: unknown): boolean {
  const code = errorField(error, "code");
  const message = errorField(error, "message");
  return (
    (code === undefined || code === INVALID_PARAMS) &&
    typeof message === "string" &&
    message.trim() === HOST_RUN_ACTIVE_MESSAGE
  );
}

/**
 * A dispatch the host refused because the chat's session is still running a
 * turn. Nothing was committed and nothing failed: every owner of a queued
 * send keeps the message first (LAWS/CHAT.md) and sends it once the session
 * is ready again, which the host's settlement of that turn says.
 */
export class SessionRunActiveError extends PreCommitSendRejectedError {
  constructor() {
    super(HOST_RUN_ACTIVE_MESSAGE);
    this.name = "SessionRunActiveError";
  }
}

// A clock of what the renderer has heard about each chat's run: the host's
// run updates, and every change of the chat's own run state. A host answer
// asked for before the latest of these is older than what the chat already
// shows, so it is not applied over it.
let runSignalClock = 0;
const lastRunSignalBySession = new Map<string, number>();
let watchingRunState = false;

function watchRunState(): void {
  if (watchingRunState) return;
  watchingRunState = true;
  useChatStore.subscribe((state, previous) => {
    if (state.sessionStateById === previous.sessionStateById) return;
    for (const [sessionId, runtime] of Object.entries(state.sessionStateById)) {
      const before = previous.sessionStateById[sessionId];
      if (
        runtime !== before &&
        (runtime.activeRunId !== (before?.activeRunId ?? null) ||
          runtime.chatState !== (before?.chatState ?? "idle"))
      ) {
        noteSessionRunSignal(sessionId);
      }
    }
  });
}

/** Record that something was heard about `sessionId`'s run just now. */
export function noteSessionRunSignal(sessionId: string): void {
  watchRunState();
  runSignalClock += 1;
  lastRunSignalBySession.set(sessionId, runSignalClock);
}

/** The current point of the clock, taken before asking the host. */
export function sessionRunSignalMark(): number {
  watchRunState();
  return runSignalClock;
}

function heardOfRunSince(sessionId: string, mark: number): boolean {
  return (lastRunSignalBySession.get(sessionId) ?? 0) > mark;
}

/**
 * Show a run the host reports for a chat that no prompt of this renderer
 * owns as running, with Stop, until the host settles it: the same adoption a
 * host update naming the run makes (`acpSessionInfoUpdate.ts`). Returns
 * whether the run was adopted.
 */
function adoptHostRun(sessionId: string, runId: string): boolean {
  const store = useChatStore.getState();
  if (
    taskBindingId(sessionId) !== null ||
    store.getSessionRuntime(sessionId).activeRunId !== null ||
    !adoptSessionRun(sessionId, runId)
  ) {
    return false;
  }
  store.setActiveRunId(sessionId, runId);
  if (!isSessionRunning(store.getSessionRuntime(sessionId).chatState)) {
    store.setChatState(sessionId, "streaming");
  }
  return true;
}

/**
 * After the host refused a dispatch with {@link SessionRunActiveError}: the
 * chat shows the host's turn and its queue waits for the host to settle it.
 * Not when the renderer heard of the chat's run while the refusal was on its
 * way (the turn may have ended already); the queue's own readiness check
 * decides then.
 */
export function holdForRefusingHostRun(sessionId: string, mark: number): void {
  if (heardOfRunSince(sessionId, mark)) return;
  if (!adoptHostRun(sessionId, UNNAMED_HOST_RUN)) return;
  void logRendererEvent(
    "info",
    `[queue] session ${sessionId} is still running a turn on the host; its queued message waits for that turn to end`,
  );
}

/**
 * The run of each listed chat as `session/list` reported it, applied to the
 * chats this renderer does not drive itself: a listed run is shown running
 * (the queue waits for it), and a run the renderer only adopted is settled
 * when the list says none is running. The second covers a settlement the
 * renderer never received. A chat whose run the renderer heard of after the
 * list was asked for keeps what it heard.
 */
export function applyListedHostRuns(
  sessions: readonly { sessionId: string; activeRunId?: string | null }[],
  mark: number,
): void {
  for (const { sessionId, activeRunId } of sessions) {
    if (activeRunId === undefined || heardOfRunSince(sessionId, mark)) {
      continue;
    }
    if (activeRunId !== null) {
      if (getSessionPromptOwner(sessionId) === null) {
        adoptHostRun(sessionId, activeRunId);
      }
    } else if (adoptedSessionRun(sessionId)) {
      settleAdoptedHostRun(sessionId);
    }
  }
}

function settleAdoptedHostRun(sessionId: string): void {
  flushBufferedStreamingUpdatesForSession(sessionId, { flushSubtitle: true });
  const store = useChatStore.getState();
  const messageId = store.getSessionRuntime(sessionId).streamingMessageId;
  if (messageId) {
    store.updateMessage(sessionId, messageId, completeAssistantMessage);
  }
  forgetAdoptedSessionRun(sessionId);
  store.setChatState(sessionId, "idle");
  store.settleActiveRun(sessionId);
}
