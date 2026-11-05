import {
  rankedPersonaExecutionTargets,
  type RankedPersonaTargetContext,
} from "@/features/agents/lib/rankedPersonaTarget";
import {
  automaticExecutorOptions,
  applicationExecutorPriorIds,
  applicationExecutorConfiguration,
  applicationExecutorEffortOptions,
  applicationExecutorTask,
  type ApplicationExecutorOption,
} from "@/features/benchmarks/lib/applicationExecutor";
import { executorSelection } from "@/features/benchmarks/lib/executorSelection";
import type {
  ExecutorDecisionRecord,
  ExecutorHostReceipt,
} from "@/features/benchmarks/lib/executorSelection";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import type { QueuedMessageRecord } from "../stores/chatStore";
import {
  isCachedModelInventoryAuthoritativeForRouting,
  useProviderModelCacheStore,
} from "@/features/providers/stores/providerModelCacheStore";
import { assertQueuedMessageAttemptOwned } from "./queuedMessageAttemptOwnership";
import { getSessionDispatchTarget } from "./sessionTargetCoordinator";
import {
  PreCommitSendRejectedError,
  QueuedMessageAlreadyAcceptedError,
} from "./preCommitSendRejection";
import { normalizeSessionRunSettings } from "./sessionRunSettings";
import { appendAttachmentPaths } from "./attachments";
import type { Persona } from "@/shared/types/agents";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { chatWorkClass, previewChatExecutor } from "./chatExecutorSuggestion";

/** Captured with an accepted first task; later composer edits cannot change it. */
export interface InitialChatExecutorIntent {
  options: ApplicationExecutorOption[];
  priorIds: string[];
  roleId: string | null;
  rolePrompt: string;
  workClassId: string;
}

export function captureInitialChatExecutorIntent(input: {
  persona?: Persona | null;
  context: RankedPersonaTargetContext;
  current?: ApplicationExecutorOption;
}): InitialChatExecutorIntent {
  const ranked = input.persona
    ? rankedPersonaExecutionTargets(input.persona, input.context)
    : [];
  const priors = [...ranked, ...(input.current ? [input.current] : [])];
  return {
    options: automaticExecutorOptions(input.context, priors),
    priorIds: priors.flatMap((option) => {
      const configuration = applicationExecutorConfiguration(option);
      return configuration ? [configuration.id] : [];
    }),
    roleId: input.persona?.id ?? null,
    rolePrompt: input.persona?.systemPrompt ?? "",
    workClassId: chatWorkClass(input.persona),
  };
}

function initialTask(record: QueuedMessageRecord) {
  const intent = record.payload.sendOptions?.initialExecutorIntent;
  if (!intent) return null;
  const task = applicationExecutorTask({
    prompt: [
      record.payload.sendOptions?.assistantPrompt,
      appendAttachmentPaths(
        record.payload.text.trim(),
        record.payload.attachments,
      ) ||
        (record.payload.attachments?.some((a) => a.kind === "image")
          ? "Image attachments"
          : ""),
    ]
      .filter(Boolean)
      .join("\n\n"),
    workClassId: intent.workClassId,
    roleId: intent.roleId,
    rolePrompt: intent.rolePrompt,
  });
  task.facets.inputBytes = new TextEncoder().encode(task.prompt).length;
  task.permissions.context += ` Attachments: ${JSON.stringify((record.payload.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, path: a.path ?? null, ...(a.kind === "image" ? { mimeType: a.mimeType, base64Characters: a.base64.length } : {}) })))}`;
  return task;
}

function initialRequestKey(sessionId: string, record: QueuedMessageRecord) {
  return (
    record.payload.executorRequestKey ??
    `chat:${sessionId}:queue:${record.recordId}`
  );
}

function canonicalInitialTask(
  task: ReturnType<typeof applicationExecutorTask>,
) {
  // Native serde orders fields independently and emits null optional facets.
  return JSON.stringify(task, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry != null)
            .sort(([left], [right]) => left.localeCompare(right)),
        )
      : value,
  );
}

function isProvenUnaccepted(
  receipt: ExecutorHostReceipt | null | undefined,
  sessionId: string,
  requestKey: string,
) {
  return (
    receipt?.finish?.status === "failed" &&
    receipt.rejection?.reason === "quota_not_accepted" &&
    receipt.rejection.accountId === receipt.start.accountId &&
    receipt.start.link.decisionKey === requestKey &&
    receipt.start.link.logicalRunId === requestKey &&
    receipt.start.sessionId === sessionId
  );
}

function isUnboundAutomaticTask(
  sessionId: string,
  record: QueuedMessageRecord,
) {
  const session = useChatSessionStore.getState().getSession(sessionId);
  return Boolean(
    record.payload.sendOptions?.initialExecutorIntent &&
      !record.payload.sendOptions?.acpPromptMetadata?.executorSelection &&
      session &&
      !session.creationState &&
      session.initialExecutorMode !== "manual" &&
      session.messageCount === 0 &&
      !(useChatStore.getState().messagesBySession[sessionId] ?? []).some(
        (message) => message.role !== "system",
      ),
  );
}

export function needsInitialChatExecutor(
  sessionId: string,
  record: QueuedMessageRecord,
) {
  return (
    isUnboundAutomaticTask(sessionId, record) &&
    useChatSessionStore.getState().getSession(sessionId)
      ?.initialExecutorRequestKey !== initialRequestKey(sessionId, record)
  );
}

const initialPreparations = new Map<string, Promise<void>>();

/** Both queue owners prepare before taking the immutable dispatch target lease. */
export async function prepareQueuedInitialChatExecutor(
  sessionId: string,
  record: QueuedMessageRecord,
): Promise<void> {
  if (record.kind !== "transport-ready") return;
  const inFlight = initialPreparations.get(sessionId);
  if (inFlight) {
    await inFlight;
    return prepareQueuedInitialChatExecutor(sessionId, record);
  }
  if (!needsInitialChatExecutor(sessionId, record)) return;
  const preparation = (async () => {
    const assertOwned = () => {
      assertQueuedMessageAttemptOwned(
        useChatStore.getState().queuedMessageBySession[sessionId]?.[0],
        record,
      );
      if (
        !isUnboundAutomaticTask(sessionId, record) ||
        getSessionDispatchTarget(sessionId)
      )
        throw new PreCommitSendRejectedError(
          "Initial chat selection was superseded before dispatch",
        );
    };
    assertOwned();
    const intent = record.payload.sendOptions?.initialExecutorIntent;
    const task = initialTask(record);
    if (!intent || !task)
      throw new PreCommitSendRejectedError(
        "Initial executor intent is missing",
      );
    const requestKey = initialRequestKey(sessionId, record);
    const original = useChatSessionStore.getState().getSession(sessionId);
    const originalTarget = original?.executionTarget;
    const originalSettings = original?.desiredRunSettings;
    const previous = await executorSelection.get(requestKey);
    assertOwned();
    if (
      (previous?.hostExecution &&
        !isProvenUnaccepted(previous.hostExecution, sessionId, requestKey)) ||
      previous?.observations.length
    )
      throw new QueuedMessageAlreadyAcceptedError(requestKey);
    if (
      previous &&
      (previous.decision.request.contextId !== sessionId ||
        canonicalInitialTask(previous.decision.request.prediction.task) !==
          canonicalInitialTask(task))
    )
      throw new Error(
        "The saved initial chat decision does not match this accepted task",
      );
    const inventory = useProviderModelCacheStore.getState();
    // Home can accept a task before session/new reports its default model.
    // That confirmed automatic target is the fallback when no model was known
    // at acceptance; the accepted role and prompt remain unchanged.
    const options =
      intent.options.length > 0
        ? intent.options
        : originalTarget?.modelId
          ? applicationExecutorEffortOptions(
              [{ target: originalTarget, runSettings: originalSettings }],
              (target) =>
                inventory
                  .getModelsForProvider(target.harnessId)
                  .find((model) => model.id === target.modelId),
            )
          : [];
    // A task accepted while "default" still counted as a level carries that
    // variant beside the unspecified one; the native set must stay distinct.
    const seen = new Set<string>();
    const candidates = options.flatMap((option) => {
      const configuration = applicationExecutorConfiguration(option);
      if (!configuration || seen.has(configuration.id)) return [];
      seen.add(configuration.id);
      const available =
        isCachedModelInventoryAuthoritativeForRouting(
          inventory.providers.get(option.target.harnessId),
        ) &&
        inventory
          .getModelsForProvider(option.target.harnessId)
          .some(
            (model) =>
              model.id === option.target.modelId &&
              (model.providerId ?? option.target.harnessId) ===
                option.target.modelProviderId,
          );
      return [
        {
          configuration,
          available,
          reason: available ? null : "inventory_unconfirmed",
        },
      ];
    });
    const decision = previous
      ? await executorSelection.prepare(previous.decision.request)
      : await executorSelection.select(
          {
            requestKey,
            surface: "chat",
            contextId: sessionId,
            task,
            targetFamily: `chat:${sessionId}`,
            targetGroup: `chat:${sessionId}`,
            candidates,
            priorIds: applicationExecutorPriorIds(candidates, intent.priorIds),
            hardCandidateId: null,
            modelId: null,
            minQuality: 0,
          },
          true,
        );
    assertOwned();
    const live = useChatSessionStore.getState().getSession(sessionId);
    if (
      live?.executionTarget !== originalTarget ||
      live?.desiredRunSettings !== originalSettings
    )
      throw new PreCommitSendRejectedError(
        "Initial chat selection was superseded by a model or setting change",
      );
    const selected = options.find(
      (option) =>
        applicationExecutorConfiguration(option)?.id === decision.chosen?.id,
    );
    if (
      !selected ||
      !["prior", "learned"].includes(decision.source) ||
      (decision.source === "learned" && !decision.learnedDispatchAllowed)
    )
      throw new Error(
        "No eligible executor is available for this accepted chat task",
      );
    if (
      !candidates.some(
        (row) => row.available && row.configuration.id === decision.chosen?.id,
      )
    )
      throw new Error(
        "The selected chat executor is no longer in the confirmed model inventory",
      );
    // No await between publication and the caller's lease acquisition. The
    // ordinary preparation then requires the host's model/effort acknowledgement.
    const store = useChatSessionStore.getState();
    store.replaceSessionExecutionTarget(sessionId, selected.target);
    store.patchSession(sessionId, {
      desiredRunSettings: normalizeSessionRunSettings(selected.runSettings),
      initialExecutorRequestKey: requestKey,
    });
  })();
  initialPreparations.set(sessionId, preparation);
  try {
    await preparation;
  } finally {
    if (initialPreparations.get(sessionId) === preparation)
      initialPreparations.delete(sessionId);
  }
}

/** Used only while establishing a persona target, before a session is bound. */
export async function selectInitialChatExecutor(input: {
  contextId: string;
  prompt: string;
  persona: Persona;
  context: RankedPersonaTargetContext;
  fallback?: ApplicationExecutorOption;
}): Promise<ApplicationExecutorOption | undefined> {
  const options = automaticExecutorOptions(input.context, [
    ...rankedPersonaExecutionTargets(input.persona, input.context),
    ...(input.fallback ? [input.fallback] : []),
  ]);
  if (!input.prompt.trim()) return input.fallback;
  const decision = await previewChatExecutor({
    ...input,
    current: input.fallback,
    pinned: false,
  });
  if (!decision?.chosen) return input.fallback;
  // A certified class selector may choose; research predictions never do.
  if (!["prior", "pin", "learned"].includes(decision.source))
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

/** Bound on targets one message may be prepared for without running. */
const MAX_CHAT_EXECUTOR_TARGETS = 16;

/** The journal key of a message's dispatch to its `n`th later target. */
export function chatExecutorTargetKey(baseKey: string, target: number): string {
  return target === 0 ? baseKey : `${baseKey}:target:${target}`;
}

/** Shared native journal precedes the accepted prompt's irreversible boundary. */
export async function prepareChatExecutorDispatch(input: {
  sessionId: string;
  requestKey: string;
  prompt: string;
  acceptedPrompt?: string;
  systemPrompt?: string;
  assistantPrompt?: string;
  personaId?: string;
  workClassId?: string;
  attachments?: ChatAttachmentDraft[];
}) {
  const session = useChatSessionStore.getState().getSession(input.sessionId);
  const configuration = sessionConfiguration(input.sessionId);
  const history =
    useChatStore.getState().messagesBySession[input.sessionId] ?? [];
  const ordinaryTask = applicationExecutorTask({
    prompt: [input.assistantPrompt, input.prompt].filter(Boolean).join("\n\n"),
    workClassId: input.workClassId ?? "general",
    roleId: input.personaId ?? null,
    // The actual execution context, never the foreground active agent's role.
    rolePrompt: input.systemPrompt ?? "",
  });
  ordinaryTask.facets.inputBytes = new TextEncoder().encode(
    ordinaryTask.prompt,
  ).length;
  // File bytes and image semantics are unknown to this text-only contract.
  // Record attachment references, without manufacturing loaded fixtures.
  ordinaryTask.permissions.context += ` Attachments: ${JSON.stringify((input.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, path: a.path ?? null, ...(a.kind === "image" ? { mimeType: a.mimeType, base64Characters: a.base64.length } : {}) })))}`;
  const head =
    useChatStore.getState().queuedMessageBySession[input.sessionId]?.[0];
  const matchesConfiguration = (
    chosen: typeof configuration,
    initial: boolean,
    canRerouteAccount: boolean,
  ) =>
    configuration &&
    chosen &&
    Object.keys(configuration).every((key) => {
      if (key === "accountId" && canRerouteAccount) return true;
      // Native ordinary selection leaves unspecified account/run settings null.
      // Exact requested values still require the bridge's acknowledgement.
      if (
        initial &&
        (key === "id" ||
          (["accountId", "effort", "fastMode"].includes(key) &&
            chosen[key as keyof typeof chosen] == null))
      ) {
        if (key !== "id") return true;
        try {
          return (
            JSON.stringify(JSON.parse(chosen.id).slice(0, 3)) ===
            JSON.stringify(JSON.parse(configuration.id).slice(0, 3))
          );
        } catch {
          return false;
        }
      }
      return (
        chosen[key as keyof typeof chosen] ===
        configuration[key as keyof typeof configuration]
      );
    });
  // A message is not bound to the target it was first prepared for. A saved
  // decision that never ran belongs to a target the operator has since
  // changed (a spent account, another provider or model, other settings, an
  // edited role): it stays in the journal as it was, and the message runs
  // under the next target key with a decision for the session as it is now.
  // The keys are numbered, so a retry after a crash finds the attempt that
  // did run. Only a recorded execution refuses another dispatch: that would
  // be a second user turn.
  let requestKey = input.requestKey;
  let previous: ExecutorDecisionRecord | null = null;
  let task = ordinaryTask;
  let initial = false;
  let canRerouteAccount = false;
  for (let target = 0; ; target += 1) {
    const record = await executorSelection.get(requestKey);
    if (!record) break;
    const receipt = record.hostExecution;
    const provenUnaccepted = isProvenUnaccepted(
      receipt,
      input.sessionId,
      requestKey,
    );
    if ((receipt && !provenUnaccepted) || record.observations.length)
      throw new QueuedMessageAlreadyAcceptedError(requestKey);
    const keyInitial = Boolean(
      target === 0 &&
        head &&
        initialRequestKey(input.sessionId, head) === input.requestKey &&
        isUnboundAutomaticTask(input.sessionId, head) &&
        record.decision.request.prediction.hardCandidateKey === null,
    );
    const acceptedTask = keyInitial && head ? initialTask(head) : null;
    const keyTask = acceptedTask ?? ordinaryTask;
    // Only host-proven quota withdrawal lets the same decision run again; the
    // host rechecks account routing when it claims that attempt.
    const keyRerouteAccount =
      provenUnaccepted && receipt?.rejection?.automaticAccountRouting === true;
    const saved = record.decision;
    const savedTask = saved.request.prediction.task;
    const acceptedMatches =
      !keyInitial ||
      (acceptedTask !== null &&
        (input.acceptedPrompt ?? input.prompt) === head?.payload.text &&
        (input.personaId ?? null) === acceptedTask.roleId &&
        input.assistantPrompt === head?.payload.sendOptions?.assistantPrompt);
    const sameConfiguration = configuration
      ? matchesConfiguration(saved.chosen, keyInitial, keyRerouteAccount)
      : saved.chosen === null;
    if (
      acceptedMatches &&
      sameConfiguration &&
      saved.request.surface === "chat" &&
      saved.request.contextId === input.sessionId &&
      savedTask.prompt === keyTask.prompt &&
      savedTask.roleId === keyTask.roleId &&
      savedTask.permissions.context === keyTask.permissions.context
    ) {
      previous = record;
      task = keyTask;
      initial = keyInitial;
      canRerouteAccount = keyRerouteAccount;
      break;
    }
    if (target >= MAX_CHAT_EXECUTOR_TARGETS)
      throw new Error(
        `This message was prepared for ${MAX_CHAT_EXECUTOR_TARGETS + 1} other models or settings without running. Edit and save it to send it as a new message.`,
      );
    requestKey = chatExecutorTargetKey(input.requestKey, target + 1);
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
          requestKey,
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
    ((!initial && decision.source !== "pin") ||
      (initial &&
        (!["prior", "learned"].includes(decision.source) ||
          (decision.source === "learned" &&
            !decision.learnedDispatchAllowed))) ||
      !matchesConfiguration(decision.chosen, initial, canRerouteAccount))
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
    metadata: { decisionKey: requestKey, logicalRunId: requestKey },
  };
}
