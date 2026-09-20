import { z } from "zod/v4";

import { DISTILLCTL_BOUNDS } from "../helpers";
import { defineCommand } from "../types";
import { DEFAULT_HARNESS_ID } from "@/features/providers/curatedProviders";

const forkSessionSchema = z
  .object({
    session_id: z
      .string()
      .max(DISTILLCTL_BOUNDS.id)
      .describe("Id of the session to fork (duplicate)."),
    title: z
      .string()
      .min(1)
      .max(DISTILLCTL_BOUNDS.name)
      .optional()
      .describe(
        "Optional title for the forked session. Defaults to the source title.",
      ),
  })
  .strict();

interface ForkSessionResult {
  session_id: string;
  title: string;
  source_session_id: string;
  harness_id: string;
  model_id: string | null;
  effort: string | null;
  fast_mode: boolean | null;
  message_count: number;
}

export const forkSessionCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary: "Fork a chat session into an independent copy with its history",
  description:
    "Duplicate an existing chat session, copying its full conversation history into a new " +
    "session the user can continue down an independent path. The fork opens on the " +
    "source's harness, model, reasoning effort and fast mode. It appears in the app's " +
    "session list; the user's current view does not change.",
  helpFooter: `Example:
  distillctl session fork --session-id <session-id> --title "Alternate approach"

Result:
  {"session_id": "...", "title": "...", "source_session_id": "...",
   "harness_id": "...", "model_id": "..."|null, "effort": "..."|null,
   "fast_mode": true|false|null, "message_count": 7}
  The fork appears in the session list with a copy of the original history.
  "harness_id", "model_id", "effort" and "fast_mode" are what the fork's model
  acknowledged when it opened; null means the model's own default.`,
  schema: forkSessionSchema,
  // Spawn ACL (P42): enforced in execute against the wire `actor`, like
  // `session create` (runtime/spawnGate.ts). A fork reproduces a session of
  // the source's own rank, so the target layer is the source node's role.
  // Fork is a real backend round-trip that copies the conversation history.
  bridgeTimeoutMs: 60_000,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "fork");
  },
  execute: async (args, ctx): Promise<ForkSessionResult> => {
    const [
      {
        enforceDistillctlSpawnAcl,
        forkTargetLayer,
        forkTargetPersona,
        registerDistillctlChildNode,
      },
      { acpDuplicateSession },
      { acpSessionToChatSession },
      { useChatSessionStore },
      { loadSessionForDistillctl, requireSession },
    ] = await Promise.all([
      import("../runtime/spawnGate"),
      import("@/shared/api/acp"),
      import("@/features/chat/lib/acpSessionMapping"),
      import("@/features/chat/stores/chatSessionStore"),
      import("../runtime/sessions"),
    ]);
    const targetLayer = forkTargetLayer(args.session_id);
    enforceDistillctlSpawnAcl({
      actor: ctx.actor,
      verb: "fork",
      targetLayer,
      targetPersona: forkTargetPersona(args.session_id),
    });
    await loadSessionForDistillctl(args.session_id);
    const source = requireSession(args.session_id);
    const forked = await acpDuplicateSession(
      args.session_id,
      source.workingDir ?? "~",
      args.title,
    );
    const chatSession = acpSessionToChatSession(forked);
    useChatSessionStore.getState().addSession(chatSession);
    const harnessId =
      chatSession.executionTarget?.harnessId ?? DEFAULT_HARNESS_ID;
    registerDistillctlChildNode({
      actor: ctx.actor,
      sessionId: forked.sessionId,
      role: targetLayer,
      harnessId,
      displayName: chatSession.title,
      task: `fork of ${args.session_id}`,
    });
    // The host opens the fork on the source's stored selection and answers
    // with what the bridge acknowledged, so these are the fork's own values,
    // not a copy of what was asked for.
    return {
      session_id: forked.sessionId,
      title: chatSession.title,
      source_session_id: args.session_id,
      harness_id: harnessId,
      model_id: forked.modelId ?? null,
      effort: forked.reasoningEffort ?? null,
      fast_mode: forked.fastMode ?? null,
      message_count: forked.messageCount,
    };
  },
});
