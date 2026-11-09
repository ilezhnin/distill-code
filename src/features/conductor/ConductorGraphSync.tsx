import { useConductorGraphSync } from "./useConductorGraphSync";
import { useMonitorJobWatch } from "./useMonitorJobWatch";

export function ConductorGraphSync() {
  useConductorGraphSync();
  useMonitorJobWatch();
  return null;
}
