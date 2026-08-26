import { dispatchPrompt } from "@/features/chat/lib/sendCore";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { sessionSpawnPolicyPrompt } from "@/features/conductor/spawnAcl";
import { isWaveManagedSession } from "@/features/conductor/waveManagedSession";
import { composeMemorySection } from "@/features/memory/lib/memoryPrompt";
import { sessionMemoryWriteAccess } from "@/features/memory/lib/memoryWriteAccess";
import { useMemoryStore } from "@/features/memory/stores/memoryStore";
import { PLANNER_PROTOCOL_PROMPT } from "@/features/planner/lib/plannerFence";
import {
  composeSystemPrompt,
  formatPersonaSystemPrompt,
} from "@/features/projects/lib/chatProjectContext";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import type { Persona } from "@/shared/types/agents";
import type { ChatSendOptions } from "../types";

/**
 * The memory and planner half of a background session's system prompt.
 *
 * The two callers that compose an `executionSystemPrompt` themselves (the
 * foreground controller and the queued drain) already carry this; the
 * fallback below did not, so a session driven only through here — a berdctl
 * `sessions.create`/`sessions.send` — ran without the operator's memory and
 * without the protocol to add to it. Nothing about this context forbids it:
 * berdctl runs in the main window's renderer, where the memory store is
 * hydrated at startup like everywhere else, and the entries are the
 * operator's standing facts, not foreground UI state — they are scoped by
 * the *target* session's own project, read from the store.
 *
 * Same exclusion as the other two paths: a wave child answers to its
 * conductor, not to the operator's list — its prompt ends "with this report
 * block and no extra commentary after it", and a one-shot task runner has no
 * business writing to memory or the planner. berdctl can address a
 * wave-managed session directly, so the guard is checked here too.
 */
function composeOperatorProtocols(sessionId: string): string | undefined {
  if (isWaveManagedSession(sessionId)) return undefined;
  const projectId =
    useChatSessionStore.getState().getSession(sessionId)?.projectId ?? null;
  return composeSystemPrompt(
    composeMemorySection(
      useMemoryStore.getState().entries,
      projectId,
      // A session the memory ACL keeps read-only still reads the facts but
      // is not taught the fence the scanner would refuse.
      sessionMemoryWriteAccess(sessionId).allowed,
    ),
    PLANNER_PROTOCOL_PROMPT,
  );
}

/**
 * Sends a prompt to a session that has no mounted ChatView, fire-and-forget.
 * The response streams into the store through the global notification handler
 * exactly like an unfocused tab; the user message is recorded locally so the
 * conversation is complete when the user opens the session.
 *
 * Returns once the send is dispatched, not when the turn completes — the
 * caller (berdctl sessions.create) must not block on the agent's answer.
 *
 * `providerId` is the target session's provider (callers have it from
 * session creation); it stamps the pending-assistant hint for the response.
 */
export function sendPromptInBackground(
  sessionId: string,
  prompt: string,
  providerId: string,
  // `spawns` rides along so the spawn-policy line composed below reflects
  // the persona's own ACL override, not just its layer default.
  persona?: Pick<Persona, "id" | "displayName" | "systemPrompt" | "spawns">,
  sendOptions: ChatSendOptions = {},
  attachments?: ChatAttachmentDraft[],
  beforeUserMessageCommitted?: () => void,
  onUserMessageCommitted?: () => void,
  validateExecutionTarget?: () => void,
  onPromptDispatched?: () => void,
): Promise<void> {
  const systemPrompt =
    sendOptions.executionSystemPrompt ??
    composeSystemPrompt(
      formatPersonaSystemPrompt(persona),
      // Right after the persona, where the handwritten sentence used to
      // live in the agent files: the session's spawn permissions, generated
      // from the same ACL the spawn chokepoint enforces.
      sessionSpawnPolicyPrompt(sessionId, persona),
      sendOptions.systemPrompt,
      // Last, matching the foreground order: persona, workspace context,
      // then the operator protocols.
      composeOperatorProtocols(sessionId),
    );
  return dispatchPrompt(sessionId, prompt, {
    persona: persona
      ? { id: persona.id, name: persona.displayName }
      : undefined,
    attachments,
    assistantPrompt: sendOptions.assistantPrompt,
    displayText: sendOptions.displayText,
    chips: sendOptions.chips,
    userMessageMetadata: sendOptions.userMessageMetadata,
    acpGooseMetadata: sendOptions.acpGooseMetadata,
    // Compose only caller-provided target-session context, the requested
    // persona and the operator's memory/planner protocols (scoped to the
    // target session) — never foreground UI state.
    systemPrompt,
    // Same isolation rule: the target session's provider, never the
    // foreground active agent's (dispatchPrompt's default).
    providerId,
    beforeUserMessageCommitted,
    onUserMessageCommitted,
    onPromptDispatched,
    prepare: validateExecutionTarget,
    background: true,
  }).catch((error) => {
    // Readiness changed at the final reversible boundary. The intent owner
    // classifies this expected race (retain, queue, or refuse) deterministically.
    if (error instanceof PreCommitSendRejectedError) throw error;
    // dispatchPrompt has already recorded the failure in the session
    // transcript and the chat-state stores; this log is diagnostics only.
    console.error(
      `[background-send] prompt failed for session ${sessionId}`,
      error,
    );
    throw error;
  });
}
