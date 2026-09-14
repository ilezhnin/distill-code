import { isConductorSession } from "@/features/conductor/conductorGraphStore";
import type { Message } from "@/shared/types/messages";
import type { ChatSession } from "../stores/chatSessionStore";
import { isDefaultChatTitle } from "./sessionTitle";
import {
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "./sessionExecutionTarget";
import {
  normalizeSessionRunSettings,
  sameSessionRunSettings,
  type SessionRunSettings,
} from "./sessionRunSettings";

interface NewChatRequest {
  title: string;
  projectId?: string;
  executionTarget?: SessionExecutionTarget;
  /** The effort and fast mode the new chat is asked to carry. */
  runSettings?: SessionRunSettings;
}

interface FindExistingDraftArgs {
  sessions: ChatSession[];
  activeSessionId: string | null;
  draftsBySession: Record<string, string>;
  messagesBySession: Record<string, Message[]>;
  sessionIdsWithTerminals?: ReadonlySet<string>;
  request: NewChatRequest;
  allowDraftReuse?: boolean;
}

function isMatchingContext(
  session: ChatSession,
  request: Omit<NewChatRequest, "title">,
): boolean {
  // Run settings are compared as INTENT. The observed effort may not have
  // arrived yet on a draft still being created, and it says nothing about fast
  // mode; a draft reused at another effort or fast value would silently run the
  // request on settings nobody asked for.
  return (
    session.projectId === request.projectId &&
    (!request.executionTarget ||
      sameSessionExecutionTarget(
        session.executionTarget,
        request.executionTarget,
      )) &&
    sameSessionRunSettings(
      normalizeSessionRunSettings(session.desiredRunSettings),
      normalizeSessionRunSettings(request.runSettings),
    )
  );
}

function sessionHasTerminal(
  session: ChatSession,
  sessionIdsWithTerminals: ReadonlySet<string>,
): boolean {
  return (
    sessionIdsWithTerminals.has(session.id) ||
    Boolean(
      session.clientSessionId &&
        sessionIdsWithTerminals.has(session.clientSessionId),
    )
  );
}

function isReusableDraft(
  session: ChatSession,
  localMessages: Message[] | undefined,
): boolean {
  return (
    !session.archivedAt &&
    session.intent !== "build-agent" &&
    !isConductorSession(session.id) &&
    !(session.clientSessionId && isConductorSession(session.clientSessionId)) &&
    session.messageCount === 0 &&
    (localMessages?.length ?? 0) === 0
  );
}

export function findExistingDraft({
  sessions,
  activeSessionId,
  draftsBySession,
  messagesBySession,
  sessionIdsWithTerminals = new Set(),
  request,
  allowDraftReuse = true,
}: FindExistingDraftArgs): ChatSession | undefined {
  if (!allowDraftReuse) {
    return undefined;
  }

  if (!isDefaultChatTitle(request.title)) {
    return undefined;
  }

  const candidates = sessions.filter(
    (session) =>
      isMatchingContext(session, request) &&
      isReusableDraft(session, messagesBySession[session.id]),
  );

  if (candidates.length === 0) {
    return undefined;
  }

  const activeCandidate = candidates.find(
    (session) => session.id === activeSessionId,
  );
  if (activeCandidate) {
    return activeCandidate;
  }

  const withContent = candidates.filter(
    (session) =>
      (draftsBySession[session.id] ?? "").length > 0 ||
      sessionHasTerminal(session, sessionIdsWithTerminals),
  );
  if (withContent.length > 0) {
    return (
      withContent.find((session) => session.id === activeSessionId) ??
      withContent[0]
    );
  }

  return undefined;
}
