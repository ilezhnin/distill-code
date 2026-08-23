import { create } from "zustand";

export interface OpenArtifact {
  /** Resolved absolute path used for reading/rendering. */
  resolvedPath: string;
  /** Basename shown in the viewer header. */
  filename: string;
  /**
   * Bumped when the same path is re-opened (agent re-edits the open file,
   * auto-open fires again). The viewer keys its file read on this so the
   * contents refresh instead of staying stale until close/reopen.
   */
  revision: number;
}

const EMPTY_TABS: OpenArtifact[] = [];

interface ArtifactViewerState {
  /** Open file tabs per session, in open order. */
  tabsBySession: Record<string, OpenArtifact[]>;
  /** Active tab path per session. */
  activePathBySession: Record<string, string | null>;
  /**
   * The artifact currently shown in the viewer per session, if any.
   * Mirrors the active tab so existing callers can keep reading one file.
   */
  openBySession: Record<string, OpenArtifact | null>;
  /**
   * The path the user most recently closed per session. Auto-open uses this
   * to avoid re-popping the same file the user just dismissed.
   */
  lastClosedPathBySession: Record<string, string | null>;
  open: (sessionId: string, artifact: Omit<OpenArtifact, "revision">) => void;
  activate: (sessionId: string, resolvedPath: string) => void;
  closeTab: (sessionId: string, resolvedPath: string) => void;
  close: (sessionId: string) => void;
  closeAll: (sessionId: string) => void;
}

function activeTab(
  tabs: OpenArtifact[] | undefined,
  activePath: string | null | undefined,
): OpenArtifact | null {
  if (!tabs || tabs.length === 0) return null;
  return tabs.find((tab) => tab.resolvedPath === activePath) ?? tabs[0] ?? null;
}

function neighborPath(tabs: OpenArtifact[], closedPath: string): string | null {
  const index = tabs.findIndex((tab) => tab.resolvedPath === closedPath);
  if (index < 0) return tabs[0]?.resolvedPath ?? null;
  return tabs[index + 1]?.resolvedPath ?? tabs[index - 1]?.resolvedPath ?? null;
}

function sessionSlice(
  state: ArtifactViewerState,
  sessionId: string,
  tabs: OpenArtifact[],
  activePath: string | null,
  lastClosedPath?: string | null,
): Partial<ArtifactViewerState> {
  const nextActive = activeTab(tabs, activePath);
  return {
    tabsBySession: { ...state.tabsBySession, [sessionId]: tabs },
    activePathBySession: {
      ...state.activePathBySession,
      [sessionId]: nextActive?.resolvedPath ?? null,
    },
    openBySession: {
      ...state.openBySession,
      [sessionId]: nextActive,
    },
    ...(lastClosedPath !== undefined
      ? {
          lastClosedPathBySession: {
            ...state.lastClosedPathBySession,
            [sessionId]: lastClosedPath,
          },
        }
      : {}),
  };
}

export const useArtifactViewerStore = create<ArtifactViewerState>((set) => ({
  tabsBySession: {},
  activePathBySession: {},
  openBySession: {},
  lastClosedPathBySession: {},
  open: (sessionId, artifact) =>
    set((state) => {
      const tabs = state.tabsBySession[sessionId] ?? [];
      const existingIndex = tabs.findIndex(
        (tab) => tab.resolvedPath === artifact.resolvedPath,
      );
      const nextTabs =
        existingIndex >= 0
          ? tabs.map((tab, index) =>
              index === existingIndex
                ? { ...artifact, revision: tab.revision + 1 }
                : tab,
            )
          : [...tabs, { ...artifact, revision: 0 }];
      return sessionSlice(
        state,
        sessionId,
        nextTabs,
        artifact.resolvedPath,
        null,
      );
    }),
  activate: (sessionId, resolvedPath) =>
    set((state) => {
      const tabs = state.tabsBySession[sessionId] ?? [];
      if (!tabs.some((tab) => tab.resolvedPath === resolvedPath)) {
        return state;
      }
      return sessionSlice(state, sessionId, tabs, resolvedPath);
    }),
  closeTab: (sessionId, resolvedPath) =>
    set((state) => {
      const tabs = state.tabsBySession[sessionId] ?? [];
      if (!tabs.some((tab) => tab.resolvedPath === resolvedPath)) {
        return state;
      }
      const nextActive =
        state.activePathBySession[sessionId] === resolvedPath
          ? neighborPath(tabs, resolvedPath)
          : (state.activePathBySession[sessionId] ?? null);
      return sessionSlice(
        state,
        sessionId,
        tabs.filter((tab) => tab.resolvedPath !== resolvedPath),
        nextActive,
        resolvedPath,
      );
    }),
  close: (sessionId) =>
    set((state) => {
      const activePath = state.activePathBySession[sessionId];
      if (!activePath) {
        return sessionSlice(state, sessionId, [], null, null);
      }
      const tabs = state.tabsBySession[sessionId] ?? [];
      return sessionSlice(
        state,
        sessionId,
        tabs.filter((tab) => tab.resolvedPath !== activePath),
        neighborPath(tabs, activePath),
        activePath,
      );
    }),
  closeAll: (sessionId) =>
    set((state) =>
      sessionSlice(
        state,
        sessionId,
        [],
        null,
        state.openBySession[sessionId]?.resolvedPath ??
          state.lastClosedPathBySession[sessionId] ??
          null,
      ),
    ),
}));

export function useOpenArtifact(
  sessionId: string | null | undefined,
): OpenArtifact | null {
  return useArtifactViewerStore((s) =>
    sessionId ? (s.openBySession[sessionId] ?? null) : null,
  );
}

export function useOpenArtifactTabs(
  sessionId: string | null | undefined,
): readonly OpenArtifact[] {
  return useArtifactViewerStore((s) =>
    sessionId ? (s.tabsBySession[sessionId] ?? EMPTY_TABS) : EMPTY_TABS,
  );
}
