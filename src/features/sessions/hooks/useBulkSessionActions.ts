import { useCallback, useState } from "react";
import { getChatSessionIdsWithTerminals } from "@/features/terminal/lib/terminalSessionManager";
import {
  applySessionActionToIds,
  type SessionAction,
} from "../lib/sessionSelection";

interface UseBulkSessionActionsOptions {
  selectedSessionIds: Set<string>;
  onComplete: () => void;
  onFailure: (failedCount: number) => void;
}

export function useBulkSessionActions({
  selectedSessionIds,
  onComplete,
  onFailure,
}: UseBulkSessionActionsOptions) {
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveSelectionSnapshot, setArchiveSelectionSnapshot] = useState<
    Set<string>
  >(() => new Set());
  const [archiveTerminalCount, setArchiveTerminalCount] = useState(0);
  const [isApplyingSelectionAction, setIsApplyingSelectionAction] =
    useState(false);

  const applySelectionAction = useCallback(
    async (action?: SessionAction, sessionIds = selectedSessionIds) => {
      if (!action || isApplyingSelectionAction || sessionIds.size === 0) return;

      setIsApplyingSelectionAction(true);
      try {
        const result = await applySessionActionToIds(sessionIds, action);
        if (result && result.failedCount > 0) {
          onFailure(result.failedCount);
        }
        return result;
      } finally {
        onComplete();
        setIsApplyingSelectionAction(false);
      }
    },
    [isApplyingSelectionAction, onComplete, onFailure, selectedSessionIds],
  );

  const requestArchiveSelected = useCallback(() => {
    setArchiveSelectionSnapshot(new Set(selectedSessionIds));
    // Archiving a chat stops its shells, and unarchiving brings none of them
    // back. Counted at the moment the confirmation opens, so the dialog can say
    // what the operator is about to lose instead of promising a restore that
    // only covers the chat.
    const withTerminals = getChatSessionIdsWithTerminals();
    let terminals = 0;
    for (const sessionId of selectedSessionIds) {
      if (withTerminals.has(sessionId)) terminals += 1;
    }
    setArchiveTerminalCount(terminals);
    setArchiveConfirmOpen(true);
  }, [selectedSessionIds]);

  const confirmArchiveSelected = useCallback(
    async (action?: SessionAction) => {
      const sessionIds = new Set(archiveSelectionSnapshot);
      setArchiveConfirmOpen(false);
      setArchiveSelectionSnapshot(new Set());
      setArchiveTerminalCount(0);
      await applySelectionAction(action, sessionIds);
    },
    [applySelectionAction, archiveSelectionSnapshot],
  );

  return {
    applySelectionAction,
    archiveConfirmOpen,
    archiveSelectionCount: archiveSelectionSnapshot.size,
    /** How many of the chats about to be archived still have a live shell. */
    archiveTerminalCount,
    confirmArchiveSelected,
    isApplyingSelectionAction,
    requestArchiveSelected,
    setArchiveConfirmOpen,
  };
}
