import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  IconBulb,
  IconChevronRight,
  IconCircle,
  IconClock,
  IconListSearch,
  IconMessageCircle,
  IconTool,
} from "@tabler/icons-react";
import { Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type LookupKind,
  thoughtHeadline,
  toolLookupKind,
} from "@/features/chat/lib/agentWorkActivity";
import { viewableArtifacts } from "@/features/chat/lib/artifactViewerTypes";
import { selectHarnessBrigade } from "@/features/chat/lib/harnessBrigade";
import {
  onHarnessSubagentReveal,
  TOOL_CALL_ID_ATTRIBUTE,
} from "@/features/chat/lib/harnessBrigadeFocus";
import { ArtifactChips } from "./ArtifactChips";
import { HarnessBrigadeRow } from "./HarnessBrigadeRow";
import { cn } from "@/shared/lib/cn";
import {
  MessageAction,
  MessageResponse,
} from "@/shared/ui/ai-elements/message";
import type { MessagePart } from "@/shared/types/messageParts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Button } from "@/shared/ui/button";
import type {
  MessageContent,
  TextContent,
  ThinkingContent,
  ReasoningContent,
  ToolRequestContent,
  ToolResponseContent,
  ToolCallStatus,
} from "@/shared/types/messages";
import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import { useTranscriptRowStateAdapter } from "@/features/chat/transcript/row-state";
import { ToolCallAdapter } from "./ToolCallAdapter";
import { VoiceSpeechStatusIndicator } from "./VoiceSpeechStatusIndicator";

interface ToolTimelineItem {
  kind: "tool";
  key: string;
  request?: ToolRequestContent;
  response?: ToolResponseContent;
  /** The step this item is, as an edit or a removal names it to the host. */
  part?: MessagePart;
}

interface ThoughtTimelineItem {
  kind: "thought";
  key: string;
  content: ThinkingContent | ReasoningContent;
  part?: MessagePart;
}

interface RedactedThoughtTimelineItem {
  kind: "redactedThought";
  key: string;
  part?: MessagePart;
}

interface ProgressTimelineItem {
  kind: "progress";
  key: string;
  content: TextContent;
  part?: MessagePart;
}

/**
 * Consecutive lookups folded into one line, with the reasoning between them.
 *
 * Reading files, searching and listing folders is how an agent finds its
 * way, and a person reads a run of them as one thing it did: "Explored · 3
 * files read, 2 searches". The thoughts between the lookups stay inside the
 * group, so they do not cut it into single steps; text the agent addressed
 * to the operator, or a step that does something, ends it.
 */
interface ExplorationTimelineItem {
  kind: "exploration";
  key: string;
  steps: (
    | ToolTimelineItem
    | ThoughtTimelineItem
    | RedactedThoughtTimelineItem
  )[];
  counts: Record<LookupKind, number>;
}

interface ActivePreviewState {
  visibleItems: AgentWorkTimelineItem[];
  hiddenItems: AgentWorkTimelineItem[];
  hiddenStepCount: number;
}

type AgentWorkTimelineItem =
  | ToolTimelineItem
  | ThoughtTimelineItem
  | RedactedThoughtTimelineItem
  | ProgressTimelineItem
  | ExplorationTimelineItem;

/** Fewer lookups than this stay on their own lines: a group of one says less. */
const MIN_EXPLORATION_LOOKUPS = 2;

const AGENT_THOUGHT_MARKDOWN_CLASSNAME =
  "[&_*]:font-normal [&_strong]:font-normal [&_b]:font-normal [&_h1]:font-normal [&_h2]:font-normal [&_h3]:font-normal [&_h4]:font-normal [&_h5]:font-normal [&_h6]:font-normal [&_strong]:text-foreground/75 [&_b]:text-foreground/75 [&_h1]:text-foreground/75 [&_h2]:text-foreground/75 [&_h3]:text-foreground/75 [&_h4]:text-foreground/75 [&_h5]:text-foreground/75 [&_h6]:text-foreground/75 [&_h1]:mb-0 [&_h2]:mb-0 [&_h3]:mb-0 [&_h4]:mb-0 [&_h5]:mb-0 [&_h6]:mb-0 [&_h1+p]:mt-0 [&_h2+p]:mt-0 [&_h3+p]:mt-0 [&_h4+p]:mt-0 [&_h5+p]:mt-0 [&_h6+p]:mt-0 [&_p:has(>strong:only-child)]:mb-0 [&_p:has(>b:only-child)]:mb-0 [&_p:has(>strong:only-child)+p]:mt-0 [&_p:has(>b:only-child)+p]:mt-0";
const COMPACT_ACTIVE_PREVIEW_ITEM_COUNT = 3;

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function getToolStatus(item: ToolTimelineItem): ToolCallStatus {
  if (item.response) {
    return item.response.isError ? "failed" : "completed";
  }
  return item.request?.status ?? "completed";
}

function getToolName(item: ToolTimelineItem): string {
  return item.request?.name || item.response?.name || "Tool result";
}

function pairToolResponse(
  items: AgentWorkTimelineItem[],
  response: ToolResponseContent,
): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "tool" || !item.request || item.response) {
      continue;
    }
    if (item.request.id === response.id) {
      items[index] = {
        ...item,
        response: {
          ...response,
          name: response.name || item.request.name,
        },
      };
      return true;
    }
  }
  return false;
}

function buildAgentWorkTimeline(
  content: readonly MessageContent[],
  parts: readonly (MessagePart | undefined)[] = [],
): AgentWorkTimelineItem[] {
  const items: AgentWorkTimelineItem[] = [];
  let previousThoughtText: string | null = null;

  for (const [index, block] of content.entries()) {
    if (block.type === "thinking" || block.type === "reasoning") {
      const normalized = normalizeText(block.text);
      if (normalized && normalized === previousThoughtText) {
        continue;
      }
      previousThoughtText = normalized;
      items.push({
        kind: "thought",
        key: `${block.type}-${index}-${normalized.slice(0, 32)}`,
        content: block,
        part: parts[index],
      });
      continue;
    }

    previousThoughtText = null;

    if (block.type === "redactedThinking") {
      items.push({
        kind: "redactedThought",
        key: `redacted-thinking-${index}`,
        part: parts[index],
      });
      continue;
    }

    if (block.type === "text") {
      const previous = items[items.length - 1];
      if (
        previous?.kind === "progress" &&
        previous.content.speech?.status === block.speech?.status
      ) {
        previous.content = {
          ...previous.content,
          text: previous.content.text + block.text,
        };
      } else if (block.text.trim()) {
        items.push({
          kind: "progress",
          key: `progress-${index}`,
          content: block,
          part: parts[index],
        });
      }
      continue;
    }

    if (block.type === "toolRequest") {
      items.push({
        kind: "tool",
        key: `tool-${block.id}-${index}`,
        request: block,
        part: parts[index],
      });
      continue;
    }

    if (block.type === "toolResponse") {
      if (!pairToolResponse(items, block)) {
        items.push({
          kind: "tool",
          key: `tool-response-${block.id}-${index}`,
          response: block,
          part: parts[index],
        });
      }
    }
  }

  return items;
}

function isActiveToolStatus(status: ToolCallStatus): boolean {
  return status === "pending" || status === "in_progress";
}

/** Folds runs of lookups (and the thoughts between them) into one item. */
function groupLookups(
  items: readonly AgentWorkTimelineItem[],
): AgentWorkTimelineItem[] {
  const rows: AgentWorkTimelineItem[] = [];
  const open: { group: ExplorationTimelineItem | null } = { group: null };
  let between: (ThoughtTimelineItem | RedactedThoughtTimelineItem)[] = [];

  const close = () => {
    const group = open.group;
    if (group) {
      const lookups = group.steps.filter((step) => step.kind === "tool");
      if (lookups.length >= MIN_EXPLORATION_LOOKUPS) rows.push(group);
      else rows.push(...group.steps);
    }
    rows.push(...between);
    open.group = null;
    between = [];
  };

  for (const item of items) {
    const lookup = item.kind === "tool" ? toolLookupKind(item.request) : null;
    if (item.kind === "tool" && lookup) {
      if (open.group) {
        open.group.steps.push(...between);
        between = [];
      } else {
        open.group = {
          kind: "exploration",
          key: `exploration-${item.key}`,
          steps: [],
          counts: { read: 0, search: 0, list: 0 },
        };
      }
      open.group.steps.push(item);
      open.group.counts[lookup] += 1;
      continue;
    }
    if (
      open.group &&
      (item.kind === "thought" || item.kind === "redactedThought")
    ) {
      between.push(item);
      continue;
    }
    close();
    rows.push(item);
  }
  close();
  return rows;
}

function getActivePreviewState(
  items: readonly AgentWorkTimelineItem[],
): ActivePreviewState {
  // The active preview is a chronological window over the work stream: the
  // last N items in true order, with everything older behind "previous steps".
  const visibleItems = items.slice(-COMPACT_ACTIVE_PREVIEW_ITEM_COUNT);
  const hiddenItems = items.slice(0, items.length - visibleItems.length);
  return {
    visibleItems,
    hiddenItems,
    hiddenStepCount: hiddenItems.length,
  };
}

type RailStatus = "thought" | "progress" | "exploration" | ToolCallStatus;

function getRailColor(status: RailStatus, primary = false): string {
  if (status !== "progress") {
    return "text-muted-foreground";
  }
  if (primary) {
    return "text-foreground";
  }
  return "text-muted-foreground/80";
}

function WorkRail({
  isLast,
  status,
  active = false,
  primary = false,
}: {
  isLast: boolean;
  status: RailStatus;
  /** Pulses the bullet: the step is still running. */
  active?: boolean;
  primary?: boolean;
}) {
  const isActive = active || status === "pending" || status === "in_progress";
  const colorClassName = getRailColor(status, primary);
  // The bullet circle masks the rail spine behind it. It must match the
  // transcript surface (bg-card) — bg-background diverges from it in dark
  // mode and shows as a clipped dark disc (BOT-1599).
  return (
    <div
      aria-hidden
      className="relative flex w-5 shrink-0 justify-center self-stretch"
    >
      {!isLast ? (
        <div className="absolute top-5 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border" />
      ) : null}
      <div
        className={cn(
          "relative z-10 mt-0.5 flex size-5 items-center justify-center rounded-full bg-card ring-2 ring-card",
          colorClassName,
          isActive && "animate-pulse",
        )}
      >
        {status === "progress" ? (
          <IconMessageCircle className="size-3.5" />
        ) : status === "thought" ? (
          <IconBulb className="size-3.5" />
        ) : status === "exploration" ? (
          <IconListSearch className="size-3.5" />
        ) : status === "pending" || status === "in_progress" ? (
          <IconClock className="size-3.5" />
        ) : status === "completed" ? (
          <IconTool className="size-3.5" />
        ) : (
          <IconCircle className="size-2.5 fill-current" />
        )}
      </div>
    </div>
  );
}

/**
 * The pencil and the bin of one step, shown while the step is hovered or one
 * of them has focus. Absent on a step that cannot be edited or removed.
 */
function StepActions({
  onEdit,
  onRemove,
}: {
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation("chat");
  if (!onEdit && !onRemove) {
    return null;
  }
  return (
    <div
      data-slot="step-actions"
      className="ml-auto flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover/step:opacity-100 focus-within:opacity-100"
    >
      {onEdit ? (
        <MessageAction
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/80"
          label={t("agent_work.editStep")}
          tooltip={t("agent_work.editStep")}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </MessageAction>
      ) : null}
      {onRemove ? (
        <MessageAction
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground/80"
          label={t("agent_work.removeStep")}
          tooltip={t("agent_work.removeStep")}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </MessageAction>
      ) : null}
    </div>
  );
}

/**
 * A disclosure line in the work rail: a one-line label that opens onto the
 * detail under it. Shared by thoughts and explorations, so both read and
 * behave like the tool rows beside them.
 */
function DisclosureLine({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          flush
          size="sm"
          className="flex h-auto w-full min-w-0 justify-start px-0 py-0 text-left"
          rightIcon={
            <IconChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
          }
        >
          <span className="min-w-0 truncate text-sm font-normal">{label}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A thought as one line — its heading — that opens onto the full text.
 *
 * Reasoning is the agent talking to itself. The harnesses people work in
 * every day keep it out of the way (a "Thought" stub, a status heading) and
 * show it on request; a thought that is only its heading has nothing to open.
 */
function ThoughtBody({
  content,
  open,
  onOpenChange,
  usePrimaryText,
}: {
  content: ThinkingContent | ReasoningContent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  usePrimaryText: boolean;
}) {
  const { t } = useTranslation("chat");
  const headline = thoughtHeadline(content.text);
  const hasMore = normalizeText(content.text) !== headline;
  const markdown = (
    <MessageResponse
      mode="static"
      className={cn(
        AGENT_THOUGHT_MARKDOWN_CLASSNAME,
        usePrimaryText &&
          "[&_strong]:text-foreground [&_b]:text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_h4]:text-foreground [&_h5]:text-foreground [&_h6]:text-foreground",
      )}
    >
      {content.text}
    </MessageResponse>
  );
  if (!hasMore) {
    return <div className="text-sm leading-relaxed">{markdown}</div>;
  }
  return (
    <DisclosureLine
      label={headline || t("agent_work.thought.label")}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="pt-1 text-sm leading-relaxed">{markdown}</div>
    </DisclosureLine>
  );
}

function ToolStep({
  item,
  open,
  onOpenChange,
}: {
  item: ToolTimelineItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = getToolStatus(item);
  const toolCallId = item.request?.id ?? item.response?.id;
  return (
    // The tool-call id is the reveal seam: a harness brigade chip finds its
    // card by this attribute (see `harnessBrigadeFocus`).
    <div className="min-w-0" {...{ [TOOL_CALL_ID_ATTRIBUTE]: toolCallId }}>
      <ToolCallAdapter
        // Controlled so the expansion survives virtual eviction. `Tool`
        // defaults to closed when uncontrolled, and the durable set starts
        // empty, so the mount state is unchanged.
        open={open}
        onOpenChange={onOpenChange}
        name={getToolName(item)}
        toolName={item.request?.toolName}
        subagentAgentName={item.request?.subagentAgentName}
        subagentTaskLabel={item.request?.subagentTaskLabel}
        subagentTaskIsConfigured={item.request?.subagentTaskIsConfigured}
        arguments={item.request?.arguments ?? {}}
        status={status}
        locations={item.request?.locations}
        result={item.response?.result}
        structuredContent={item.response?.structuredContent}
        historyResult={item.response?.historyResult}
        isError={item.response?.isError}
        startedAt={item.request?.startedAt}
        showStatusBadge={false}
        fitWidth
        className="text-muted-foreground [&_button[data-clickable-file]]:text-muted-foreground [&_[data-tool-title-hoisted]]:text-muted-foreground [&_[data-tool-title-prefix]]:text-muted-foreground [&_code]:text-muted-foreground [&_dd]:text-muted-foreground [&_dt]:text-muted-foreground"
        titleClassName="font-normal text-muted-foreground"
        chevronClassName="text-muted-foreground"
        agentWorkLayout
      />
    </div>
  );
}

const LOOKUP_KINDS: readonly LookupKind[] = ["read", "search", "list"];

/**
 * A run of lookups as one line: "Exploring" while one of them runs, then
 * "Explored", with what was looked at counted. While it runs, the step in
 * flight shows under the line, so the operator sees what is being read now
 * without opening anything.
 */
function ExplorationBody({
  item,
  expandedKeys,
  onExpandedChange,
}: {
  item: ExplorationTimelineItem;
  expandedKeys: ReadonlySet<string>;
  onExpandedChange: (key: string, open: boolean) => void;
}) {
  const { t } = useTranslation("chat");
  const tools = item.steps.filter(
    (step): step is ToolTimelineItem => step.kind === "tool",
  );
  const running = tools.findLast((tool) =>
    isActiveToolStatus(getToolStatus(tool)),
  );
  const summary = LOOKUP_KINDS.filter((kind) => item.counts[kind] > 0)
    .map((kind) =>
      t(`agent_work.exploration.${kind}`, { count: item.counts[kind] }),
    )
    .join(", ");
  const verb = t(
    running ? "agent_work.exploration.active" : "agent_work.exploration.done",
  );
  const open = expandedKeys.has(item.key);
  return (
    <div className="min-w-0">
      <DisclosureLine
        label={summary ? `${verb} · ${summary}` : verb}
        open={open}
        onOpenChange={(next) => onExpandedChange(item.key, next)}
      >
        <div className="space-y-1 pt-1 pl-1">
          {item.steps.map((step) =>
            step.kind === "tool" ? (
              <ToolStep
                key={step.key}
                item={step}
                open={expandedKeys.has(step.key)}
                onOpenChange={(next) => onExpandedChange(step.key, next)}
              />
            ) : step.kind === "thought" ? (
              <div
                key={step.key}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                <ThoughtBody
                  content={step.content}
                  open={expandedKeys.has(step.key)}
                  onOpenChange={(next) => onExpandedChange(step.key, next)}
                  usePrimaryText={false}
                />
              </div>
            ) : (
              <div
                key={step.key}
                className="text-xs italic text-muted-foreground"
              >
                {t("agent_work.redactedThinking")}
              </div>
            ),
          )}
        </div>
      </DisclosureLine>
      {running && !open ? (
        <div className="pt-0.5 pl-1">
          <ToolStep
            item={running}
            open={false}
            onOpenChange={(next) => onExpandedChange(running.key, next)}
          />
        </div>
      ) : null}
    </div>
  );
}

function AgentWorkItemRow({
  item,
  isLast,
  usePrimaryText = false,
  expandedKeys,
  onExpandedChange,
  onEdit,
  onRemove,
}: {
  item: AgentWorkTimelineItem;
  isLast: boolean;
  usePrimaryText?: boolean;
  /** Durable expansion of the step's disclosures, keyed by step. */
  expandedKeys: ReadonlySet<string>;
  onExpandedChange: (key: string, open: boolean) => void;
  /** Move this step's text into the composer. */
  onEdit?: () => void;
  /** Take this step out of the reply. */
  onRemove?: () => void;
}) {
  const { t } = useTranslation("chat");
  if (item.kind === "thought") {
    return (
      <div className="group/step flex gap-2.5">
        <WorkRail isLast={isLast} status="thought" primary={usePrimaryText} />
        <div
          className={cn(
            "min-w-0 flex-1 pb-2",
            usePrimaryText ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <ThoughtBody
            content={item.content}
            open={expandedKeys.has(item.key)}
            onOpenChange={(next) => onExpandedChange(item.key, next)}
            usePrimaryText={usePrimaryText}
          />
        </div>
        <StepActions onEdit={onEdit} onRemove={onRemove} />
      </div>
    );
  }

  if (item.kind === "redactedThought") {
    return (
      <div className="group/step flex gap-2.5">
        <WorkRail isLast={isLast} status="thought" primary={usePrimaryText} />
        <div
          className={cn(
            "min-w-0 flex-1 pb-2 text-xs italic",
            usePrimaryText ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {t("agent_work.redactedThinking")}
        </div>
        <StepActions onRemove={onRemove} />
      </div>
    );
  }

  if (item.kind === "progress") {
    const speechStatus = item.content.speech?.status;
    const speechLabel = speechStatus
      ? {
          speaking: t("message.voiceSpeechSpeakingLabel"),
          spoken: t("message.voiceSpeechSpokenLabel"),
          interrupted: t("message.voiceSpeechInterruptedLabel"),
          notSpoken: t("message.voiceSpeechNotSpokenLabel"),
          failed: t("message.voiceSpeechFailedLabel"),
        }[speechStatus]
      : null;
    return (
      <div className="group/step flex gap-2.5">
        <WorkRail isLast={isLast} status="progress" primary={usePrimaryText} />
        <div
          data-voice-speech-status={speechStatus}
          className={cn(
            "min-w-0 flex-1 pb-2 text-sm leading-relaxed",
            usePrimaryText ? "text-foreground" : "text-muted-foreground",
            speechStatus === "interrupted" && "line-through opacity-70",
          )}
        >
          {speechStatus && speechLabel ? (
            <VoiceSpeechStatusIndicator
              status={speechStatus}
              label={speechLabel}
            />
          ) : null}
          <MessageResponse mode="static">{item.content.text}</MessageResponse>
        </div>
        <StepActions onEdit={onEdit} onRemove={onRemove} />
      </div>
    );
  }

  if (item.kind === "exploration") {
    const active = item.steps.some(
      (step) => step.kind === "tool" && isActiveToolStatus(getToolStatus(step)),
    );
    return (
      <div className="group/step flex gap-2.5 text-muted-foreground">
        <WorkRail isLast={isLast} status="exploration" active={active} />
        <div className="min-w-0 flex-1 pb-2">
          <ExplorationBody
            item={item}
            expandedKeys={expandedKeys}
            onExpandedChange={onExpandedChange}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="group/step flex gap-2.5">
      <WorkRail isLast={isLast} status={getToolStatus(item)} />
      <div className="min-w-0 flex-1 pb-2">
        <ToolStep
          item={item}
          open={expandedKeys.has(item.key)}
          onOpenChange={(next) => onExpandedChange(item.key, next)}
        />
      </div>
      <StepActions onRemove={onRemove} />
    </div>
  );
}

export function AgentWorkPanel({
  payload,
  settleOnMount = false,
  onEditPart,
  onRemovePart,
}: {
  payload: TranscriptAgentWorkPayload;
  settleOnMount?: boolean;
  /** Edit one step of the reply in the composer. */
  onEditPart?: (messageId: string, part: MessagePart) => void;
  /** Take one step out of the reply. */
  onRemovePart?: (messageId: string, part: MessagePart) => void;
}) {
  const { t } = useTranslation("chat");
  const prefersReducedMotion = useReducedMotion();
  const { rowState, updateRowState, markRowInteracted, pinScrollAnchor } =
    useTranscriptRowStateAdapter();
  // `markRowInteracted` only pins this row for 60 s and only 20 rows per
  // session, so an expanded settled panel used to come back collapsed once the
  // row was evicted. The disclosure therefore lives in the durable row state,
  // exactly as `ToolChainCards` keeps `chainExpanded`/`expandedToolKeys`.
  const durableWorkState = rowState?.agentWorkPanels?.[payload.workId];
  const userInteractedRef = useRef(durableWorkState?.userInteracted ?? false);
  const items = useMemo(
    () => buildAgentWorkTimeline(payload.content, payload.parts),
    [payload.content, payload.parts],
  );
  // What the panel draws: the same steps, with runs of lookups folded.
  const rows = useMemo(() => groupLookups(items), [items]);
  // Steps can be edited and removed once the work is over: a step still
  // being written has no settled shape to name to the host.
  const stepsSettled = !payload.isActiveWork;
  const stepMessageId = payload.messageId;
  const stepEditAction = (item: AgentWorkTimelineItem) => {
    if (item.kind === "exploration") return undefined;
    const part = item.part;
    if (!stepsSettled || !part || !onEditPart) return undefined;
    if (item.kind !== "thought" && item.kind !== "progress") return undefined;
    return () => onEditPart(stepMessageId, part);
  };
  const stepRemoveAction = (item: AgentWorkTimelineItem) => {
    if (item.kind === "exploration") return undefined;
    const part = item.part;
    if (!stepsSettled || !part || !onRemovePart) return undefined;
    return () => onRemovePart(stepMessageId, part);
  };
  // Every viewable file this work touched. Chips are the single way back into
  // the viewer: they render for any count and survive collapse. The old header
  // "View" action only appeared for exactly one file, so the same document
  // surfaced as a different-looking control depending on how the run grouped —
  // chips replace it outright.
  const workArtifacts = useMemo(
    () =>
      viewableArtifacts(
        items.map((item) => (item.kind === "tool" ? item.request : undefined)),
      ),
    [items],
  );
  // Ephemeral in-harness subagents (Claude Code Task/Agent, Ultracode
  // workflows, Goose delegate/load, Codex spawn_agent/wait_agent). The strip
  // is the live view: once the turn settles the same row normally moves under
  // the answer, so the chips are never rendered twice. A turn that ends in
  // tool calls with no final text has no answer bubble at all, and then the
  // projection marks this group as the footer host so the chips persist here.
  const harnessBrigade = useMemo(
    () =>
      selectHarnessBrigade({
        content: payload.content,
        turnFinished: !payload.isActiveWork,
        ...(payload.subagentLinkage
          ? { messages: payload.subagentLinkage }
          : {}),
      }),
    [payload.content, payload.isActiveWork, payload.subagentLinkage],
  );
  const showsHarnessBrigade = payload.isActiveWork || payload.hostsTurnFooters;
  const shouldOpenActiveWork = payload.isActiveWork;
  const [open, setOpen] = useState(() =>
    userInteractedRef.current
      ? (durableWorkState?.open ?? false)
      : shouldOpenActiveWork || settleOnMount,
  );
  const [previousStepsOpen, setPreviousStepsOpen] = useState(
    () => durableWorkState?.previousStepsOpen ?? false,
  );
  const [expandedToolKeys, setExpandedToolKeys] = useState<ReadonlySet<string>>(
    () => new Set(durableWorkState?.expandedToolKeys ?? []),
  );
  const wasActiveRef = useRef(shouldOpenActiveWork || settleOnMount);
  const settleCloseFrameRef = useRef<number | null>(null);

  const setToolOpen = useCallback((key: string, nextOpen: boolean) => {
    userInteractedRef.current = true;
    setExpandedToolKeys((current) => {
      if (current.has(key) === nextOpen) return current;
      const next = new Set(current);
      if (nextOpen) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const expandedToolKeyList = useMemo(
    () => [...expandedToolKeys].sort(),
    [expandedToolKeys],
  );

  useEffect(() => {
    updateRowState(
      (current) => ({
        ...current,
        agentWorkPanels: {
          ...current.agentWorkPanels,
          [payload.workId]: {
            ...current.agentWorkPanels?.[payload.workId],
            open,
            previousStepsOpen,
            expandedToolKeys: expandedToolKeyList,
            userInteracted: userInteractedRef.current,
          },
        },
      }),
      { markRecent: false },
    );
  }, [
    expandedToolKeyList,
    open,
    payload.workId,
    previousStepsOpen,
    updateRowState,
  ]);

  useEffect(() => {
    const cancelScheduledSettleClose = () => {
      if (settleCloseFrameRef.current == null) {
        return;
      }
      cancelAnimationFrame(settleCloseFrameRef.current);
      settleCloseFrameRef.current = null;
    };

    cancelScheduledSettleClose();

    if (payload.isActiveWork) {
      setOpen(shouldOpenActiveWork);
      wasActiveRef.current = shouldOpenActiveWork;
      return cancelScheduledSettleClose;
    }

    // A panel the user has opened themselves keeps what they chose: neither the
    // settle animation nor a later remount may collapse it behind their back.
    if (userInteractedRef.current) {
      wasActiveRef.current = false;
      return cancelScheduledSettleClose;
    }

    if (wasActiveRef.current || settleOnMount) {
      // The streaming rows move from the live-tail container into the virtual
      // history container when a turn completes, which remounts this panel even
      // though the row id is stable. Mount the settled history row open, then
      // close after a paint so Radix/CSS has a real open -> closed transition.
      setOpen(true);
      settleCloseFrameRef.current = requestAnimationFrame(() => {
        settleCloseFrameRef.current = requestAnimationFrame(() => {
          settleCloseFrameRef.current = null;
          setOpen(false);
        });
      });
    } else {
      setOpen(false);
    }

    wasActiveRef.current = false;
    return cancelScheduledSettleClose;
  }, [payload.isActiveWork, settleOnMount, shouldOpenActiveWork]);

  // A harness brigade chip asking for its tool card: expand this panel (and
  // the "previous steps" bucket when the card is hidden there) if the card
  // belongs to us. Panels that do not own the call ignore the request, and
  // the scroll itself is the caller's business.
  useEffect(
    () =>
      onHarnessSubagentReveal((toolCallId) => {
        const owned = items.some(
          (item) => item.kind === "tool" && item.request?.id === toolCallId,
        );
        if (!owned) return;
        // A chip reveal is a user action on this panel, so the panel it opens
        // must stay open the way a click on the trigger would.
        userInteractedRef.current = true;
        setOpen(true);
        if (
          payload.isActiveWork &&
          getActivePreviewState(rows).hiddenItems.some(
            (item) => item.kind === "tool" && item.request?.id === toolCallId,
          )
        ) {
          setPreviousStepsOpen(true);
        }
      }),
    [items, rows, payload.isActiveWork],
  );

  const showTrigger = !payload.isActiveWork;
  const isActiveWorkPreview = payload.isActiveWork;
  const activePreviewState = isActiveWorkPreview
    ? getActivePreviewState(rows)
    : null;
  const visibleItems = activePreviewState?.visibleItems ?? rows;
  const hiddenItems = activePreviewState?.hiddenItems ?? [];
  const hiddenStepCount = activePreviewState?.hiddenStepCount ?? 0;
  const shouldShowPreviousSteps = isActiveWorkPreview && hiddenStepCount > 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        markRowInteracted("agent-work-disclosure");
        pinScrollAnchor();
        userInteractedRef.current = true;
        setOpen(nextOpen);
      }}
      data-role="agent-work-panel"
      className="mt-3 w-full min-w-0 max-w-full"
    >
      <div>
        <div className="flex min-w-0 items-center gap-2">
          {showTrigger ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                flush
                size="sm"
                className="flex h-auto w-full min-w-0 flex-1 justify-start rounded-md px-0 py-2 text-left"
                rightIcon={
                  <IconChevronRight
                    aria-hidden
                    className={cn(
                      "size-3.5 transition-transform",
                      open && "rotate-90",
                    )}
                  />
                }
              >
                <span className="min-w-0 truncate text-sm font-normal">
                  {t(
                    payload.hasFinalAnswer
                      ? "agent_work.summary.previousSteps"
                      : "agent_work.summary.steps",
                    { count: rows.length },
                  )}
                </span>
              </Button>
            </CollapsibleTrigger>
          ) : null}
        </div>
        {/*
          One chip per viewable file, for any count. This is the only re-entry
          control on an agent-work panel: it survives collapse and looks the
          same whether the run wrote one document or six.
        */}
        {workArtifacts.length > 0 ? (
          <ArtifactChips artifacts={workArtifacts} className="px-1 pb-1.5" />
        ) : null}
        {showsHarnessBrigade ? (
          <HarnessBrigadeRow entries={harnessBrigade} className="px-1 pb-1.5" />
        ) : null}
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="min-h-0 space-y-0">
            {shouldShowPreviousSteps ? (
              <motion.div
                key="previous-steps"
                initial={prefersReducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0 }
                    : {
                        duration: 0.18,
                        ease: [0.215, 0.61, 0.355, 1],
                      }
                }
              >
                <Collapsible
                  open={previousStepsOpen}
                  onOpenChange={(nextOpen) => {
                    markRowInteracted("agent-work-previous-steps");
                    pinScrollAnchor();
                    userInteractedRef.current = true;
                    setPreviousStepsOpen(nextOpen);
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      flush
                      size="sm"
                      className="mb-1 flex h-auto w-full justify-start rounded-md px-0 py-2 text-left"
                      rightIcon={
                        <IconChevronRight
                          aria-hidden
                          className={cn(
                            "size-3.5 transition-transform",
                            previousStepsOpen && "rotate-90",
                          )}
                        />
                      }
                    >
                      <span className="text-sm tabular-nums">
                        {t("agent_work.summary.previousSteps", {
                          count: hiddenStepCount,
                        })}
                      </span>
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                    {hiddenItems.map((item) => (
                      <AgentWorkItemRow
                        key={item.key}
                        item={item}
                        isLast={false}
                        usePrimaryText={open}
                        expandedKeys={expandedToolKeys}
                        onExpandedChange={setToolOpen}
                        onEdit={stepEditAction(item)}
                        onRemove={stepRemoveAction(item)}
                      />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              </motion.div>
            ) : null}
            <motion.div
              key="live-steps"
              layout={prefersReducedMotion ? false : "position"}
              data-role="agent-work-live-steps"
              className="relative"
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : {
                      type: "spring",
                      duration: 0.26,
                      bounce: 0,
                    }
              }
            >
              <AnimatePresence initial={false} mode="popLayout">
                {visibleItems.map((item, index) => (
                  <motion.div
                    key={item.key}
                    layout={prefersReducedMotion ? false : "position"}
                    initial={
                      prefersReducedMotion ? false : { opacity: 0, y: 4 }
                    }
                    animate={{ opacity: 1, y: 0 }}
                    exit={
                      prefersReducedMotion ? undefined : { opacity: 0, y: -4 }
                    }
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : {
                            layout: {
                              type: "spring",
                              duration: 0.26,
                              bounce: 0,
                            },
                            opacity: {
                              duration: 0.18,
                              ease: [0.215, 0.61, 0.355, 1],
                            },
                            y: {
                              duration: 0.22,
                              ease: [0.215, 0.61, 0.355, 1],
                            },
                          }
                    }
                  >
                    <AgentWorkItemRow
                      item={item}
                      isLast={index === visibleItems.length - 1}
                      usePrimaryText={open}
                      expandedKeys={expandedToolKeys}
                      onExpandedChange={setToolOpen}
                      onEdit={stepEditAction(item)}
                      onRemove={stepRemoveAction(item)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
