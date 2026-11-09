import { useEffect } from "react";

import {
  useMonitorJobStore,
  whenMonitorJobStoreHydrated,
} from "./monitorJobStore";
import {
  MONITOR_JOB_WATCH_INTERVAL_MS,
  noticeSilentMonitorJobs,
  watchMonitorJobsOnce,
} from "./monitorJobWatch";

/**
 * Runs the `flock-monitor` job watch for the app's main window: once as soon
 * as the record is read, then every half minute, and the silence check again
 * whenever a report changes the record — a heartbeat is what makes a silence
 * due, so it is judged the moment one lands.
 */
export function useMonitorJobWatch(): void {
  useEffect(() => {
    const run = () => {
      void watchMonitorJobsOnce();
    };
    const dropWaiter = whenMonitorJobStoreHydrated(run);
    const timer = setInterval(run, MONITOR_JOB_WATCH_INTERVAL_MS);
    const unsubscribe = useMonitorJobStore.subscribe((state, previous) => {
      if (state.jobsById !== previous.jobsById) noticeSilentMonitorJobs();
    });
    return () => {
      dropWaiter();
      clearInterval(timer);
      unsubscribe();
    };
  }, []);
}
