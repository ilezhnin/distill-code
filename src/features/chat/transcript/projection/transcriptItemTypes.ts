import type {
  Message,
  MessageContent,
  ToolCallLocation,
  ToolKind,
} from "@/shared/types/messages";
import type {
  TranscriptKeepAlivePriority as MeasurementKeepAlivePriority,
  TranscriptLayoutPendingPolicy as MeasurementLayoutPendingPolicy,
  TranscriptMeasurementPolicy as MeasurementPolicy,
  TranscriptMeasurementSafetyReason as MeasurementSafetyReason,
  TranscriptRowKind as MeasurementRowKind,
  TranscriptRowSafetyCapabilities,
} from "../measurement";

export type TranscriptMeasurementPolicy = MeasurementPolicy;

export type TranscriptLayoutPendingPolicy = MeasurementLayoutPendingPolicy;

export type TranscriptAnchorPriority = "stable" | "streaming" | "none";

export type TranscriptKeepAlivePriority = MeasurementKeepAlivePriority;

export type TranscriptMeasurementSafetyReason = MeasurementSafetyReason;

type RequiredProjectionCapabilityKey =
  | "stateful"
  | "hasMcpApp"
  | "hasHostCalls"
  | "hasActiveTimer"
  | "hasDynamicAsyncLayout"
  | "canOffscreenRenderReal"
  | "canOffscreenRenderShell"
  | "protectsSelection";

export type TranscriptRowCapabilities = Pick<
  TranscriptRowSafetyCapabilities,
  RequiredProjectionCapabilityKey
> &
  Partial<
    Omit<TranscriptRowSafetyCapabilities, RequiredProjectionCapabilityKey>
  >;

export type TranscriptRowKind = MeasurementRowKind;

export type TranscriptDateLabelKey = "today" | "yesterday" | "date";

export interface TranscriptDateSeparatorPayload {
  dateBucket: string;
  timestamp: number;
  labelKey: TranscriptDateLabelKey;
  label: string;
  firstMessageId: string;
}

/**
 * Prior tool-call context a row needs to resolve a Goose `load <task-id>` back
 * to the `delegate` that announced the id, when the two live in different
 * assistant messages.
 *
 * It carries only the delegate requests and their responses, and the projection
 * hands every row that needs it the *same* frozen array, so putting it on a
 * payload costs one reference rather than a copy of the transcript.
 */
export type TranscriptSubagentLinkage = ReadonlyArray<{
  content: readonly MessageContent[];
}>;

export interface TranscriptAgentWorkPayload {
  workId: string;
  message: Message;
  content: readonly MessageContent[];
  isActiveWork: boolean;
  /** Whether a final answer row follows this work panel in the transcript. */
  hasFinalAnswer: boolean;
  /**
   * Whether this work row hosts the turn's persistent footers (harness brigade
   * chips). True only on the last work group of a turn that produced no answer
   * row — otherwise the answer bubble hosts them, and no turn hosts them twice.
   */
  hostsTurnFooters: boolean;
  subagentLinkage?: TranscriptSubagentLinkage;
  thoughtCount: number;
  toolCount: number;
  textCount: number;
}

export interface TranscriptRowDescriptor {
  rowId: string;
  reactKey: string;
  kind: TranscriptRowKind;
  messageId?: string;
  responseStartMessageId?: string;
  blockIds?: readonly string[];
  /** Visible blocks for a synthetic message row. */
  messageContent?: readonly MessageContent[];
  /** Related blocks needed to render the visible content without displaying them. */
  messageContentContext?: readonly MessageContent[];
  /** Earlier delegate tool calls this row's brigade chips may need to resolve. */
  subagentLinkage?: TranscriptSubagentLinkage;
  fragment?: TranscriptAssistantContentFragmentPayload;
  date?: TranscriptDateSeparatorPayload;
  agentWork?: TranscriptAgentWorkPayload;
  renderRevision: string;
  heightRevision: string;
  layoutRevision: string;
  estimatedHeight: number;
  spacingBefore: number;
  anchorPriority: TranscriptAnchorPriority;
  measurementPolicy: TranscriptMeasurementPolicy;
  layoutPendingPolicy: TranscriptLayoutPendingPolicy;
  capabilities: TranscriptRowCapabilities;
  measurementSafetyReasons?: readonly TranscriptMeasurementSafetyReason[];
  keepAlivePriority: TranscriptKeepAlivePriority;
}

export interface TranscriptDateSeparatorItem {
  itemId: string;
  kind: "date-separator";
  rowId: string;
  payload: TranscriptDateSeparatorPayload;
  renderRevision: string;
  heightRevision: string;
  estimatedHeight: number;
}

export interface TranscriptMessageItem {
  itemId: string;
  kind: "message";
  rowId: string;
  messageId: string;
  responseStartMessageId?: string;
  message: Message;
  visibleContent: readonly MessageContent[];
  blockIds: readonly string[];
  searchableText: string;
  isStreaming: boolean;
  subagentLinkage?: TranscriptSubagentLinkage;
  renderRevision: string;
  heightRevision: string;
  estimatedHeight: number;
  capabilities: TranscriptRowCapabilities;
  measurementPolicy: TranscriptMeasurementPolicy;
  layoutPendingPolicy: TranscriptLayoutPendingPolicy;
  measurementSafetyReasons: readonly TranscriptMeasurementSafetyReason[];
  anchorPriority: TranscriptAnchorPriority;
  keepAlivePriority: TranscriptKeepAlivePriority;
}

export type TranscriptAssistantContentFragmentRole =
  | "single"
  | "start"
  | "middle"
  | "end";

export interface TranscriptAssistantContentFragmentPayload {
  fragmentId: string;
  fragmentIndex: number;
  fragmentCount: number;
  role: TranscriptAssistantContentFragmentRole;
  content: readonly MessageContent[];
  isStreamingTail: boolean;
  messageScrollTarget: boolean;
  isCodeContinuationChunk: boolean;
  startsWithHeading: boolean;
}

export interface TranscriptAssistantContentFragmentItem {
  itemId: string;
  kind: "assistant-content-fragment";
  rowId: string;
  messageId: string;
  message: Message;
  visibleContent: readonly MessageContent[];
  blockIds: readonly string[];
  searchableText: string;
  fragment: TranscriptAssistantContentFragmentPayload;
  renderRevision: string;
  heightRevision: string;
  estimatedHeight: number;
  capabilities: TranscriptRowCapabilities;
  measurementPolicy: TranscriptMeasurementPolicy;
  layoutPendingPolicy: TranscriptLayoutPendingPolicy;
  measurementSafetyReasons: readonly TranscriptMeasurementSafetyReason[];
  anchorPriority: TranscriptAnchorPriority;
  keepAlivePriority: TranscriptKeepAlivePriority;
}

export interface TranscriptAgentWorkItem {
  itemId: string;
  kind: "agent-work";
  rowId: string;
  messageId: string;
  message: Message;
  workId: string;
  content: readonly MessageContent[];
  isActiveWork: boolean;
  hasFinalAnswer: boolean;
  hostsTurnFooters: boolean;
  subagentLinkage?: TranscriptSubagentLinkage;
  thoughtCount: number;
  toolCount: number;
  textCount: number;
  renderRevision: string;
  heightRevision: string;
  estimatedHeight: number;
  capabilities: TranscriptRowCapabilities;
  measurementPolicy: TranscriptMeasurementPolicy;
  layoutPendingPolicy: TranscriptLayoutPendingPolicy;
  measurementSafetyReasons: readonly TranscriptMeasurementSafetyReason[];
  anchorPriority: TranscriptAnchorPriority;
  keepAlivePriority: TranscriptKeepAlivePriority;
}

export type TranscriptItemDescriptor =
  | TranscriptDateSeparatorItem
  | TranscriptMessageItem
  | TranscriptAssistantContentFragmentItem
  | TranscriptAgentWorkItem;

export interface TranscriptArtifactDescriptor {
  artifactKey: string;
  sessionId: string;
  rowId: string;
  messageId: string;
  blockId: string;
  toolRequestId: string;
  toolName: string;
  toolKind?: ToolKind;
  location: ToolCallLocation & { path: string };
  locationRevision: string;
  path: string;
  line?: number | null;
  messageCreated: number;
}

export interface TranscriptArtifactIndex {
  artifacts: readonly TranscriptArtifactDescriptor[];
  artifactByKey: ReadonlyMap<string, TranscriptArtifactDescriptor>;
  artifactKeysByMessageId: ReadonlyMap<string, readonly string[]>;
  artifactKeysByToolRequestId: ReadonlyMap<string, readonly string[]>;
  artifactKeysByRowId: ReadonlyMap<string, readonly string[]>;
  changedArtifactKeys: ReadonlySet<string>;
}

export interface TranscriptProjectionSnapshot {
  sessionId: string;
  sessionEpoch: number;
  items: readonly TranscriptItemDescriptor[];
  rows: readonly TranscriptRowDescriptor[];
  rowByMessageId: ReadonlyMap<string, string>;
  rowIndexById: ReadonlyMap<string, number>;
  messageById: ReadonlyMap<string, Message>;
  searchableTextByMessageId: ReadonlyMap<string, string>;
  artifactIndex: TranscriptArtifactIndex;
  changedRowIds: ReadonlySet<string>;
  descriptorChurn: number;
  fragmentRowCount: number;
  completedFragmentRowCount: number;
  completedStreamingFragmentRowCount: number;
  streamingTailRowCount: number;
  wholeMessageFallbackRowCount: number;
  reusedPrefixCount: number;
  reusedSuffixCount: number;
  projectionDurationMs: number;
}

export interface TranscriptProjectionCacheUpdateInput {
  sessionId: string;
  sessionEpoch: number;
  messages: readonly Message[];
  streamingMessageId: string | null;
  nowBucket: string;
  localeKey: string;
  previous?: TranscriptProjectionSnapshot;
}

export interface TranscriptProjectionCache {
  update(
    input: TranscriptProjectionCacheUpdateInput,
  ): TranscriptProjectionSnapshot;
  promoteSession(oldSessionId: string, newSessionId: string): void;
  cleanupSession(sessionId: string): void;
  cancelPendingWork(sessionId: string, sessionEpoch: number): void;
  invalidateCalendarLabels(nowBucket: string, localeKey: string): void;
}

export function getTranscriptRowEstimatedHeight(
  row: Pick<TranscriptRowDescriptor, "estimatedHeight" | "spacingBefore">,
): number {
  return Math.max(0, row.estimatedHeight) + Math.max(0, row.spacingBefore);
}
