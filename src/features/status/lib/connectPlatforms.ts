import { getCatalogEntry } from "@/features/providers/providerCatalog";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import type { AgentPlatformId } from "./rateLimitTypes";

export function openProviderAccounts(): void {
  requestOpenSettings("providers");
}

export function openUsageDetails(): void {
  requestOpenSettings("stats");
}

/**
 * The status bar's Sign in: installs a missing harness, or signs the
 * provider's default account in the way its account model does (a browser
 * sign-in of the CLI). An account that needs a key is handled in Settings,
 * which opens either way.
 */
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

  if (readiness === "not_ready") {
    const accounts = useProviderAccountsStore.getState();
    const model = accounts.providersById[providerId];
    const account =
      model?.accounts.find((entry) => entry.id === model.defaultAccountId) ??
      model?.accounts[0];
    if (account && account.enabled && account.authMethod === "oauth") {
      await accounts.authenticate(account.id);
    }
  }
}
