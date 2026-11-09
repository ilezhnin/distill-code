import { useEffect } from "react";
import { startConductorNoticeRelay } from "./conductorNoticeRelay";
import { useConductorGraphSync } from "./useConductorGraphSync";
import { useMonitorJobWatch } from "./useMonitorJobWatch";

export function ConductorGraphSync() {
  useConductorGraphSync();
  useMonitorJobWatch();
  useEffect(() => startConductorNoticeRelay(), []);
  return null;
}
