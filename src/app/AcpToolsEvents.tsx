import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listenAcpToolsReconciled } from "@/shared/api/acpTools";
import { rerunDoctorReport } from "@/shared/api/useDoctorReport";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";

// On a fresh profile the startup reconciler installs the managed ACP bridges
// long after the first `runDoctor` cached them as missing, and the doctor
// query never re-probes on its own (`refetchOnMount: false`, no focus or
// interval refetch) — so the agent picker would keep Claude/Codex on
// "Install" until the user opens Settings or restarts. Rerun the shared
// Doctor query when the backend signals reconcile completion so readiness
// flips as soon as the bridges land. `rerunDoctorReport` rather than a bare
// invalidate: invalidation alone refetches through the fast, freshness-off
// `runDoctor` queryFn and would blank any version/update badges an earlier
// Settings visit populated.
export function AcpToolsEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listenAcpToolsReconciled(({ providerIds }) => {
      void rerunDoctorReport(queryClient);
      const models = useProviderModelCacheStore.getState();
      for (const providerId of providerIds) {
        models.invalidateProvider(providerId);
        void models.refreshProviderModels(providerId, { force: true });
      }
    });

    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, [queryClient]);

  return null;
}
