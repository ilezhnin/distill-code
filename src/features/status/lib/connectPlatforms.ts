import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import type { AgentPlatformId } from "./rateLimitTypes";
import { TRACKED_AGENT_PLATFORM_IDS } from "./rateLimitTypes";

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
  const entry = CURATED_PROVIDER_CATALOG_BY_ID.get(providerId);
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

export async function connectAllAgentPlatforms(
  readiness: Map<string, AgentProviderReadiness>,
): Promise<void> {
  openProviderAccounts();
  for (const providerId of TRACKED_AGENT_PLATFORM_IDS) {
    const status = readiness.get(providerId);
    if (status === "ready") continue;
    await connectAgentPlatform(providerId, status);
  }
}

export function canConnectPlatform(
  providerId: AgentPlatformId,
  readiness: AgentProviderReadiness | undefined,
): boolean {
  const entry = CURATED_PROVIDER_CATALOG_BY_ID.get(providerId);
  if (!entry) return false;
  return readiness !== "ready";
}
