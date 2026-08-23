import { create } from "zustand";

import {
  activeChildTabAfterClose,
  openChildChatTabs,
  resolveActiveChildTab,
  type ChildChatTab,
} from "@/features/chat/lib/childChatTabs";

export type { ChildChatTab };

const EMPTY_TABS: ChildChatTab[] = [];

/**
 * Open child transcripts, per host conversation — the same `tabsBySession`
 * shape the artifact viewer uses, so a conversation's tabs follow it around
 * and never bleed into another session's panel.
 *
 * Deliberately **not persisted**, for the same reasons the artifact viewer
 * isn't: a tab is "I am watching this worker right now", not a document. After
 * a restart the graph's reconcile pass marks orphaned children `stopped`
 * (item 1c), so restoring the strip would reopen a row of dead transcripts,
 * some of whose sessions may no longer exist at all. Panel *width* is
 * persisted, because that is a lasting layout preference.
 */
interface ChildChatTabsState {
  /** Open child tabs per host session, in open order. */
  tabsBySession: Record<string, ChildChatTab[]>;
  /** Active child session id per host session. */
  activeChildIdBySession: Record<string, string | null>;
  /** The tab currently shown per host session; mirrors the active tab. */
  openBySession: Record<string, ChildChatTab | null>;
  open: (hostSessionId: string, tab: ChildChatTab) => void;
  activate: (hostSessionId: string, childSessionId: string) => void;
  closeTab: (hostSessionId: string, childSessionId: string) => void;
  closeAll: (hostSessionId: string) => void;
}

function sessionSlice(
  state: ChildChatTabsState,
  hostSessionId: string,
  tabs: ChildChatTab[],
  activeChildId: string | null,
): Partial<ChildChatTabsState> {
  const nextActive = resolveActiveChildTab(tabs, activeChildId);
  return {
    tabsBySession: { ...state.tabsBySession, [hostSessionId]: tabs },
    activeChildIdBySession: {
      ...state.activeChildIdBySession,
      [hostSessionId]: nextActive?.sessionId ?? null,
    },
    openBySession: { ...state.openBySession, [hostSessionId]: nextActive },
  };
}

export const useChildChatTabsStore = create<ChildChatTabsState>((set) => ({
  tabsBySession: {},
  activeChildIdBySession: {},
  openBySession: {},
  open: (hostSessionId, tab) =>
    set((state) => {
      const tabs = state.tabsBySession[hostSessionId] ?? [];
      return sessionSlice(
        state,
        hostSessionId,
        openChildChatTabs(tabs, tab),
        tab.sessionId,
      );
    }),
  activate: (hostSessionId, childSessionId) =>
    set((state) => {
      const tabs = state.tabsBySession[hostSessionId] ?? [];
      if (!tabs.some((tab) => tab.sessionId === childSessionId)) {
        return state;
      }
      return sessionSlice(state, hostSessionId, tabs, childSessionId);
    }),
  closeTab: (hostSessionId, childSessionId) =>
    set((state) => {
      const tabs = state.tabsBySession[hostSessionId] ?? [];
      if (!tabs.some((tab) => tab.sessionId === childSessionId)) {
        return state;
      }
      const nextActive = activeChildTabAfterClose(
        tabs,
        state.activeChildIdBySession[hostSessionId],
        childSessionId,
      );
      return sessionSlice(
        state,
        hostSessionId,
        tabs.filter((tab) => tab.sessionId !== childSessionId),
        nextActive,
      );
    }),
  closeAll: (hostSessionId) =>
    set((state) => sessionSlice(state, hostSessionId, [], null)),
}));

export function useActiveChildChatTab(
  hostSessionId: string | null | undefined,
): ChildChatTab | null {
  return useChildChatTabsStore((s) =>
    hostSessionId ? (s.openBySession[hostSessionId] ?? null) : null,
  );
}

export function useOpenChildChatTabs(
  hostSessionId: string | null | undefined,
): readonly ChildChatTab[] {
  return useChildChatTabsStore((s) =>
    hostSessionId ? (s.tabsBySession[hostSessionId] ?? EMPTY_TABS) : EMPTY_TABS,
  );
}
