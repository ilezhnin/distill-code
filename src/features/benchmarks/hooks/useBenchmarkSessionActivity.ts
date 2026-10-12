import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readHistoryPage } from "@/shared/api/acpApi";

interface ActivityObservation {
  cursor: number;
  checkedAt: number;
  unchangedSince: number;
  activitySeenAt: number | null;
}

/** Observation times are not claimed to be the native event's timestamp. */
export function observeActivity(
  previous: ActivityObservation | undefined,
  cursor: number,
  now: number,
): ActivityObservation {
  if (!previous || cursor < previous.cursor)
    return {
      cursor,
      checkedAt: now,
      unchangedSince: now,
      activitySeenAt: null,
    };
  const changed = cursor > previous.cursor;
  return {
    cursor,
    checkedAt: now,
    unchangedSince: changed ? now : previous.unchangedSince,
    activitySeenAt: changed ? now : previous.activitySeenAt,
  };
}

export function useBenchmarkSessionActivity(sessionId: string) {
  const client = useQueryClient();
  const key = ["benchmark-session-activity", sessionId];
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      // The page before the first event is empty but carries the native high
      // water mark. This reads metadata without replay, transcript downloads,
      // session/load, provider traffic, or execution-control side effects.
      const page = await readHistoryPage(sessionId, 1);
      return observeActivity(
        client.getQueryData<ActivityObservation>(key),
        page.highWaterEventId,
        Date.now(),
      );
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 4000,
    retry: false,
  });
}
