/**
 * Applying a ranked reasoning effort to a session the app just created.
 *
 * The crew profiles (P36) are pairs of an order and an effort: "medium
 * engineering" and "heavy engineering" name the same four models and differ
 * only in how hard each one is asked to think. For codex-style harnesses the
 * effort rides inside the model id (`gpt-5.6-sol[xhigh]`), so picking the model
 * picks the effort; for every other harness — claude-acp, grok-acp — the effort
 * is a session config option, and a target that carried only the model id ran
 * at whatever the bridge defaults to. Two of the four ranked models were
 * therefore not routed as ranked at all: `coding-simple` and `coding-complex`
 * resolved identically.
 *
 * Nothing here refuses a spawn. A session that advertises no effort option, or
 * whose option list does not include the effort the ranking asked for, keeps
 * the effort it has: the step still runs, and running at the harness default is
 * exactly what happened before this existed.
 */

import type { EmbeddedReasoningEffort } from "@/features/chat/lib/modelReasoningVariants";
import { hostSelectionFromExecutionTarget } from "@/features/chat/lib/hostExecutionTarget";
import {
  useChatSessionStore,
  type ChatSessionReasoningEffortConfig,
} from "@/features/chat/stores/chatSessionStore";
import { acpSetSessionConfigOption } from "@/shared/api/acp";

/**
 * The option id to send for a named effort, or `null` when this session's
 * config cannot express it.
 *
 * Matching is by option id first, then by name, both case-insensitively: the
 * harnesses spell the same tiers differently ("xhigh", "XHigh", "Extra high"),
 * and an effort the list does not offer must resolve to nothing rather than to
 * the nearest-looking neighbour — silently running a step at a *different*
 * effort than the ranking asked for is the failure this whole path exists to
 * remove.
 */
export function reasoningEffortOptionId(
  config: ChatSessionReasoningEffortConfig | undefined,
  effort: EmbeddedReasoningEffort,
): string | null {
  if (!config || config.options.length === 0) return null;
  const wanted = effort.toLowerCase();
  const byId = config.options.find(
    (option) => option.id.toLowerCase() === wanted,
  );
  if (byId) return byId.id;
  const byName = config.options.find(
    (option) => (option.name ?? "").toLowerCase() === wanted,
  );
  return byName ? byName.id : null;
}

/** Test seam: the one effect this module has. */
export interface ChildReasoningEffortIo {
  setConfigOption: typeof acpSetSessionConfigOption;
}

const liveIo: ChildReasoningEffortIo = {
  // Called through a wrapper rather than bound here: every test that mocks
  // `@/shared/api/acp` for some other reason would otherwise have to name this
  // export, because the binding would be read the moment this module loads.
  setConfigOption: (sessionId, configId, value, context) =>
    acpSetSessionConfigOption(sessionId, configId, value, context),
};

let io: ChildReasoningEffortIo = liveIo;

export function setChildReasoningEffortIoForTests(
  next: Partial<ChildReasoningEffortIo>,
): void {
  io = { ...liveIo, ...next };
}

export function resetChildReasoningEffortIoForTests(): void {
  io = liveIo;
}

/**
 * Sets a freshly created child session's reasoning effort to `effort`.
 *
 * Resolves to `true` when the session was actually moved. Never throws: the
 * child is already created and its prompt already queued by the time this
 * runs, so a config call that fails must cost the effort and nothing else.
 */
export async function applyChildReasoningEffort(
  sessionId: string,
  effort: EmbeddedReasoningEffort,
): Promise<boolean> {
  const sessions = useChatSessionStore.getState();
  const session = sessions.getSession(sessionId);
  const config = session?.reasoningEffort;
  const optionId = reasoningEffortOptionId(config, effort);
  if (!config || !optionId) return false;
  if (config.currentValue === optionId) return true;

  // Optimistic, like the toolbar's own path: the chip says what was asked for
  // while the call is in flight, and the previous value is restored if it
  // fails.
  sessions.patchSession(sessionId, {
    reasoningEffort: { ...config, currentValue: optionId },
  });
  const { providerId, modelId } = hostSelectionFromExecutionTarget(
    session?.executionTarget,
  );
  try {
    const snapshot = await io.setConfigOption(
      sessionId,
      config.configId,
      optionId,
      { providerId, modelId, reasoningEffortValue: optionId },
    );
    if (snapshot.reasoningEffort) {
      useChatSessionStore.getState().patchSession(sessionId, {
        reasoningEffort: snapshot.reasoningEffort,
      });
    }
    return true;
  } catch (error) {
    useChatSessionStore
      .getState()
      .patchSession(sessionId, { reasoningEffort: config });
    console.error(
      `Failed to set the reasoning effort of ${sessionId} to ${effort}:`,
      error,
    );
    return false;
  }
}
