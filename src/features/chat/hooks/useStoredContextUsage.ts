import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { acpGetSessionsContextUsage } from "@/shared/api/acp";
import type { ContextWindowUsage } from "../lib/contextTeam";
import { useChatStore } from "../stores/chatStore";

/** Ids one host call may name; the host refuses a longer list. */
const MAX_STORED_USAGE_SESSIONS = 128;

/**
 * The last context window each of these chats reported, for the ones this
 * window has not heard from.
 *
 * The chat store learns a chat's usage from its live traffic or from a replay
 * of its transcript. A conductor's executors that finished before the app was
 * restarted have neither until someone opens them, and a team list with a
 * blank beside every finished agent says nothing about which of them is safe
 * to hand more work. The host reads the figure off the tail of the stored
 * transcript instead, in one call for the whole team.
 *
 * A live figure always wins where both exist: this is the fallback, and it is
 * only asked for while some chat in the list has no live one.
 */
export function useStoredContextUsage(
  sessionIds: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, ContextWindowUsage> {
  const requestIds = useMemo(
    () => [...new Set(sessionIds)].sort().slice(0, MAX_STORED_USAGE_SESSIONS),
    [sessionIds],
  );
  const missingCount = useChatStore(
    (state) =>
      requestIds.filter((id) => !state.sessionStateById[id]?.hasUsageSnapshot)
        .length,
  );
  const { data } = useQuery({
    queryKey: ["session-context-usage", requestIds],
    queryFn: () => acpGetSessionsContextUsage(requestIds),
    enabled: enabled && missingCount > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return useMemo(() => {
    const usage = new Map<string, ContextWindowUsage>();
    for (const entry of data ?? []) {
      usage.set(entry.sessionId, {
        used: entry.used,
        limit: entry.size ?? 0,
      });
    }
    return usage;
  }, [data]);
}
