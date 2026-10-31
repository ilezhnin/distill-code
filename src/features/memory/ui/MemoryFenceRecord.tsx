/**
 * A `distill-memory` block, shown as what it did.
 *
 * The block is the agent talking to the app, not to the operator: its JSON in
 * the transcript is noise, and worse, it says nothing about whether anything
 * was kept. In its place the transcript shows one quiet line — saved, not
 * saved, waiting — that opens onto every statement, where it applies, what
 * became of it, and the way to the memory panel where the operator can edit
 * or delete it (LAWS/MEMORY.md, Sovereignty). The line names the agent as the
 * writer, as every surface that shows a memory must.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconArchive,
  IconBrain,
  IconCheck,
  IconCircleMinus,
  IconClock,
  type Icon,
} from "@tabler/icons-react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Tool, ToolContent, ToolHeader } from "@/shared/ui/ai-elements/tool";

import { MEMORY_FENCE_TAG, parseMemoryFenceBody } from "../lib/memoryFence";
import {
  memoryFenceOutcome,
  type MemoryFenceOutcome,
  type MemoryStatementOutcome,
  type MemoryStatementState,
} from "../lib/memoryFenceOutcome";
import { useMemoryPreferences } from "../lib/memoryPreferences";
import { sessionMemoryWriteAccess } from "../lib/memoryWriteAccess";
import { memoryRememberRefusal, useMemoryStore } from "../stores/memoryStore";

const STATEMENT_ICONS: Record<MemoryStatementState, Icon> = {
  pending: IconClock,
  paused: IconClock,
  kept: IconCheck,
  archived: IconArchive,
  removed: IconCircleMinus,
  refused: IconAlertTriangle,
  retired: IconCheck,
};

function useFenceOutcome(
  body: string,
  sessionId: string | undefined,
  messageId: string | undefined,
): MemoryFenceOutcome | null {
  const request = useMemo(() => parseMemoryFenceBody(body), [body]);
  const entries = useMemoryStore((state) => state.entries);
  const archived = useMemoryStore((state) => state.archived);
  const handled = useMemoryStore((state) =>
    messageId ? state.appliedMessageIds.includes(messageId) : false,
  );
  const writeEnabled = useMemoryPreferences().write;
  const projectId = useChatSessionStore((state) =>
    sessionId ? (state.getSession(sessionId)?.projectId ?? null) : null,
  );
  const access = sessionMemoryWriteAccess(sessionId);
  const denial = access.allowed ? null : access.denial;

  return useMemo(
    () =>
      request
        ? memoryFenceOutcome({
            request,
            handled,
            writeEnabled,
            denial,
            projectId,
            entries,
            archived,
            refusalOf: memoryRememberRefusal,
          })
        : null,
    [request, handled, writeEnabled, denial, projectId, entries, archived],
  );
}

function StatementRow({ statement }: { statement: MemoryStatementOutcome }) {
  const { t } = useTranslation("memory");
  const StateIcon = STATEMENT_ICONS[statement.state];
  const refusal = statement.refusal;
  const detail = refusal
    ? t(`fence.refusal.${refusal.reason}`, {
        shape: refusal.reason === "secret" ? refusal.shape : "",
      })
    : t(`fence.state.${statement.kind}.${statement.state}`);
  return (
    <li className="flex min-w-0 items-start gap-2">
      <StateIcon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          statement.state === "refused" && "text-warning",
        )}
      />
      <div className="min-w-0 space-y-0.5">
        <p className="text-foreground [overflow-wrap:anywhere]">
          {statement.kind === "forget"
            ? t("fence.forgetLine", { text: statement.text })
            : statement.text}
        </p>
        <p className="text-muted-foreground">
          {statement.scope
            ? t("fence.statementMeta", {
                scope: t(`fence.scope.${statement.scope}`),
                state: detail,
              })
            : detail}
        </p>
      </div>
    </li>
  );
}

function MemoryFenceRecord({
  code,
  isIncomplete,
  sessionId,
  messageId,
}: CustomRendererProps & { sessionId?: string; messageId?: string }) {
  const { t } = useTranslation("memory");
  const outcome = useFenceOutcome(code, sessionId, messageId);
  const writing = isIncomplete;
  const status = writing ? "writing" : (outcome?.status ?? "unreadable");
  const title = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <IconBrain aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{t(`fence.status.${status}`)}</span>
    </span>
  );

  return (
    <Tool
      className="my-2"
      data-memory-fence-status={status}
      data-memory-fence-message={messageId}
    >
      <ToolHeader
        type="dynamic-tool"
        toolName={MEMORY_FENCE_TAG}
        state={
          status === "writing" || status === "pending"
            ? "input-available"
            : status === "saved"
              ? "output-available"
              : "output-denied"
        }
        title={title}
        showIcon={false}
        showStatusBadge={false}
        layout="fit"
        titleClassName="font-normal text-muted-foreground"
      />
      <ToolContent className="space-y-2 text-xs">
        {outcome ? (
          <>
            <p className="text-muted-foreground">
              {outcome.denial
                ? t(`fence.denial.${outcome.denial}`)
                : t("fence.writtenByAgent")}
            </p>
            <ul className="space-y-1.5">
              {outcome.statements.map((statement) => (
                <StatementRow key={statement.key} statement={statement} />
              ))}
            </ul>
          </>
        ) : (
          <p className="text-muted-foreground">
            {writing ? t("fence.writingDetail") : t("fence.unreadableDetail")}
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          flush
          size="xs"
          onClick={() => requestOpenSettings("memory")}
        >
          {t("fence.open")}
        </Button>
      </ToolContent>
    </Tool>
  );
}

/**
 * The fence renderer for one message: its `distill-memory` blocks drawn as
 * {@link MemoryFenceRecord}. `sessionId` and `messageId` are what tie a block
 * to the store's record of having applied it.
 */
export function memoryFenceRenderer(
  sessionId: string | undefined,
  messageId: string | undefined,
): CustomRenderer {
  return {
    language: MEMORY_FENCE_TAG,
    component: (props) => (
      <MemoryFenceRecord
        {...props}
        sessionId={sessionId}
        messageId={messageId}
      />
    ),
  };
}
