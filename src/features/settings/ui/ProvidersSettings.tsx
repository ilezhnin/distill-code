import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  rerunDoctorReport,
  useDoctorReport,
  useDoctorReportFreshnessFetching,
} from "@/shared/api/useDoctorReport";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { AgentProviderCard } from "./AgentProviderCard";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { RoutingPolicySection } from "./RoutingPolicySection";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import type { ProviderDisplayInfo } from "@/shared/types/providers";
import { ProviderAccountsPanel } from "@/features/providers/ui/ProviderAccountsPanel";
import { MANAGED_ACCOUNT_PROVIDERS } from "@/features/providers/api/providerAccounts";

interface ProvidersSettingsProps {
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
}

export function ProvidersSettings({
  onStartTroubleshootingChat,
}: ProvidersSettingsProps) {
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const queryClient = useQueryClient();

  const rerunAgentStatus = useCallback(() => {
    // Bust the shared `["doctor","report"]` query and re-run the freshness
    // pass, so install/auth state + version badges repopulate everywhere
    // reading the report (this page, Doctor, chat picker).
    void rerunDoctorReport(queryClient);
  }, [queryClient]);

  // Agent install/auth status comes from the shared doctor report (the same
  // `["doctor","report"]` query the Doctor page and chat picker read), so the
  // cards paint from the warmed cache instead of each probing on mount.
  const {
    agentReadiness,
    agentChecks,
    loading: agentStatusLoading,
    statusUnavailable: agentStatusUnavailable,
  } = useAgentProviderStatus();
  // `agentStatusLoading` is `isPending` (first-load only). The shared query's
  // `isFetching` tracks the fast `runDoctor` queryFn (covers manual reruns
  // after `invalidateDoctorReport`), and `freshnessFetching` tracks the slower
  // freshness pass driven through React Query as a sibling key.
  const doctorReportQuery = useDoctorReport();
  const freshnessFetching = useDoctorReportFreshnessFetching();
  const agentStatusRefreshing =
    agentStatusLoading || doctorReportQuery.isFetching || freshnessFetching;

  const agents = useMemo<ProviderDisplayInfo[]>(
    () =>
      catalogEntries.map((entry) => ({
        ...entry,
        status: entry.setupMethod === "none" ? "built_in" : "not_installed",
      })),
    [catalogEntries],
  );

  return (
    <SettingsPage>
      <ProviderAccountsPanel
        providerIds={agents.map((agent) => agent.id)}
        connectedProviders={agents
          .filter((agent) => agentReadiness.get(agent.id) === "ready")
          .map((agent) => agent.id)}
        onRefresh={rerunAgentStatus}
        renderProviderHeader={(providerId) => {
          const provider = agents.find((agent) => agent.id === providerId);
          const managed = MANAGED_ACCOUNT_PROVIDERS.some(
            (id) => id === providerId,
          );
          return provider ? (
            <AgentProviderCard
              provider={{
                ...provider,
                supportsAuth: !managed && provider.supportsAuth,
                supportsLogout: !managed && provider.supportsLogout,
              }}
              readiness={agentReadiness.get(providerId)}
              versionCheck={agentChecks.get(providerId)}
              showVersionDetails={false}
              statusLoading={agentStatusRefreshing}
              statusUnavailable={agentStatusUnavailable}
              onStartTroubleshootingChat={onStartTroubleshootingChat}
            />
          ) : null;
        }}
      />

      {/* Which harness gets the work when one is running low, and which
          models each class of work prefers. Here rather than in a section of
          its own: this page already answers "which harness", and routing is
          the same question asked automatically. */}
      <RoutingPolicySection />
    </SettingsPage>
  );
}
