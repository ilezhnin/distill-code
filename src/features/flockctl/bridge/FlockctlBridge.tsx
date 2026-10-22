import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { listenFlockctlRequests } from "@/features/flockctl/bridge/flockctlPlugin";
import {
  handleFlockctlRequest,
  setFlockctlDesired,
} from "@/features/flockctl/bridge/lifecycle";
import {
  clearFlockctlQueryClient,
  registerFlockctlQueryClient,
} from "@/features/flockctl/bridge/runtimeContext";
import { installStartupSessionDeepLinkHandler } from "./startupDeepLinks";
import { useFlockctlQueuedMessageDrain } from "./useFlockctlQueuedMessageDrain";
import { usePendingSessionWorkspaceActivationDrain } from "./usePendingSessionWorkspaceActivationDrain";
import { useWorkspaceAttachmentSync } from "@/features/chat/hooks/useWorkspaceAttachmentSync";

/**
 * Null-rendering bridge between the flockctl broker (Rust plugin) and the
 * renderer command registry. Mounted once in the main window (main.tsx); the
 * session-window branch must never render it. All real state lives in the
 * module-scoped lifecycle singleton (see bridge/lifecycle.ts), which keeps
 * the broker StrictMode double-mount safe.
 */
export function FlockctlBridge() {
  const queryClient = useQueryClient();

  // Register the workspace barrier before queue drains so an idle transition
  // starts any pending switch before a queued prompt can claim the session.
  useWorkspaceAttachmentSync();
  usePendingSessionWorkspaceActivationDrain();
  useFlockctlQueuedMessageDrain();

  // Share the app's react-query cache with the command layer (doctor report).
  useEffect(() => {
    registerFlockctlQueryClient(queryClient);
    return () => {
      clearFlockctlQueryClient(queryClient);
    };
  }, [queryClient]);

  // Request listener: the only consumer of "flockctl:request". Mounted
  // unconditionally — it is inert while the broker is stopped, and keeping it
  // up avoids a race between enable and the first forwarded command.
  useEffect(() => {
    const unlisten = listenFlockctlRequests((request) => {
      void handleFlockctlRequest(request);
    });
    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => installStartupSessionDeepLinkHandler(), []);

  // Broker lifecycle: declare desired state; the lifecycle reconciler
  // serializes start/stop and goes inert if the plugin is not in this build.
  useEffect(() => {
    setFlockctlDesired(true);
    return () => {
      setFlockctlDesired(false);
    };
  }, []);

  return null;
}
