import {
  rankedPersonaExecutionTargets,
  type RankedPersonaTargetContext,
} from "@/features/agents/lib/rankedPersonaTarget";
import {
  applicationExecutorConfiguration,
  applicationExecutorTask,
  type ApplicationExecutorOption,
} from "@/features/benchmarks/lib/applicationExecutor";
import { executorSelection } from "@/features/benchmarks/lib/executorSelection";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import type { Persona } from "@/shared/types/agents";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { previewChatExecutor } from "./chatExecutorSuggestion";

/** Used only while establishing a persona target, before a session is bound. */
export async function selectInitialChatExecutor(input: {
  contextId: string;
  prompt: string;
  persona: Persona;
  context: RankedPersonaTargetContext;
  fallback?: ApplicationExecutorOption;
}): Promise<ApplicationExecutorOption | undefined> {
  const options = [
    ...rankedPersonaExecutionTargets(input.persona, input.context),
    ...(input.fallback ? [input.fallback] : []),
  ];
  if (!input.prompt.trim()) return input.fallback;
  const decision = await previewChatExecutor({
    ...input,
    current: input.fallback,
    pinned: false,
  });
  if (!decision?.chosen) return input.fallback;
  if (decision.source !== "prior" && decision.source !== "pin")
    throw new Error("Research executor choices cannot establish a chat target");
  const selected = options.find(
    (option) =>
      applicationExecutorConfiguration(option)?.id === decision.chosen?.id,
  );
  if (!selected)
    throw new Error("Executor selection returned an unknown chat target");
  return selected;
}

function sessionConfiguration(sessionId: string) {
  const session = useChatSessionStore.getState().getSession(sessionId);
  const configuration = session?.executionTarget
    ? applicationExecutorConfiguration({
        target: session.executionTarget,
        // Preparation has already reconciled desired settings. Record the
        // bridge's native values, including an unsupported-intent fallback.
        runSettings: {
          effort: session.reasoningEffort?.currentValue,
          fast: session.fastMode?.enabled,
        },
      })
    : null;
  if (configuration) configuration.accountId = session?.accountId ?? null;
  return configuration;
}

/** Shared native journal precedes the accepted prompt's irreversible boundary. */
export async function prepareChatExecutorDispatch(input: {
  sessionId: string;
  requestKey: string;
  prompt: string;
  systemPrompt?: string;
  assistantPrompt?: string;
  personaId?: string;
  attachments?: ChatAttachmentDraft[];
}) {
  const session = useChatSessionStore.getState().getSession(input.sessionId);
  const configuration = sessionConfiguration(input.sessionId);
  const previous = await executorSelection.get(input.requestKey);
  const receipt = previous?.hostExecution;
  const provenUnaccepted =
    receipt?.finish?.status === "failed" &&
    receipt.rejection?.reason === "quota_not_accepted" &&
    receipt.rejection.accountId === receipt.start.accountId &&
    receipt.start.link.decisionKey === input.requestKey &&
    receipt.start.link.logicalRunId === input.requestKey &&
    receipt.start.sessionId === input.sessionId;
  // The decision remains immutable. Only host-proven quota withdrawal permits
  // another attempt; the host rechecks account routing when it claims that attempt.
  const canRerouteAccount =
    provenUnaccepted && receipt?.rejection?.automaticAccountRouting === true;
  if ((receipt && !provenUnaccepted) || previous?.observations.length)
    throw new Error(
      "This accepted chat task already has a recorded execution; refusing another dispatch",
    );
  const history =
    useChatStore.getState().messagesBySession[input.sessionId] ?? [];
  const task = applicationExecutorTask({
    prompt: [input.assistantPrompt, input.prompt].filter(Boolean).join("\n\n"),
    workClassId: "general",
    roleId: input.personaId ?? null,
    // The actual execution context, never the foreground active agent's role.
    rolePrompt: input.systemPrompt ?? "",
  });
  task.facets.inputBytes = new TextEncoder().encode(task.prompt).length;
  // File bytes and image semantics are unknown to this text-only contract.
  // Record attachment references, without manufacturing loaded fixtures.
  task.permissions.context += ` Attachments: ${JSON.stringify((input.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, path: a.path ?? null, ...(a.kind === "image" ? { mimeType: a.mimeType, base64Characters: a.base64.length } : {}) })))}`;
  if (previous) {
    const saved = previous.decision;
    const savedTask = saved.request.prediction.task;
    const sameConfiguration = configuration
      ? saved.chosen !== null &&
        Object.keys(configuration).every(
          (key) =>
            (key === "accountId" && canRerouteAccount) ||
            saved.chosen?.[key as keyof typeof configuration] ===
              configuration[key as keyof typeof configuration],
        )
      : saved.chosen === null;
    if (
      !sameConfiguration ||
      saved.request.surface !== "chat" ||
      saved.request.contextId !== input.sessionId ||
      savedTask.prompt !== task.prompt ||
      savedTask.roleId !== task.roleId ||
      savedTask.permissions.context !== task.permissions.context
    )
      throw new Error(
        "This queued message has a prepared executor decision. Restore its saved model, account and settings, or explicitly edit and save the queued message before retrying.",
      );
  }
  if (!previous && ((session?.messageCount ?? 0) > 0 || history.length > 0)) {
    const textHistory = JSON.stringify(
      history.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n"),
      })),
    );
    task.entry = {
      conversationPrefix: JSON.stringify({
        source: "renderer text history; non-text content is not projected",
        reportedMessageCount: session?.messageCount ?? null,
        availableMessages: history.length,
        truncated: textHistory.length > 262144,
        text: textHistory.slice(0, 262144),
      }),
      previousReports: [],
      remainingBudgetSeconds: 0,
    };
  }
  const decision = previous
    ? await executorSelection.prepare(previous.decision.request)
    : await executorSelection.select(
        {
          requestKey: input.requestKey,
          surface: "chat",
          contextId: input.sessionId,
          task,
          targetFamily: `chat:${input.sessionId}`,
          targetGroup: `chat:${input.sessionId}`,
          candidates: configuration
            ? [
                {
                  configuration,
                  available: true,
                  reason: "prepared_session_target",
                },
              ]
            : [],
          priorIds: configuration ? [configuration.id] : [],
          // History and manual pins remain bound to their prepared session. No
          // ranked alternative may replace it at an arbitrary turn.
          hardCandidateId: configuration?.id ?? null,
          modelId: null,
          minQuality: 0,
        },
        true,
      );
  if (
    configuration &&
    (decision.source !== "pin" ||
      !decision.chosen ||
      Object.keys(configuration).some(
        (key) =>
          !(key === "accountId" && canRerouteAccount) &&
          decision.chosen?.[key as keyof typeof configuration] !==
            configuration[key as keyof typeof configuration],
      ))
  )
    throw new Error(
      "Executor selection did not preserve the prepared chat target",
    );
  const assertCurrent = () => {
    if (
      JSON.stringify(sessionConfiguration(input.sessionId)) !==
      JSON.stringify(configuration)
    )
      throw new Error(
        "Chat executor preparation was superseded before dispatch",
      );
  };
  assertCurrent();
  return {
    assertCurrent,
    metadata: { decisionKey: input.requestKey, logicalRunId: input.requestKey },
  };
}
