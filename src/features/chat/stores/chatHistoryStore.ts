import { create } from "zustand";
import { readHistoryPage } from "@/shared/api/acpApi";
import { parseHistoryPage } from "../acp/acpNotificationHandler";
import { sanitizeReplayMessages } from "../lib/replaySanitizer";
import { loadHistoryToolResults } from "../lib/historyToolResult";
import { toast } from "sonner";
import { i18n } from "@/shared/i18n";
import { onChatSessionReleased, useChatStore } from "./chatStore";

interface HistoryState {
  searching: Record<string, boolean>;
  pages: Record<
    string,
    { cursor: number | null; loading: boolean; error: string | null }
  >;
  accept: (sessionId: string, cursor: number | null) => void;
  loadOlder: (sessionId: string) => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();
const completeReads = new Map<
  string,
  { promise: Promise<void>; cancelled: boolean }
>();
export const useChatHistoryStore = create<HistoryState>((set, get) => ({
  searching: {},
  pages: {},
  accept: (sessionId, cursor) =>
    set((state) => ({
      pages: {
        ...state.pages,
        [sessionId]: { cursor, loading: false, error: null },
      },
    })),
  loadOlder: async (sessionId) => {
    if (inFlight.has(sessionId)) return inFlight.get(sessionId);
    const page = get().pages[sessionId];
    if (page?.cursor == null) return;
    const pending = { ...page, loading: true, error: null };
    set((state) => ({ pages: { ...state.pages, [sessionId]: pending } }));
    const request = (async () => {
      try {
        const history = await readHistoryPage(sessionId, page.cursor as number);
        if (get().pages[sessionId] !== pending) return;
        const messages = sanitizeReplayMessages(
          await parseHistoryPage(
            sessionId,
            history.events,
            page.cursor as number,
          ),
        );
        if (get().pages[sessionId] !== pending) return;
        if (
          history.olderCursor != null &&
          history.olderCursor >= (page.cursor as number)
        )
          throw new Error("History cursor did not advance");
        const store = useChatStore.getState();
        const current = store.messagesBySession[sessionId] ?? [];
        const ids = new Set(current.map((message) => message.id));
        store.setMessages(sessionId, [
          ...messages.filter((message) => !ids.has(message.id)),
          ...current,
        ]);
        get().accept(sessionId, history.olderCursor);
      } catch (error) {
        if (get().pages[sessionId] === pending)
          set((state) => ({
            pages: {
              ...state.pages,
              [sessionId]: { ...page, loading: false, error: String(error) },
            },
          }));
      }
    })().finally(() => {
      if (inFlight.get(sessionId) === request) inFlight.delete(sessionId);
    });
    inFlight.set(sessionId, request);
    await request;
  },
}));

export function loadCompleteHistory(sessionId: string): Promise<void> {
  const pending = completeReads.get(sessionId);
  if (pending) return pending.promise;
  const read = { promise: Promise.resolve(), cancelled: false };
  useChatHistoryStore.setState((state) => ({
    searching: { ...state.searching, [sessionId]: true },
  }));
  const request = (async () => {
    try {
      while (useChatHistoryStore.getState().pages[sessionId]?.cursor != null) {
        if (read.cancelled) return;
        await useChatHistoryStore.getState().loadOlder(sessionId);
        if (useChatHistoryStore.getState().pages[sessionId]?.error)
          throw new Error("History unavailable");
      }
      if (!read.cancelled) await loadHistoryToolResults(sessionId);
    } catch {
      if (!read.cancelled) toast.error(i18n.t("chat:history.searchIncomplete"));
    }
  })().finally(() => {
    if (completeReads.get(sessionId) !== read) return;
    completeReads.delete(sessionId);
    useChatHistoryStore.setState((state) => {
      const searching = { ...state.searching };
      delete searching[sessionId];
      return { searching };
    });
  });
  read.promise = request;
  completeReads.set(sessionId, read);
  return request;
}

onChatSessionReleased((sessionId) => {
  inFlight.delete(sessionId);
  const read = completeReads.get(sessionId);
  if (read) read.cancelled = true;
  completeReads.delete(sessionId);
  useChatHistoryStore.setState((state) => {
    const pages = { ...state.pages };
    const searching = { ...state.searching };
    delete pages[sessionId];
    delete searching[sessionId];
    return { pages, searching };
  });
});
