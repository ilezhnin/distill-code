/**
 * Hooks over the security-confirmation store. Kept out of
 * SecurityConfirmationPanel.tsx so that file exports only components:
 * react-refresh gives up on a module that mixes hooks with components, and an
 * open chat then loses its session state on an edit instead of hot-reloading.
 */

import { useLayoutEffect } from "react";

import { useSecurityConfirmationStore } from "@/features/security/stores/securityConfirmationStore";

export function useHasPendingSecurityConfirmation(sessionId: string): boolean {
  return useSecurityConfirmationStore(
    (state) => (state.pendingBySessionId[sessionId]?.length ?? 0) > 0,
  );
}

export function useRegisterSecurityConfirmationSurface(sessionId: string) {
  const mountSurface = useSecurityConfirmationStore(
    (state) => state.mountSurface,
  );
  const unmountSurface = useSecurityConfirmationStore(
    (state) => state.unmountSurface,
  );

  useLayoutEffect(() => {
    mountSurface(sessionId);
    return () => unmountSurface(sessionId);
  }, [mountSurface, sessionId, unmountSurface]);
}
