import { z } from "zod/v4";

import { BERDCTL_BOUNDS } from "../helpers";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { createDeferredQueuedMessagePayload } from "@/features/chat/lib/admittedSend";

import { CommandError, defineCommand } from "../types";

const createSessionSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe("The message to send in the new session (1-50000 chars)."),
    harness_id: z
      .string()
      .max(BERDCTL_BOUNDS.id)
      .optional()
      .describe(
        "Agent harness to run the session on (from `berdctl info harnesses`, " +
          'e.g. "claude-acp", "codex-acp"). Defaults to the app default.',
      ),
    model_id: z
      .string()
      .max(BERDCTL_BOUNDS.id)
      .optional()
      .describe(
        "Id of the model to use (from `berdctl info models`). An old id with " +
          'the effort folded in, like "gpt-5.6-sol[xhigh]", is still accepted ' +
          "and split, but is deprecated: pass --effort instead.",
      ),
    effort: z
      .string()
      .trim()
      .min(1)
      .max(BERDCTL_BOUNDS.id)
      .optional()
      .describe(
        "Reasoning effort to run the model at, in the harness's own words " +
          '(e.g. "high", "xhigh"). Must be one of the efforts `berdctl info ' +
          "models` lists for the chosen model, so it requires --model-id. " +
          "Omit it to run at the model's default.",
      ),
    fast_mode: z
      .boolean()
      .optional()
      .describe(
        "Run the model in fast mode. Only for a model `berdctl info models` " +
          'reports with "supports_fast": true, so it requires --model-id. ' +
          "Omit it to keep the model's default.",
      ),
    agent_id: z
      .string()
      .max(BERDCTL_BOUNDS.id)
      .optional()
      .describe(
        "Id of the agent (persona) to use (from `berdctl agent list`).",
      ),
    project_id: z
      .string()
      .max(BERDCTL_BOUNDS.id)
      .optional()
      .describe("Id of the project to create the session in."),
    startup_name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Branch/worktree name when the project's startup mode is branch or worktree; required for those modes.",
      ),
    from: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\r\n]*$/, "Sender label must be a single line.")
      .optional()
      .describe(
        "Optional visible sender label for the initial message (1-120 chars).",
      ),
  })
  .strict();

// The margin covers the store create + send dispatch after validation, so we
// never create a session the caller has already been told timed out.
const CREATE_DEADLINE_MARGIN_MS = 3_000;

// Spawn ACL (P42): the wire carries an optional `actor` — the calling
// session's AGENT_SESSION_ID, read from the shell env when the harness sets
// it — and this command enforces the same ACL as the in-app chokepoint
// against it (runtime/spawnGate.ts). Anonymous calls are the operator and
// stay allowed; with the built-in host every call is anonymous, so the ACL
// reaches agents through the prompt insert only (spawnGate.ts explains).

interface CreateSessionResult {
  session_id: string;
  title: string;
  harness_id: string;
  model_id: string | null;
  effort: string | null;
  fast_mode: boolean | null;
  send_status: "dispatched";
  deprecated?: string;
}

export const createSessionCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary:
    "Create a new chat session and send a prompt in it (fire-and-forget)",
  description:
    "Create a new chat session on any installed agent harness and send the prompt in it. " +
    "Fire-and-forget: returns the session id immediately and the session runs in the " +
    "background without changing what the user sees; the user can open it themselves. " +
    "Model, reasoning effort and fast mode are separate choices, each checked against " +
    "what `berdctl info models` reports for the chosen model. " +
    "Use --from to give the delegating session or tool a concise visible label on " +
    "the initial message. " +
    'Only check on it later (action "get") if the user asks.',
  helpFooter: `Examples:
  berdctl session create --prompt "Triage the failing nightly build" \\
    --harness-id claude-acp --from "the release orchestrator" --json
  berdctl session create --prompt "Plan the migration" \\
    --harness-id codex-acp --model-id gpt-5.6-sol --effort xhigh --fast-mode
  berdctl session create --prompt "Implement the fix" \\
    --project-id <project-id> --startup-name my-feature

Result:
  {"session_id": "...", "title": "...", "harness_id": "...",
   "model_id": "..."|null, "effort": "..."|null,
   "fast_mode": true|false|null, "send_status": "dispatched",
   "deprecated": "..."?}
  "model_id", "effort" and "fast_mode" echo the choices the session was
  created with; null leaves that choice to the harness or model default.
  "deprecated" appears when --model-id folded an effort in and says what to
  pass instead. The session runs in the background; the user's view does not
  change. Check progress later with
  \`berdctl session get --session-id <session_id>\`.`,
  schema: createSessionSchema,
  // Backend session create is a real round-trip; everything after it is
  // fire-and-forget.
  bridgeTimeoutMs: 900_000,
  execute: async (args, ctx): Promise<CreateSessionResult> => {
    // Effort and fast mode are only meaningful for a known model: with none
    // named, the harness opens on a default the operator's own settings pick,
    // so there is nothing to check them against. Refused before any I/O.
    if (
      !args.model_id &&
      (args.effort !== undefined || args.fast_mode !== undefined)
    ) {
      throw new CommandError(
        "invalid_args",
        "--effort and --fast-mode are checked against the model they run on; pass --model-id (from `berdctl info models`) with them.",
      );
    }
    const [
      { enforceBerdctlSpawnAcl, registerBerdctlChildNode },
      { acceptFirstSend },
      { useChatSessionStore },
      { resolveSessionCwd },
      {
        planProjectChatWorkspaces,
        planProjectChatWorkspacesAsIs,
        projectRequiresStartupWorkspaceName,
        rollbackProjectChatWorkspacePlan,
      },
      { berdctlCrossSessionSendOptions },
      { DEFAULT_HARNESS_ID },
      { normalizeSessionExecutionTarget, targetFromAgentModelSelection },
      { findPersonaOrThrow },
      { findProjectOrThrow },
      {
        findReadyHarnessOrThrow,
        harnessModelOptions,
        resolveRequestedModelSelection,
      },
    ] = await Promise.all([
      import("../runtime/spawnGate"),
      import("@/features/chat/lib/firstWorkspaceSend"),
      import("@/features/chat/stores/chatSessionStore"),
      import("@/features/projects/lib/sessionCwdSelection"),
      import("@/features/projects/lib/projectChatWorkspaces"),
      import("../runtime/sessionSend"),
      import("@/features/providers/curatedProviders"),
      import("@/features/chat/lib/sessionExecutionTarget"),
      import("../runtime/agents"),
      import("../runtime/projects"),
      import("../runtime/providers"),
    ]);
    const harnessId = args.harness_id ?? DEFAULT_HARNESS_ID;
    // The validation legs are independent I/O; overlap them. Readiness is
    // checked for the resolved harness, default included: creating on a
    // harness that is not installed or not signed in would either run a
    // multi-minute managed install inside this call or fail as an opaque
    // `internal_error` long after the caller was told "dispatched".
    const [project, , models, persona] = await Promise.all([
      args.project_id ? findProjectOrThrow(args.project_id) : null,
      findReadyHarnessOrThrow(harnessId),
      args.model_id ? harnessModelOptions(harnessId).catch(() => []) : null,
      args.agent_id ? findPersonaOrThrow(args.agent_id) : null,
    ]);
    // Enforced after validation resolved the target persona (the named
    // allowlist needs to know WHO is being started) and before anything is
    // created, so a refusal still costs nothing to roll back.
    enforceBerdctlSpawnAcl({
      actor: ctx.actor,
      verb: "create",
      targetLayer: "worker",
      targetPersona: persona,
    });
    // Soft validation: the model, its effort and fast mode are refused only
    // when the harness's model list is known and says no.
    const selection = resolveRequestedModelSelection({
      harnessId,
      models,
      modelId: args.model_id,
      effort: args.effort,
      fastMode: args.fast_mode,
    });
    const executionTarget = selection.modelId
      ? targetFromAgentModelSelection(harnessId, {
          modelProviderId: harnessId,
          modelId: selection.modelId,
          modelName: selection.modelName ?? selection.modelId,
        })
      : normalizeSessionExecutionTarget({ harnessId });
    const requiresStartupName = Boolean(
      project && projectRequiresStartupWorkspaceName(project),
    );
    const startupName = args.startup_name?.trim();
    let workspacePlan = project ? planProjectChatWorkspacesAsIs(project) : null;
    if (requiresStartupName) {
      if (!project || !startupName) {
        throw new CommandError(
          "workspace_name_required",
          `Project "${project?.id}" creates a branch or worktree for each new chat; pass --startup-name <name>.`,
        );
      }
      workspacePlan = await planProjectChatWorkspaces(project, startupName);
    } else if (startupName) {
      throw new CommandError(
        "invalid_args",
        "--startup-name only applies when the selected project's startup mode is branch or worktree.",
      );
    }
    // Even an as-is plan may contain a home-relative or relative project
    // folder. Keep its full attachment set, but resolve the primary cwd
    // through the same path resolver used before workspace planning existed.
    const workingDir = requiresStartupName
      ? (workspacePlan?.workingDir ?? (await resolveSessionCwd(project)))
      : await resolveSessionCwd(project);
    let session: ChatSession;
    try {
      // Past the broker deadline the agent was already told this call failed;
      // do not create a session it cannot see. The workspace plan may already
      // have created a branch/worktree, so the catch below rolls it back.
      if (
        ctx.deadlineMs != null &&
        Date.now() > ctx.deadlineMs - CREATE_DEADLINE_MARGIN_MS
      ) {
        throw new CommandError(
          "timed_out",
          "Validation took too long; no session was created. Retry once.",
        );
      }
      // Effort and fast mode go into creation itself: they are sent in
      // `session/new` with the model, so the first turn already runs on them,
      // and they become the chat's intent, so a model that turns a value down
      // keeps it and shows a notice instead of silently running at something
      // else. The selection was checked above; creation trusts it.
      session = await useChatSessionStore.getState().createSession({
        workingDir,
        projectId: args.project_id,
        executionTarget,
        runSettings: {
          ...(selection.effort !== undefined
            ? { effort: selection.effort }
            : {}),
          ...(selection.fastMode !== undefined
            ? { fast: selection.fastMode }
            : {}),
        },
        personaId: persona?.id,
        workspaceAttachments: workspacePlan?.workspaceAttachments,
        deferProviderSetup: false,
      });
    } catch (error) {
      await rollbackProjectChatWorkspacePlan(workspacePlan);
      throw error;
    }
    registerBerdctlChildNode({
      actor: ctx.actor,
      sessionId: session.id,
      role: "worker",
      harnessId,
      displayName: session.title,
      personaId: persona?.id,
      task: args.prompt.slice(0, 200),
    });
    const accepted = acceptFirstSend(
      session.id,
      createDeferredQueuedMessagePayload({
        text: args.prompt,
        persona: persona
          ? { kind: "persona", id: persona.id, name: persona.displayName }
          : { kind: "inherit" },
        sendOptions: berdctlCrossSessionSendOptions({
          senderLabel: args.from,
        }),
      }),
      { project, queueReady: true },
    );
    if (!accepted.accepted) {
      throw new CommandError(
        "queue_full",
        "The new session could not accept its first message.",
      );
    }
    return {
      session_id: session.id,
      title: session.title,
      harness_id: harnessId,
      model_id: selection.modelId ?? null,
      effort: selection.effort ?? null,
      fast_mode: selection.fastMode ?? null,
      send_status: "dispatched" as const,
      ...(selection.deprecated ? { deprecated: selection.deprecated } : {}),
    };
  },
});
