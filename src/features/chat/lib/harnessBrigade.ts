/**
 * Projection of in-harness subagents onto brigade chips.
 *
 * Claude Code (`Task`/`Agent`), Ultracode workflows, Goose (`delegate` +
 * `load <task-id>`) and Codex (`spawn_agent`/`wait_agent`/…) all run their
 * subagents *inside* the host turn: there is no session, no graph node and
 * nothing to stop. All that exists is a sequence of tool calls, already
 * classified by `subagentToolCalls.ts`.
 *
 * This module turns one assistant turn's content into ephemeral entries that
 * the reusable brigade chip can render. It is pure: no stores, no graph
 * writes, no session creation — the same content always yields the same
 * entries.
 */

import { isWorkingStatus } from "@/features/conductor/brigadeActivity";
import type { RunStatus } from "@/features/conductor/types";
import type {
  MessageContent,
  ToolCallStatus,
  ToolRequestContent,
  ToolResponseContent,
} from "@/shared/types/messages";

import {
  findDelegateRequestForTask,
  getSubagentToolCallInfo,
  type SubagentToolCallInfo,
} from "./subagentToolCalls";

/** One in-harness subagent, as far as this turn's tool calls reveal it. */
export interface HarnessBrigadeEntry {
  /**
   * Stable identity across re-renders: the tool-call id of the request that
   * spawned this subagent. Follow-up calls (a Goose `load <task-id>`, a Codex
   * `wait_agent`) resolve back to that same id instead of minting a new one,
   * so a name collision between two subagents never merges them and a status
   * change never re-keys a chip.
   */
  key: string;
  /**
   * Chip label: the harness-provided agent name, else the task description,
   * else the Goose task id. Absent when the harness named nothing at all —
   * the UI supplies a localized fallback.
   */
  name?: string;
  /** Plain-language task, when the tool call carried one. Used as tooltip. */
  label?: string;
  /** Stage-0 contract #4 status. */
  status: RunStatus;
  /**
   * The most recent tool call driving this entry — the card a chip click
   * expands and scrolls to. Always a call from the projected content.
   */
  latestToolCallId: string;
}

export interface HarnessBrigadeInput {
  /** One assistant turn's content (or one agent-work slice of it). */
  content: readonly MessageContent[];
  /**
   * Whether the turn is over. Entries still non-terminal at that point are
   * terminalized as `cancelled`: nobody is going to report on them.
   */
  turnFinished: boolean;
  /**
   * Transcript consulted only to link a Goose `load <task-id>` back to the
   * `delegate` that announced the id. Defaults to the projected content
   * itself, which is where the pair virtually always lives.
   */
  messages?: ReadonlyArray<{ content: readonly MessageContent[] }>;
}

/** Shared empty result so idle turns keep a stable array identity. */
export const NO_HARNESS_BRIGADE: readonly HarnessBrigadeEntry[] = Object.freeze(
  [],
);

/**
 * Tools that *start* a subagent. Everything else classified by
 * `getSubagentToolCallInfo` (await, peek, cancel, message, follow-up) acts on
 * a subagent that already exists.
 */
const SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delegate",
  "Task",
  "Agent",
  "spawn_agent",
]);

/** Stage-0 contract #4: the fixed tool-status → run-status mapping. */
const RUN_STATUS_BY_TOOL_STATUS: Record<ToolCallStatus, RunStatus> = {
  pending: "running",
  in_progress: "running",
  completed: "completed",
  failed: "failed",
  stopped: "cancelled",
};

interface DraftEntry {
  key: string;
  agentName?: string;
  label?: string;
  taskId?: string;
  status: RunStatus;
  latestToolCallId: string;
}

function runStatusForCall(
  request: ToolRequestContent,
  response: ToolResponseContent | undefined,
): RunStatus {
  // A response is the ground truth the tool card itself trusts; the request
  // status is what we have while the call is still open.
  if (response) return response.isError ? "failed" : "completed";
  return RUN_STATUS_BY_TOOL_STATUS[request.status] ?? "running";
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Every subagent name a single call speaks about, in call order. */
function callAgentNames(info: SubagentToolCallInfo): string[] {
  if (info.agentNames?.length) return info.agentNames;
  return info.agentName ? [info.agentName] : [];
}

/** The most recently created entry that carries this agent name. */
function findEntryByAgentName(
  drafts: ReadonlyMap<string, DraftEntry>,
  agentName: string,
): DraftEntry | undefined {
  let match: DraftEntry | undefined;
  for (const draft of drafts.values()) {
    if (draft.agentName === agentName) match = draft;
  }
  return match;
}

function upsert(
  drafts: Map<string, DraftEntry>,
  key: string,
  seed: {
    agentName?: string;
    label?: string;
    taskId?: string;
  },
  status: RunStatus,
  toolCallId: string,
): void {
  const existing = drafts.get(key);
  if (existing) {
    // Facts already recovered from the spawn are never discarded by a
    // follow-up call that happens to know less.
    existing.agentName ??= seed.agentName;
    existing.label ??= seed.label;
    existing.taskId ??= seed.taskId;
    existing.status = status;
    existing.latestToolCallId = toolCallId;
    return;
  }
  drafts.set(key, {
    key,
    ...(seed.agentName ? { agentName: seed.agentName } : {}),
    ...(seed.label ? { label: seed.label } : {}),
    ...(seed.taskId ? { taskId: seed.taskId } : {}),
    status,
    latestToolCallId: toolCallId,
  });
}

/**
 * Project one assistant turn's content onto ephemeral brigade entries.
 *
 * Entries come back in spawn order. The status of an entry is the status of
 * the most recent call that touched it, which is what makes a Goose
 * `delegate` → `load <task-id>` pair read as one subagent whose chip follows
 * the await rather than freezing at the delegate's own result.
 */
export function selectHarnessBrigade(
  input: HarnessBrigadeInput,
): readonly HarnessBrigadeEntry[] {
  const { content, turnFinished } = input;

  const responsesById = new Map<string, ToolResponseContent>();
  for (const block of content) {
    if (block.type === "toolResponse" && !responsesById.has(block.id)) {
      responsesById.set(block.id, block);
    }
  }

  const linkageMessages = input.messages ?? [{ content }];
  const drafts = new Map<string, DraftEntry>();

  for (const block of content) {
    if (block.type !== "toolRequest") continue;
    const info = getSubagentToolCallInfo({
      toolName: block.toolName,
      arguments: block.arguments,
    });
    if (!info) continue;

    const status = runStatusForCall(block, responsesById.get(block.id));
    const label = firstNonEmpty(info.label, block.subagentTaskLabel);

    // Goose await/peek/cancel: the task id points back at the delegate that
    // announced it, and that delegate's request id is the entry identity.
    if (info.taskId) {
      const delegate = findDelegateRequestForTask(linkageMessages, info.taskId);
      const delegateInfo = delegate
        ? getSubagentToolCallInfo({
            toolName: delegate.toolName,
            arguments: delegate.arguments,
          })
        : undefined;
      upsert(
        drafts,
        delegate?.id ?? block.id,
        {
          agentName: firstNonEmpty(
            delegateInfo?.agentName,
            block.subagentAgentName,
          ),
          label: firstNonEmpty(label, delegateInfo?.label),
          taskId: info.taskId,
        },
        status,
        block.id,
      );
      continue;
    }

    const agentNames = callAgentNames(info);

    if (SPAWN_TOOL_NAMES.has(block.toolName ?? "")) {
      upsert(
        drafts,
        block.id,
        {
          agentName: firstNonEmpty(agentNames[0], block.subagentAgentName),
          label,
        },
        status,
        block.id,
      );
      continue;
    }

    // A follow-up call on an existing agent (Codex `wait_agent`,
    // `followup_task`, `close_agent`, …). It updates the spawn entry it names
    // and only mints an entry of its own when this turn never saw the spawn.
    if (agentNames.length === 0) {
      upsert(
        drafts,
        block.id,
        { agentName: block.subagentAgentName, label },
        status,
        block.id,
      );
      continue;
    }
    for (const agentName of agentNames) {
      const matched = findEntryByAgentName(drafts, agentName);
      const key = matched
        ? matched.key
        : agentNames.length > 1
          ? `${block.id}:${agentName}`
          : block.id;
      upsert(drafts, key, { agentName, label }, status, block.id);
    }
  }

  if (drafts.size === 0) return NO_HARNESS_BRIGADE;

  const entries: HarnessBrigadeEntry[] = [];
  for (const draft of drafts.values()) {
    const name = firstNonEmpty(draft.agentName, draft.label, draft.taskId);
    // Contract #4: a turn cannot end with a subagent still pending. Whatever
    // the harness left open, the operator will never hear back about.
    const status =
      turnFinished && isWorkingStatus(draft.status)
        ? "cancelled"
        : draft.status;
    entries.push({
      key: draft.key,
      ...(name ? { name } : {}),
      ...(draft.label ? { label: draft.label } : {}),
      status,
      latestToolCallId: draft.latestToolCallId,
    });
  }
  return entries;
}
