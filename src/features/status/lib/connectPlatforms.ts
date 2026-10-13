import { getCatalogEntry } from "@/features/providers/providerCatalog";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import type { AgentPlatformId } from "./rateLimitTypes";

export function openProviderAccounts(): void {
  requestOpenSettings("providers");
}

export function openUsageDetails(): void {
  requestOpenSettings("stats");
}

export async function connectAgentPlatform(
  providerId: AgentPlatformId,
  readiness: AgentProviderReadiness | undefined,
): Promise<void> {
  const entry = getCatalogEntry(providerId);
  const startSetup = useAgentSetupStore.getState().startSetup;
  const bundledBridge = entry?.bundledBridge === true;
  const verifyInstall = entry?.setupMethod !== "none";

  openProviderAccounts();

  if (readiness === "not_installed" && entry?.supportsInstall) {
    await startSetup(providerId, "install", {
      installFixType: "command",
      updateFixTypes: [],
      verifyInstall,
      ...(bundledBridge ? { bundledBridge } : {}),
    });
    return;
  }

  if (readiness === "not_ready" && entry?.supportsAuth) {
    await startSetup(providerId, "auth", {
      installFixType: null,
      updateFixTypes: [],
      verifyInstall,
      ...(bundledBridge ? { bundledBridge } : {}),
    });
  }
}
