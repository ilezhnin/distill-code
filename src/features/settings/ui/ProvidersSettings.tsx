import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
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

interface ProvidersSettingsProps {
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
}

export function ProvidersSettings({
  onStartTroubleshootingChat,
}: ProvidersSettingsProps) {
  const { t } = useTranslation(["settings", "common"]);
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
    <SettingsPage title={t("nav.providers")}>
      <section>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h4 className="text-base text-foreground">
              {t("providers.agents.title")}
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("providers.agents.description")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={rerunAgentStatus}
            disabled={agentStatusRefreshing}
            leftIcon={
              agentStatusRefreshing ? (
                <Spinner className="size-3" />
              ) : (
                <RefreshCw className="size-3" />
              )
            }
            className="shrink-0"
          >
            {t("providers.agents.refresh")}
          </Button>
        </div>

        <div>
          {agents.map((agent, index) => (
            <div
              key={agent.id}
              className={index > 0 ? "border-t border-border" : undefined}
            >
              <AgentProviderCard
                provider={agent}
                readiness={agentReadiness.get(agent.id)}
                versionCheck={agentChecks.get(agent.id)}
                statusLoading={agentStatusRefreshing}
                statusUnavailable={agentStatusUnavailable}
                onStartTroubleshootingChat={onStartTroubleshootingChat}
              />
            </div>
          ))}
        </div>
      </section>

      {/* Which harness gets the work when one is running low, and which
          models each class of work prefers. Here rather than in a section of
          its own: this page already answers "which harness", and routing is
          the same question asked automatically. */}
      <RoutingPolicySection />
    </SettingsPage>
  );
}
