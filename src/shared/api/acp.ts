import type { ContentBlock } from "@agentclientprotocol/sdk";
import * as directAcp from "./acpApi";
import type {
  AcpForkSessionOptions,
  AcpSessionInfo,
  AcpSessionsPage,
  AcpSteerResponse,
} from "./acpApi";
import * as sessionRegistry from "./acpSessionRegistry";
import type {
  AcpRunSettingsPlanner,
  AcpSessionExecutionSelection,
  AcpSessionRunSettingsWrite,
} from "./acpSessionRegistry";
import {
  getCatalogEntry,
  resolveAgentProviderCatalogId,
} from "@/features/providers/providerCatalog";
import {
  setActiveMessageId,
  clearActiveMessageId,
} from "./acpActiveMessageTracking";
import {
  searchSessionsViaTranscripts,
  type SessionSearchOptions,
  type SessionSearchTarget,
} from "./sessionSearch";
import {
  preparePersonaHandoff,
  type PersonaHandoffClaim,
} from "./acpPersonaHandoff";
import { getDistillctlPreamble } from "@/features/distillctl/appPreamble";
import { sessionStyleGuidelinesPrompt } from "@/features/chat/lib/sessionSettings";
import { INTERACTION_NORMS_PREAMBLE } from "@/shared/api/interactionNorms";
import { perfLog } from "@/shared/lib/perfLog";
import {
  applySessionConfigOptionsSnapshot,
  readSessionConfigOptionsSnapshots,
  type AcpSessionConfigSnapshotContext,
  type AcpSessionConfigSnapshots,
} from "./acpSessionConfigSnapshots";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";
import { sameModelIdentity } from "@/shared/lib/foldedModelId";
import { formatAcpErrorMessage } from "./acpErrors";
import { recordSessionTokens } from "@/features/stats/lib/usageLedger";

export interface AcpProvider {
  id: string;
  label: string;
}

export interface AcpSendMessageOptions {
  systemPrompt?: string;
  assistantPrompt?: string;
  personaId?: string;
  personaName?: string;
  /** Extra `_meta` the host records on the prompt (origin, sender labels). */
  promptMeta?: Record<string, unknown>;
  /** Image attachments as [base64Data, mimeType] pairs. */
  images?: [string, string][];
  /** Fires after ACP setup/client acquisition, immediately before transport. */
  onPromptDispatching?: () => void;
  /** Fires after ACP setup completes and the external prompt invocation starts. */
  onPromptDispatched?: () => void;
}

export interface AcpCreateSessionOptions {
  personaId?: string;
  projectId?: string;
  modelId?: string | null;
  /** The operator's chosen effort, in the harness's own vocabulary. */
  reasoningEffort?: string;
  /** The operator's chosen fast mode; absent means nobody chose. */
  fastMode?: boolean;
}

export interface AcpSessionConfigApplyOptions {
  forceConfigRefresh?: boolean;
  /** Model the caller will apply as part of the same session preparation. */
  modelId?: string | null;
  /** UI selection intent that owns any response snapshots. */
  requestId?: string;
  /**
   * Decides the effort and fast writes that follow the model apply, from the
   * answer that apply produced. It runs inside the same per-session mutation,
   * so provider → model → effort → fast reach the bridge as one ordered
   * sequence under `requestId` with nothing interleaved.
   */
  planRunSettings?: AcpRunSettingsPlanner;
}

export interface AcpCreateSessionResult {
  sessionId: string;
  configOptionsSnapshot: AcpSessionConfigSnapshots;
  /**
   * The model the session was asked to open on, when the harness would not
   * run it. The session exists all the same, on the harness's own model
   * (`configOptionsSnapshot.model`): a remembered model the harness has since
   * retired must not cost the operator the chat they asked for.
   */
  rejectedModel?: { modelId: string; reason?: string };
}

export type AcpDuplicateSessionOptions = AcpForkSessionOptions;

/** The ACP harnesses the app can run sessions on. */
export async function discoverAcpProviders(): Promise<AcpProvider[]> {
  const providers = await directAcp.listProviders();
  return resolveProvidersCatalog(providers);
}

function resolveProvidersCatalog(providers: AcpProvider[]): AcpProvider[] {
  const seen = new Set<string>();

  return providers
    .map((provider) => {
      const catalogId = resolveAgentProviderCatalogId(
        provider.id,
        provider.label,
      );
      const resolvedId = catalogId ?? provider.id;
      if (seen.has(resolvedId)) {
        return null;
      }
      seen.add(resolvedId);
      return {
        id: resolvedId,
        label: getCatalogEntry(resolvedId)?.displayName ?? provider.label,
      };
    })
    .filter((provider): provider is AcpProvider => provider !== null);
}

/** Send a message to an ACP agent. Response streams via Tauri events. */
export function acpSendMessage(
  sessionId: string,
  prompt: string,
  options: AcpSendMessageOptions = {},
): Promise<void> {
  return sessionRegistry.runPreparedSessionPrompt(sessionId, (providerId) =>
    acpSendMessageNow(sessionId, prompt, providerId, options),
  );
}

async function acpSendMessageNow(
  sessionId: string,
  prompt: string,
  providerId: string,
  options: AcpSendMessageOptions,
): Promise<void> {
  const {
    systemPrompt,
    assistantPrompt,
    personaId,
    personaName,
    promptMeta,
    images,
    onPromptDispatching,
    onPromptDispatched,
  } = options;
  const sid = sessionId.slice(0, 8);
  const tStart = performance.now();

  // ACP agents expose no system-prompt channel, so the persona and the app
  // context are handed off in-band on the first prompt under that agent.
  // See acpPersonaHandoff.
  const [distillctlPreamble, styleGuidelines] = await Promise.all([
    getDistillctlPreamble(sessionId),
    sessionStyleGuidelinesPrompt(sessionId),
  ]);
  const appPreamble = [
    INTERACTION_NORMS_PREAMBLE,
    styleGuidelines,
    distillctlPreamble,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
  const personaHandoffClaim: PersonaHandoffClaim | null = preparePersonaHandoff(
    sessionId,
    providerId,
    systemPrompt,
    appPreamble,
  );

  // Merge the persona handoff (when present) with any skill/builder assistant
  // prompt into a single assistant-audience block, persona first.
  const assistantPromptParts = [
    personaHandoffClaim?.preamble,
    assistantPrompt?.trim(),
  ].filter((part): part is string => Boolean(part?.trim()));
  const mergedAssistantPrompt =
    assistantPromptParts.length > 0
      ? assistantPromptParts.join("\n\n")
      : undefined;

  const content: ContentBlock[] = [];
  if (mergedAssistantPrompt) {
    content.push({
      type: "text",
      text: mergedAssistantPrompt,
      annotations: { audience: ["assistant"] },
    });
  }
  content.push({ type: "text", text: prompt });
  if (images) {
    for (const [data, mimeType] of images) {
      content.push({ type: "image", data, mimeType } as ContentBlock);
    }
  }

  const messageId = crypto.randomUUID();
  setActiveMessageId(
    sessionId,
    messageId,
    personaId
      ? {
          personaId,
          ...(personaName ? { personaName } : {}),
        }
      : undefined,
  );

  perfLog(
    `[perf:send] ${sid} acpSendMessage → prompt(len=${prompt.length}, imgs=${images?.length ?? 0})`,
  );
  const tPrompt = performance.now();
  const meta: Record<string, unknown> = { ...promptMeta };
  if (personaId) meta.personaId = personaId;
  try {
    const promptPromise = directAcp.prompt(
      sessionId,
      content,
      Object.keys(meta).length > 0 ? meta : undefined,
      {
        onPromptDispatching: () => {
          onPromptDispatching?.();
          personaHandoffClaim?.markDelivered();
        },
        onPromptDispatched,
      },
    );
    const promptResponse = await promptPromise;
    try {
      const usage = promptResponse?.usage;
      if (usage) {
        const cacheTokens =
          (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0);
        recordSessionTokens(
          sessionId,
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheTokens,
            totalTokens: usage.totalTokens,
            turnsDelta: 1,
          },
          { providerId },
        );
      }
    } catch {
      // Usage tracking must never fail a prompt.
    }
    const tDone = performance.now();
    perfLog(
      `[perf:send] ${sid} prompt() resolved in ${(tDone - tPrompt).toFixed(1)}ms (total acpSendMessage ${(tDone - tStart).toFixed(1)}ms)`,
    );
  } finally {
    clearActiveMessageId(sessionId);
  }
}

/** Add context to the active ACP run without cancelling or starting a new turn. */
export async function acpSteerMessage(
  sessionId: string,
  expectedRunId: string | null,
  prompt: string,
  options: Pick<
    AcpSendMessageOptions,
    "assistantPrompt" | "promptMeta" | "images"
  > = {},
): Promise<AcpSteerResponse> {
  sessionRegistry.requireSessionInvocationSelection(sessionId);
  const { assistantPrompt, promptMeta, images } = options;
  const content: ContentBlock[] = [];
  const assistantText = assistantPrompt?.trim();
  if (assistantText) {
    content.push({
      type: "text",
      text: assistantText,
      annotations: { audience: ["assistant"] },
    });
  }
  content.push({ type: "text", text: prompt });
  if (images) {
    for (const [data, mimeType] of images) {
      content.push({ type: "image", data, mimeType } as ContentBlock);
    }
  }

  return directAcp.steerSession(
    sessionId,
    content,
    expectedRunId,
    promptMeta && Object.keys(promptMeta).length > 0 ? promptMeta : undefined,
  );
}

/** Prepare or warm an ACP session ahead of the first prompt. */
export async function acpPrepareSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
  options: AcpSessionConfigApplyOptions = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  const sid = sessionId.slice(0, 8);
  const t0 = performance.now();
  perfLog(
    `[perf:prepare] ${sid} acpPrepareSession start (provider=${providerId})`,
  );
  const modelId = normalizeConcreteModelId(options.modelId);
  const snapshots = modelId
    ? await sessionRegistry.configureSession(
        sessionId,
        providerId,
        workingDir,
        modelId,
        options,
      )
    : await sessionRegistry.prepareSession(
        sessionId,
        providerId,
        workingDir,
        options,
      );
  perfLog(
    `[perf:prepare] ${sid} acpPrepareSession done in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return snapshots;
}

export async function acpCreateSession(
  providerId: string,
  workingDir: string,
  options: AcpCreateSessionOptions = {},
): Promise<AcpCreateSessionResult> {
  const modelId = normalizeConcreteModelId(options.modelId);
  const reasoningEffort = options.reasoningEffort?.trim();
  // The selection rides in `session/new` itself, so the bridge is on the
  // chosen model, effort and fast mode before any turn can start. The model
  // apply below stays as the check that the host really acknowledged the model:
  // it is skipped when it did, and it is the old follow-up write when it did not.
  const response = await directAcp.newSession(workingDir, {
    providerId,
    projectId: options.projectId,
    personaId: options.personaId,
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(options.fastMode !== undefined ? { fastMode: options.fastMode } : {}),
  });
  const sessionId = response.sessionId;
  let configOptionsSnapshot = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("acpCreateSession newSession response", {
    sessionId: shortLogId(sessionId),
    providerId,
    requestedModelId: modelId ?? null,
    hasReasoningEffortSnapshot: Boolean(configOptionsSnapshot.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      configOptionsSnapshot.reasoningEffort,
    ),
  });
  sessionRegistry.registerPreparedSession(
    sessionId,
    providerId,
    workingDir,
    configOptionsSnapshot.model?.modelId,
  );
  if (!modelId) {
    return { sessionId, configOptionsSnapshot };
  }
  // The host already asked the bridge for the model in `session/new` and
  // recorded its refusal; asking again would only fail the same way, slowly.
  const refusedByHost = configOptionsSnapshot.substitutions?.find(
    (substitution) =>
      substitution.role === "model" &&
      substitution.requested !== null &&
      sameModelIdentity(substitution.requested, modelId) &&
      !sameModelIdentity(substitution.applied, modelId),
  );
  if (refusedByHost) {
    logRejectedCreationModel(
      sessionId,
      providerId,
      modelId,
      refusedByHost.reason,
    );
    return {
      sessionId,
      configOptionsSnapshot,
      rejectedModel: {
        modelId,
        ...(refusedByHost.reason ? { reason: refusedByHost.reason } : {}),
      },
    };
  }
  try {
    configOptionsSnapshot =
      (await sessionRegistry.applySessionModel(sessionId, modelId)) ??
      configOptionsSnapshot;
    return { sessionId, configOptionsSnapshot };
  } catch (error) {
    // The session is open on the harness's own model, which by definition
    // runs; only the model that was to ride along was refused. Keeping the
    // chat and saying so beats archiving it and failing the creation, which
    // left the operator with a draft nothing could be done with.
    const reason = formatAcpErrorMessage(error, "");
    logRejectedCreationModel(sessionId, providerId, modelId, reason);
    return {
      sessionId,
      configOptionsSnapshot,
      rejectedModel: { modelId, ...(reason ? { reason } : {}) },
    };
  }
}

function logRejectedCreationModel(
  sessionId: string,
  providerId: string,
  modelId: string,
  reason: string | undefined,
): void {
  logReasoningEffortInfo("acpCreateSession model rejected", {
    sessionId: shortLogId(sessionId),
    providerId,
    modelId,
    reason: reason ?? null,
  });
}

export async function acpSetSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string | boolean,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots> {
  return sessionRegistry.applySessionConfigOption(
    sessionId,
    configId,
    value,
    context,
  );
}

/**
 * Apply reasoning effort and fast mode as one ordered pair, in the same
 * per-session mutation queue the model apply uses. Only `runSettingsReconciler`
 * should call this: it is the one place that knows what the current model
 * advertises, and a value a model does not offer must never reach the wire.
 */
export async function acpApplySessionRunSettings(
  sessionId: string,
  write: AcpSessionRunSettingsWrite,
  context: Omit<AcpSessionConfigSnapshotContext, "origin"> = {},
): Promise<AcpSessionConfigSnapshots | undefined> {
  return sessionRegistry.applySessionRunSettings(sessionId, write, context);
}

export type { AcpSessionInfo, AcpSessionsPage, AcpSessionRunSettingsWrite };

export async function acpGetSessionInfo(
  sessionId: string,
): Promise<AcpSessionInfo> {
  return directAcp.getSessionInfo(sessionId);
}

export interface AcpSessionSearchResult {
  sessionId: string;
  snippet: string;
  messageId: string;
  messageRole?: "user" | "assistant" | "system";
  matchCount: number;
}

/**
 * A sweep's matches plus which of its targets were actually read. Callers need
 * the coverage split to avoid reporting an unreadable session as a searched one.
 */
export interface AcpSessionSearchSweep {
  results: AcpSessionSearchResult[];
  searchedIds: string[];
  failedIds: string[];
}

/** List one page of sessions known to the host. */
export async function acpListSessionsPage({
  cursor,
}: {
  cursor?: string | null;
} = {}): Promise<AcpSessionsPage> {
  return directAcp.listSessionsPage({ cursor });
}

export async function acpSearchSessions(
  query: string,
  targets: SessionSearchTarget[],
  options: SessionSearchOptions = {},
): Promise<AcpSessionSearchSweep> {
  return searchSessionsViaTranscripts(query, targets, options);
}

/**
 * Load an existing session from the host.
 *
 * This triggers message replay via SessionNotification events that the
 * notification handler picks up automatically.
 */
export async function acpLoadSession(
  sessionId: string,
  workingDir?: string,
): Promise<AcpSessionExecutionSelection | undefined> {
  const effectiveWorkingDir = workingDir ?? "~";
  const sid = sessionId.slice(0, 8);
  const t0 = performance.now();
  logReasoningEffortInfo("acpLoadSession start", {
    sessionId: shortLogId(sessionId),
  });
  perfLog(`[perf:load] ${sid} acpLoadSession → client.loadSession`);
  const { response, isCurrent, executionSelection } =
    await sessionRegistry.loadSession(sessionId, effectiveWorkingDir);
  if (!isCurrent) {
    perfLog(
      `[perf:load] ${sid} dropped superseded load snapshot in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    return undefined;
  }
  const snapshots = readSessionConfigOptionsSnapshots(response);
  logReasoningEffortInfo("acpLoadSession response", {
    sessionId: shortLogId(sessionId),
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
  });
  applySessionConfigOptionsSnapshot(sessionId, response, {
    origin: "response",
  });
  perfLog(
    `[perf:load] ${sid} client.loadSession resolved in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return executionSelection;
}

/** The session transcript as pretty-printed JSON, for export to a file. */
export async function acpExportSession(sessionId: string): Promise<string> {
  const transcript = await directAcp.readSessionTranscript(sessionId);
  return JSON.stringify({ sessionId, ...transcript }, null, 2);
}

/** Duplicate a session via ACP's fork method. Returns new session metadata. */
export async function acpDuplicateSession(
  sessionId: string,
  workingDir: string,
  duplicateTitle?: string,
  options?: AcpDuplicateSessionOptions,
): Promise<AcpSessionInfo> {
  const session = await directAcp.forkSession(sessionId, workingDir, options);
  const normalizedTitle = duplicateTitle?.trim();
  if (!normalizedTitle) {
    return session;
  }

  try {
    await directAcp.renameSession(session.sessionId, normalizedTitle);
    // forkSession returns a pre-rename snapshot (title: null); reflect the
    // applied title so callers can render the fork without waiting for a
    // session-list refresh.
    return { ...session, title: normalizedTitle };
  } catch (error) {
    console.error("Failed to rename duplicated session:", error);
  }

  return session;
}

/** Cancel an in-progress ACP session so the backend stops streaming. */
export async function acpCancelSession(sessionId: string): Promise<boolean> {
  await directAcp.cancelSession(sessionId);
  return true;
}
