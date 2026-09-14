import type { ReactNode, RefObject } from "react";
import type { AcpProvider } from "@/shared/api/acp";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { Persona } from "@/shared/types/agents";
import type {
  ChatAttachmentDraft,
  MessageChip,
  MessageMetadata,
} from "@/shared/types/messages";
import type {
  ChatSessionFastModeConfig,
  ChatSessionReasoningEffortConfig,
  ChatSessionReasoningEffortOption,
} from "./stores/chatSessionStore";
import type { QueuedMessagePayload } from "./stores/chatStore";
import type { SessionExecutionTarget } from "./lib/sessionExecutionTarget";

/** Which page of the model picker a row belongs on. Presentation only. */
export type ModelPickerGroup = "main" | "more";

/**
 * How a model's capabilities were learned: by selecting it on the bridge
 * ("probed"), from what Distill declares for a model the bridge refuses to
 * select ("declared"), or not at all ("unknown").
 */
export type ModelCapabilitySource = "probed" | "declared" | "unknown";

export interface ModelOption {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  providerId?: string;
  providerName?: string;
  contextLimit?: number | null;
  /** Whether this model should appear in the compact recommended picker. */
  recommended?: boolean;
  /** Whether this model should show the primary recommendation marker. */
  featured?: boolean;
  /** Suggested display order for model picker rows. */
  sortOrder?: number;
  /** The picker page the harness filed this row under. */
  group?: ModelPickerGroup;
  /** The harness's own menu position; `sortOrder` falls back to it. */
  order?: number;
  /**
   * The model this row is another name for. An alias is hidden while its twin
   * is listed and survives when it is the selection.
   */
  aliasOf?: string | null;
  /**
   * The effort values this model offers, in the harness's own vocabulary and
   * in the same shape a live session advertises them.
   *
   * Read with `capabilitySource`: an empty list on a probed or declared row
   * means the model has NO effort control, while no list at all means nobody
   * has asked. Both show no menu before a session exists; only the first is an
   * answer.
   */
  efforts?: ChatSessionReasoningEffortOption[];
  /** The effort the harness itself calls this model's default, if it says. */
  defaultEffort?: string | null;
  /** `null` (or absent) is "unknown", never "no". */
  supportsFast?: boolean | null;
  /**
   * The harness runs this model only in a session opened on it, so switching
   * to it reopens the bridge session and cannot happen mid-turn.
   */
  opensOnModel?: boolean;
  /** Where `efforts` and `supportsFast` came from. */
  capabilitySource?: ModelCapabilitySource;
}

export interface ProjectOption {
  id: string;
  name: string;
  workingDirs: string[];
  icon?: string | null;
  color?: string | null;
}

export interface ChatSkillDraft {
  id: string;
  name: string;
  description?: string;
  sourceLabel?: string;
  instructions?: string;
  fileLocation?: string;
}

export interface ChatSendOptions {
  /** Internal target snapshot owned by the active queued dispatch attempt. */
  sessionSelection?: SessionExecutionTarget;
  /** Coordinator token proving ownership of sessionSelection. */
  sessionSelectionToken?: symbol;
  systemPrompt?: string;
  /** Internal queue ownership check at the transcript commit boundary. */
  beforeUserMessageCommitted?: () => void;
  /** Internal notification that this attempt has committed its user turn. */
  onUserMessageCommitted?: () => void;
  /** Fully composed execution prompt captured for a queued send. */
  executionSystemPrompt?: string;
  /** Persona-only prompt captured while workspace context is still loading. */
  capturedPersonaSystemPrompt?: string;
  displayText?: string;
  assistantPrompt?: string;
  chips?: MessageChip[];
  userMessageMetadata?: Partial<MessageMetadata>;
  acpPromptMetadata?: Record<string, unknown>;
}

export type ChatInputSendHandler = (
  text: string,
  personaId?: string | null,
  attachments?: ChatAttachmentDraft[],
  options?: ChatSendOptions,
) => boolean | Promise<boolean>;

export interface ChatInputComposerActions {
  onSend: ChatInputSendHandler;
  onSteerMessage?: ChatInputSendHandler;
  onStop?: () => void;
  onSteerQueuedMessage?: () => boolean | Promise<boolean>;
  canSteerMessage?: boolean;
  canSteerQueuedMessage?: boolean;
  isStreaming?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  queuedMessage?: QueuedMessagePayload | null;
  queuedMessages?: Array<{
    recordId: string;
    payload: QueuedMessagePayload;
  }>;
  onSendQueue?: () => boolean | Promise<boolean>;
  onDismissQueue?: (recordId?: string) => void;
  onUpdateQueue?: (recordId: string, payload: QueuedMessagePayload) => boolean;
  onEditQueue?: (recordId: string) => boolean;
  onCancelQueueEdit?: (recordId: string) => boolean;
}

export interface ChatInputPersonaPicker {
  personas?: Persona[];
  selectedPersonaId?: string | null;
  onPersonaChange?: (personaId: string | null) => void;
}

export type AgentPickerSetupAction = "install" | "connect";

export interface AgentPickerOption extends AcpProvider {
  readiness?: AgentProviderReadiness;
  setupAction?: AgentPickerSetupAction;
}

export interface ChatInputAgentModelPicker {
  providers?: AgentPickerOption[];
  providersLoading?: boolean;
  selectedProvider?: string;
  onProviderChange?: (providerId: string) => void;
  currentModelId?: string | null;
  currentModelProviderId?: string | null;
  currentModel?: string;
  currentExecutionTarget?: SessionExecutionTarget;
  availableModels?: ModelOption[];
  modelsLoading?: boolean;
  modelStatusMessage?: string | null;
  onModelChange?: (modelId: string, model?: ModelOption) => void;
  onPickerOpen?: () => void;
  /**
   * "gated" hides the agent column behind a "Switch agent" button, for
   * surfaces where changing agent can recreate an existing session.
   */
  providerColumnMode?: "visible" | "gated";
}

export interface ChatInputProjectPicker {
  enabled?: boolean;
  selectedProjectId?: string | null;
  availableProjects?: ProjectOption[];
  onProjectChange?: (projectId: string | null) => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
}

export interface ChatInputReasoningEffort {
  config?: ChatSessionReasoningEffortConfig;
  onChange?: (value: string) => void;
  /** Ultracode arm state for Claude Code sessions (synthetic top stop). */
  ultracode?: {
    armed: boolean;
    setArmed: (armed: boolean) => void;
  };
}

export interface ChatInputFastMode {
  config?: ChatSessionFastModeConfig;
  onChange?: (enabled: boolean) => void;
}

export interface ChatInputContextUsage {
  contextTokens?: number;
  contextLimit?: number;
  isContextUsageReady?: boolean;
  // Estimated session cost in USD from the engine; null when unavailable.
  accumulatedCost?: number | null;
  onCompactContext?: () => Promise<unknown> | undefined;
  canCompactContext?: boolean;
  isCompactingContext?: boolean;
  supportsCompactionControls?: boolean;
}

export interface ChatInputControls {
  agentModelPicker?: boolean;
  attachments?: boolean;
  autoFocus?: boolean;
  fileMentions?: boolean;
  projectPicker?: boolean;
  skills?: boolean;
}

export interface ChatInputProps {
  composerActions: ChatInputComposerActions;
  initialValue?: string;
  initialAttachments?: ChatAttachmentDraft[];
  placeholder?: string;
  onDraftChange?: (text: string) => void;
  /** Mirrors the live composer attachments so a remounted chat can restore them. */
  onDraftAttachmentsChange?: (attachments: ChatAttachmentDraft[]) => void;
  selectedSkills?: ChatSkillDraft[];
  onSkillsChange?: (skills: ChatSkillDraft[]) => void;
  skillProjectDirs?: string[];
  fileMentionProjectDirs?: string[];
  skillProviderId?: string | null;
  attachmentsEnabled?: boolean;
  className?: string;
  /** Renders after the queued-message pill and before the composer controls. */
  queuedMessageAccessory?: ReactNode;
  personaPicker?: ChatInputPersonaPicker;
  agentModelPicker?: ChatInputAgentModelPicker;
  reasoningEffort?: ChatInputReasoningEffort;
  fastMode?: ChatInputFastMode;
  projectPicker?: ChatInputProjectPicker;
  contextUsage?: ChatInputContextUsage;
  controls?: ChatInputControls;
  /** Called when ↑ should recall the last sent user message. */
  onRecallLastUserMessage?: () => string | null;
  /** Optional larger surface that should accept attachment drops for this composer. */
  attachmentDropTargetRef?: RefObject<HTMLDivElement | null>;
  /** Mirrors attachment drag-over state when the drop target is rendered outside the composer. */
  onAttachmentDragOverChange?: (isDragOver: boolean) => void;
  /** Applies the docked chat surface to the inner shell, leaving queue chrome outside. */
  innerBareSurface?: boolean;
  /**
   * Visual surface for the composer.
   * - "pill" (default): translucent glass pill — used by the Home composer.
   * - "bare": no background of its own, so a parent panel provides the surface.
   *   The chat composer uses this to render a translucent glass floating island
   *   (the wrapper supplies --surface-composer + backdrop blur).
   */
  surface?: "pill" | "bare";
}
